// 压缩状态服务（工单 04）：`compression.status` 只读句柄的实现与状态标签格式化。
//
// 快照是派生结果（除 revision 与工单 06 的降级记录外不单独记账）：
// - 总开关关闭 → disabled；没有会话模型 → unavailable；其余按策略解析器（与菜单
//   诊断、调度器同一口径）得到 active 的 effectiveMode / triggerPolicy / source；
// - 降级记录（工单 06 写入）存在 → fallback，effectiveMode 取降级后真正在工作的
//   Pi 原生，并带上降级来源与原因；
// - revision 在读快照时按内容比较维护（工单 18 的句柄惯例：内容变化才递增，读快照
//   本身不制造变更）。因此装配层不必显式写快照：model_select / session_start 只把
//   新模型交给派生口，配置事务落盘后内存副本已刷新，下一次读（tui 心跳或渲染）就
//   得到新内容与新序号。
//
// 本文件不注册事件、不持有会话：事件接线与读口全部由装配（mod.ts）注入。

import type {
  CompressionSettings,
  CompressionStatusService,
  CompressionStatusSnapshot,
  ModelIdentity,
  SessionCompressionOverride,
} from "./api.ts";
import { resolveCompressionStrategy } from "./strategy.ts";

/** 降级记录（工单 06 写入）：降级来源模式 + 机读原因 */
export interface CompressionFallbackRecord {
  readonly from: "codex" | "acp";
  readonly reason: string;
}

/** 状态服务的读口：本文件不读宿主、不读磁盘，派生结果只取决于这三个读口 */
export interface CompressionStatusServiceOptions {
  /** 模块总开关（实时读配置） */
  readonly isEnabled: () => boolean;
  /** 已解析的压缩配置节（配置事务落盘后内存副本已跟上磁盘） */
  readonly readSettings: () => CompressionSettings;
  /** 当前会话模型身份；没有会话模型时 undefined（unavailable） */
  readonly readModel: () => ModelIdentity | undefined;
  /** 当前会话覆盖读口（工单 05；未注入 = 永不覆盖，完全按配置解析） */
  readonly readSessionOverride?: () => SessionCompressionOverride | undefined;
  /** 降级记录读口（工单 06 注入；未注入 = 永不降级） */
  readonly readFallback?: () => CompressionFallbackRecord | undefined;
  /** 降级清除写口（工单 06 的状态中枢；未注入 = 没有可清的降级） */
  readonly clearFallback?: () => void;
}

/** 装配侧句柄：只读面之外多一条压缩事件记账（tui 只拿 CompressionStatusService） */
export interface CompressionStatusRuntime extends CompressionStatusService {
  /**
   * 压缩成功事件记账（mod.ts 的 session_compact 接缝）：Pi 原生压缩成功清降级；
   * `fromExtension` 的扩展压缩是 Codex/ACP owner 自己提交的结果，不改 native 状态。
   */
  noteCompaction(event: { readonly fromExtension: boolean }): void;
}

/** 快照去掉 revision 的派生部分（字段固定的字面量对象，可直接做内容签名） */
type CompressionStatusContent = Omit<CompressionStatusSnapshot, "revision">;

/** 降级标记（规格示例 `(native:auto [fallback])`） */
const FALLBACK_MARKER = " [fallback]";

/**
 * 状态标签（规格「状态标签格式化输出」）：disabled / unavailable 不显示；
 * active 显示生效模式；fallback 显示降级后真实生效的模式并带 `[fallback]` 标记。
 * compact = 极窄终端的单字符形态 `(N:A)` / `(N:M)` / `(A)` / `(C)`。
 */
export function formatCompressionStatusLabel(
  snapshot: CompressionStatusSnapshot,
  compact = false,
): string {
  if (snapshot.status === "disabled" || snapshot.status === "unavailable") return "";
  const marker = snapshot.status === "fallback" ? FALLBACK_MARKER : "";
  switch (snapshot.effectiveMode) {
    case "native": {
      // 触发策略只在 native 模式有意义：解析器对 native 一定给出取值，缺失按 auto
      const manual = snapshot.triggerPolicy === "manual";
      const mode = compact ? `N:${manual ? "M" : "A"}` : `native:${manual ? "manual" : "auto"}`;
      return `(${mode}${marker})`;
    }
    case "acp":
      return compact ? `(A${marker})` : `(acp${marker})`;
    case "codex":
      return compact ? `(C${marker})` : `(codex${marker})`;
    case "none":
      // 没有真实生效的模式（disabled / unavailable 之外的防御分支）：不显示标签
      return "";
  }
}

/** 派生快照内容：总开关 → 会话模型 → 策略解析 → 降级覆盖 */
function deriveContent(options: CompressionStatusServiceOptions): CompressionStatusContent {
  if (!options.isEnabled()) return { status: "disabled", effectiveMode: "none" };
  const model = options.readModel();
  if (model === undefined) return { status: "unavailable", effectiveMode: "none" };
  const settings = options.readSettings();
  const resolution = resolveCompressionStrategy(model, settings, options.readSessionOverride?.());
  const fallback = options.readFallback?.();
  if (fallback !== undefined) {
    return {
      status: "fallback",
      // 降级后真正在工作的模式是 Pi 原生（codex / acp 的 onUnsupported 回退目标）
      effectiveMode: "native",
      fallbackFrom: fallback.from,
      fallbackReason: fallback.reason,
      triggerPolicy: settings.nativeTrigger,
      source: resolution.source,
    };
  }
  return {
    status: "active",
    effectiveMode: resolution.mode,
    triggerPolicy: resolution.triggerPolicy,
    source: resolution.source,
  };
}

/** 压缩状态服务（模块级单例）：装配时创建，随模块装配存活整个进程 */
export function createCompressionStatusService(
  options: CompressionStatusServiceOptions,
): CompressionStatusRuntime {
  let revision = 0;
  let signature = JSON.stringify(deriveContent(options));

  const snapshot = (): CompressionStatusSnapshot => {
    const content = deriveContent(options);
    const nextSignature = JSON.stringify(content);
    if (nextSignature !== signature) {
      signature = nextSignature;
      revision += 1;
    }
    return { ...content, revision };
  };

  const service: CompressionStatusRuntime = {
    id: "compression",
    snapshot,
    label: (compact = false) => formatCompressionStatusLabel(snapshot(), compact),
    clearFallback: () => {
      // 幂等（规格「统一的 Fallback 清除总线接缝」）：已处于非降级态时是空操作，
      // 不递增 revision——三路成功接缝可以放心重复调用。
      if (options.readFallback?.() === undefined) return;
      options.clearFallback?.();
    },
    noteCompaction: (event) => {
      // 扩展压缩（Codex / ACP owner 自己提交的压缩条目）不改 native 状态
      if (event.fromExtension) return;
      service.clearFallback();
    },
  };
  return service;
}
