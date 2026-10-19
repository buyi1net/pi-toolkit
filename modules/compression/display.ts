// 展示 owner 仲裁与扩展消息接缝（工单 08）：把「压缩执行权」和「压缩展示权」
// 作为同一份 owner 状态管理的展示半。
//
// 职责（规格「实现决策」+ 工单 08 验收项）：
// - 展示 owner 仲裁（decideDisplayOwner）：与压缩 owner 用同一套五级优先级
//   （会话覆盖 → 显式规则 → 自动检测 → 全局默认），由策略解析结果直接推出——
//   native 解析 = native 展示，codex / acp 解析 = 扩展展示。同一个压缩生命周期
//   只选一套展示（互斥），由展示呈现的 owner 绑定保证。
// - 扩展消息接缝：扩展压缩状态用不进入模型上下文的 custom 条目承载（宿主
//   appendCustomEntry 的 plain custom 条目被 sessionEntryToContextMessages
//   忽略，实测不进模型上下文）。宿主 session 条目只追加、不原地修改：状态
//   更新通过追加新条目完成。custom_message（会进模型上下文）不作为纯 UI 状态载体。
// - 渲染器只显示同一展示 owner 的最新条目：宿主对每个带渲染器的 custom 条目
//   都会调用渲染器，所以渲染器按「可见条目 id」过滤——只有最新追加的展示条目
//   被渲染，旧条目保留在会话里用于恢复与审计（不重放）。
// - 展示状态机（createDisplayController）：进行中 / 成功 / 失败 / 受保护 /
//   过期五种压缩生命周期状态 + 恢复中 / 恢复成功 / 恢复失败三种恢复生命周期
//   状态（工单 11 ACP sidecar 重建），owner 绑定（旧 owner 不能覆盖新 owner 的
//   状态），恢复时把陈旧的进行中 / 恢复中条目解释为过期（不重放「正在压缩」）。
//
// 宿主能力边界（Pi 1.3.0 发行件核实，见模块头注与测试）：宿主没有把
// compaction_start / compaction_end 暴露成扩展事件——宿主的原生压缩进度
// 指示与 `[compaction] Compacted from ... tokens` 结果摘要在宿主内部渲染，
// 扩展侧没有任何现有接缝能在原生进度出现前仲裁并屏蔽它。因此本单的展示仲裁
// 落在 custom 条目接缝上：扩展 owner 的可见反馈由扩展消息承担，宿主的原生
// 进度 / 结果屏蔽是宿主能力边界（resolveDisplaySeam 记录），不是本模块能
// 单方面补上的能力。版本锁定只固定兼容基线，不替代屏蔽能力。

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import type { Translator } from "../../i18n/index.ts";
import type { CompressionMode } from "./api.ts";
import type { CompressionStrategyResolution } from "./strategy.ts";

/** 展示 owner：native 展示（Pi 原生进度与结果）或扩展展示（扩展消息区域） */
export type CompressionDisplayOwner = "native" | "extension";

/** 扩展压缩消息状态（工单 08 验收：进行中 / 成功 / 失败 / 受保护 / 过期；
 *  工单 11 ACP 补齐恢复生命周期：恢复中 / 恢复成功 / 恢复失败） */
export type CompressionDisplayState =
  | "in-progress"
  | "succeeded"
  | "failed"
  | "protected"
  | "expired"
  /** 中性的生命周期收束（owner 回退 native / 取消且无专属诊断）：把进行中消息收掉，不声明成功或失败 */
  | "concluded"
  /** 恢复中（工单 11 ACP）：sidecar 丢失 / 损坏 / 不一致后按会话日志重建开始 */
  | "recovering"
  /** 恢复成功（工单 11 ACP）：重建出块并回写 sidecar，继续工作 */
  | "recovery-succeeded"
  /** 恢复失败（工单 11 ACP）：sidecar 版本不兼容或重建不出（需用户处理） */
  | "recovery-failed";

/** custom 条目的 customType（渲染器与恢复探测共用） */
export const COMPRESSION_DISPLAY_ENTRY_TYPE = "pi-toolkit.compression.display";

/** 展示状态数据载体（落进 custom 条目，不进模型上下文；只追加不原地改） */
export interface CompressionDisplayEntryData {
  readonly owner: CompressionDisplayOwner;
  readonly mode: CompressionMode;
  readonly state: CompressionDisplayState;
  /** 失败 / 受保护时的机读原因（进行中等无原因时缺席） */
  readonly reason?: string;
  /** 状态写入时刻（epoch ms；恢复与审计用） */
  readonly at: number;
}

/** 展示接缝选择记录（工单 08 验收：宿主版本或展示接缝选择有可核对记录） */
export interface DisplaySeamChoice {
  /** 宿主能否在扩展侧屏蔽原生压缩进度 / 结果摘要 */
  readonly nativeMasking: "available" | "unavailable";
  /** 本模块承载扩展展示状态的接缝 */
  readonly seam: "extension-custom-entry";
}

/**
 * 展示 owner 仲裁（纯函数）：与压缩 owner 同一套优先级，由解析结果直接推出。
 * 无解析结果（无会话模型）按 native 处理（宿主原生行为不变）。
 */
export function decideDisplayOwner(
  resolution: CompressionStrategyResolution | undefined,
): CompressionDisplayOwner {
  if (resolution === undefined) return "native";
  return resolution.mode === "native" ? "native" : "extension";
}

/** 判断一个 session 条目是否是本模块的展示条目（plain custom + 本 customType） */
export function isDisplayEntry(entry: SessionEntry): entry is SessionEntry & {
  type: "custom";
  customType: string;
  data?: CompressionDisplayEntryData;
} {
  return entry.type === "custom" && entry.customType === COMPRESSION_DISPLAY_ENTRY_TYPE;
}

/**
 * 同一展示 owner 的最新条目（append-only：最新者胜）。
 * 旧条目保留在会话里用于恢复与审计，这里只取最新一条作为当前状态。
 */
export function latestDisplayEntry(
  entries: readonly SessionEntry[],
  owner: CompressionDisplayOwner,
): CompressionDisplayEntryData | undefined {
  let latest: CompressionDisplayEntryData | undefined;
  for (const entry of entries) {
    if (!isDisplayEntry(entry)) continue;
    const data = entry.data;
    if (data && data.owner === owner) latest = data;
  }
  return latest;
}

/** 展示接缝选择（兼容边界记录）：宿主无 compaction 扩展事件，原生屏蔽不可用 */
export function resolveDisplaySeam(): DisplaySeamChoice {
  // Pi 1.3.0 宿主未把 compaction_start / compaction_end 暴露成扩展事件，
  // 原生进度指示与结果摘要在宿主内部渲染，扩展侧无法屏蔽——记录为 unavailable
  return { nativeMasking: "unavailable", seam: "extension-custom-entry" };
}

/**
 * 展示状态机（纯逻辑，不碰宿主）：返回要追加的条目数据（undefined = 无变化 /
 * native owner / 被 owner 绑定拒绝）。owner 绑定按压缩模式（codex / acp）：进行
 * 中的状态只允许同一压缩模式的 owner 收束 / 失败 / 保护；start 开启新生命周期并
 * 顶替另一压缩模式的未收束状态（旧 owner 不能覆盖新 owner）。恢复生命周期
 * （工单 11 ACP sidecar 重建）与压缩生命周期同构：beginRecovery 开启并顶替，
 * 恢复收束只认同一压缩模式下处于恢复中的状态。
 */
export interface DisplayController {
  /** 当前展示状态（内存镜像；渲染与恢复以 session 条目为准） */
  readonly current: CompressionDisplayEntryData | undefined;
  /**
   * 恢复（新会话 / 重启）：从 session 条目重建当前状态。陈旧的进行中 / 恢复中
   * 条目解释为过期（追加一条过期条目收束，不重放「正在压缩」/「正在恢复」）；
   * 已收束的状态只读取不追加。返回要追加的条目数据（需要时），或 undefined
   * （无需追加）。
   */
  restore(entries: readonly SessionEntry[]): CompressionDisplayEntryData | undefined;
  /** 开始一个压缩生命周期的展示（extension owner 才产生条目；native 无条目 = 互斥） */
  start(owner: CompressionDisplayOwner, mode: CompressionMode): CompressionDisplayEntryData | undefined;
  /** 成功收束（只允许当前压缩模式） */
  succeed(mode: CompressionMode): CompressionDisplayEntryData | undefined;
  /** 失败（当前无活跃生命周期时也可直接追加失败条目；活跃时只认当前压缩模式） */
  fail(mode: CompressionMode, reason: string): CompressionDisplayEntryData | undefined;
  /** 受保护取消（当前无活跃生命周期时也可直接追加保护条目；活跃时只认当前压缩模式） */
  protect(mode: CompressionMode, reason: string): CompressionDisplayEntryData | undefined;
  /** 中性收束（只允许当前压缩模式）：owner 回退 native / 取消且无专属诊断时把进行中消息收掉 */
  conclude(mode: CompressionMode): CompressionDisplayEntryData | undefined;
  /** 开始恢复生命周期（工单 11 ACP sidecar 重建）：顶替当前状态，产出恢复中条目 */
  beginRecovery(mode: CompressionMode): CompressionDisplayEntryData | undefined;
  /** 恢复成功（只允许当前压缩模式且处于恢复中） */
  recoverSucceed(mode: CompressionMode): CompressionDisplayEntryData | undefined;
  /** 恢复失败（只允许当前压缩模式且处于恢复中） */
  recoverFail(mode: CompressionMode, reason: string): CompressionDisplayEntryData | undefined;
}

export function createDisplayController(): DisplayController {
  let current: CompressionDisplayEntryData | undefined;

  function commit(entry: CompressionDisplayEntryData): CompressionDisplayEntryData {
    current = entry;
    return entry;
  }

  function fromCurrentMode(mode: CompressionMode): boolean {
    return current !== undefined && current.mode === mode;
  }

  /** owner 绑定按压缩模式：活跃生命周期只允许同一压缩模式收束；没有活跃状态时，
   * 前置失败可直接追加失败/保护条目，但不能覆盖另一个 owner 的进行中/恢复中状态。 */
  function terminalEntry(
    mode: CompressionMode,
    state: "failed" | "protected",
    reason: string,
  ): CompressionDisplayEntryData | undefined {
    if (current?.state === "in-progress" && current.mode === mode) {
      return commit({ ...current, state, reason, at: Date.now() });
    }
    if (current?.state === "in-progress" || current?.state === "recovering") return undefined;
    if (current?.mode === mode) return undefined;
    return commit({ owner: "extension", mode, state, reason, at: Date.now() });
  }

  const controller: DisplayController = {
    get current(): CompressionDisplayEntryData | undefined {
      return current;
    },
    restore(entries): CompressionDisplayEntryData | undefined {
      // 取会话里最新的展示条目（任意 owner）：恢复时以最新为准
      let latest: CompressionDisplayEntryData | undefined;
      for (const entry of entries) {
        if (isDisplayEntry(entry) && entry.data) latest = entry.data;
      }
      current = latest;
      if (latest && (latest.state === "in-progress" || latest.state === "recovering")) {
        // 陈旧的进行中 / 恢复中（上个生命周期没走完）：解释为过期，追加一条收束
        return commit({
          owner: latest.owner,
          mode: latest.mode,
          state: "expired",
          at: Date.now(),
        });
      }
      return undefined;
    },
    start(owner, mode): CompressionDisplayEntryData | undefined {
      // native owner：不产生扩展条目（互斥——native 展示走 Pi 原生进度 / 结果）
      if (owner === "native") return undefined;
      return commit({ owner, mode, state: "in-progress", at: Date.now() });
    },
    succeed(mode): CompressionDisplayEntryData | undefined {
      if (!fromCurrentMode(mode) || current?.state !== "in-progress") return undefined;
      return commit({ ...current, state: "succeeded", at: Date.now() });
    },
    fail(mode, reason): CompressionDisplayEntryData | undefined {
      return terminalEntry(mode, "failed", reason);
    },
    protect(mode, reason): CompressionDisplayEntryData | undefined {
      return terminalEntry(mode, "protected", reason);
    },
    conclude(mode): CompressionDisplayEntryData | undefined {
      if (!fromCurrentMode(mode) || current?.state !== "in-progress") return undefined;
      return commit({ ...current, state: "concluded", at: Date.now() });
    },
    beginRecovery(mode): CompressionDisplayEntryData | undefined {
      // 恢复生命周期开启即顶替（与 start 同构）：重建只发生在会话边界 / 接管前的
      // 状态装载，不会打断进行中的压缩生命周期
      return commit({ owner: "extension", mode, state: "recovering", at: Date.now() });
    },
    recoverSucceed(mode): CompressionDisplayEntryData | undefined {
      if (!fromCurrentMode(mode) || current?.state !== "recovering") return undefined;
      return commit({ ...current, state: "recovery-succeeded", at: Date.now() });
    },
    recoverFail(mode, reason): CompressionDisplayEntryData | undefined {
      if (!fromCurrentMode(mode) || current?.state !== "recovering") return undefined;
      return commit({ ...current, state: "recovery-failed", reason, at: Date.now() });
    },
  };
  return controller;
}

/** 展示条目的用户可见文案（渲染器消费；三语键见 messages/index.ts） */
export function displayEntryLabel(
  data: CompressionDisplayEntryData,
  t: Translator,
): string {
  const modeLabel = t(`module.compression.mode.${data.mode}`);
  switch (data.state) {
    case "in-progress":
      return t("module.compression.display.inProgress", { mode: modeLabel });
    case "succeeded":
      return t("module.compression.display.succeeded", { mode: modeLabel });
    case "failed":
      return t("module.compression.display.failed", { mode: modeLabel, reason: data.reason ?? "" });
    case "protected":
      return t("module.compression.display.protected", { mode: modeLabel, reason: data.reason ?? "" });
    case "expired":
      return t("module.compression.display.expired", { mode: modeLabel });
    case "concluded":
      return t("module.compression.display.concluded", { mode: modeLabel });
    case "recovering":
      return t("module.compression.display.recovering", { mode: modeLabel });
    case "recovery-succeeded":
      return t("module.compression.display.recoverySucceeded", { mode: modeLabel });
    case "recovery-failed":
      return t("module.compression.display.recoveryFailed", { mode: modeLabel, reason: data.reason ?? "" });
  }
}

/**
 * 展示上报接缝（owner 消费的小接口）：owner 在压缩生命周期的各阶段报告展示状态，
 * 实现由装配（mod.ts）提供——把状态推进经 controller 转成条目数据，经宿主
 * appendCustomEntry 追加为不进模型上下文的 custom 条目，并登记为可见条目。
 * 未注入 = 无展示（独立装载 / 测试不需要 UI）。
 */
export interface CompressionDisplayReporter {
  /** 开始压缩生命周期（extension owner）：进行中消息出现在对话编辑框上方 */
  begin(mode: CompressionMode): void;
  /** 成功收束（只允许当前压缩模式）：进行中消息自然收束，不留 Pi 原生结果摘要 */
  succeed(mode: CompressionMode): void;
  /** 失败（只允许当前压缩模式）：需要用户理解的扩展消息 */
  fail(mode: CompressionMode, reason: string): void;
  /** 受保护取消（只允许当前压缩模式）：checkpoint / 私态保留 */
  protect(mode: CompressionMode, reason: string): void;
  /** 中性收束（只允许当前压缩模式）：owner 回退 native / 取消且无专属诊断时把进行中消息收掉 */
  conclude(mode: CompressionMode): void;
  /** 开始恢复生命周期（工单 11 ACP sidecar 重建）：恢复中消息 */
  recovering(mode: CompressionMode): void;
  /** 恢复成功（只允许当前压缩模式）：重建完成，继续工作 */
  recoverSucceed(mode: CompressionMode): void;
  /** 恢复失败（只允许当前压缩模式）：需要用户处理的恢复失败消息 */
  recoverFail(mode: CompressionMode, reason: string): void;
}

/**
 * 展示呈现（渲染器 + 可见条目过滤）：宿主对每个带渲染器的 custom 条目都会调渲染器，
 * 所以按「可见条目 id」过滤——只有最新追加的展示条目被渲染，旧条目保留用于恢复
 * 与审计（不重放）。native owner 从不追加条目，故无任何扩展展示（互斥）。
 */
export interface DisplayPresentation {
  readonly controller: DisplayController;
  /** 追加展示条目后登记其条目 id（mod.ts 调宿主 appendCustomEntry 得到 id） */
  markVisibleEntry(entryId: string): void;
  /** 登记渲染器（mod.ts 装配期调用一次；只渲染可见条目） */
  registerRenderer(
    pi: {
      registerEntryRenderer?: <T>(
        customType: string,
        renderer: (entry: { type: string; customType: string; data?: T; id?: string }, options: { expanded: boolean }, theme: unknown) => Component | undefined,
      ) => void;
    },
    t: Translator,
  ): void;
}

export function createDisplayPresentation(): DisplayPresentation {
  let visibleEntryId: string | undefined;
  const controller = createDisplayController();

  return {
    controller,
    markVisibleEntry(entryId): void {
      visibleEntryId = entryId;
    },
    registerRenderer(pi, t): void {
      pi.registerEntryRenderer?.<CompressionDisplayEntryData>(
        COMPRESSION_DISPLAY_ENTRY_TYPE,
        (entry) => {
          // 只显示可见条目（最新追加的展示条目）；旧条目保留但不渲染
          if (entry.id !== undefined && entry.id !== visibleEntryId) return undefined;
          const data = entry.data;
          if (!data || !data.owner || !data.mode || !data.state) return undefined;
          const label = displayEntryLabel(data, t);
          if (!label) return undefined;
          return new Text(label, 1, 0);
        },
      );
    },
  };
}

/**
 * 装配侧建展示上报接缝（mod.ts 调用）：把 owner 的状态推进转成宿主 custom 条目。
 * appendEntry 由宿主接缝提供（ctx.sessionManager.appendCustomEntry），返回条目 id；
 * 条目不进模型上下文（plain custom 被 sessionEntryToContextMessages 忽略）。
 */
export function createDisplayReporter(
  presentation: DisplayPresentation,
  appendEntry: (data: CompressionDisplayEntryData) => string | undefined,
): CompressionDisplayReporter {
  const controller = presentation.controller;
  function apply(data: CompressionDisplayEntryData | undefined): void {
    if (data === undefined) return;
    const id = appendEntry(data);
    if (id !== undefined) presentation.markVisibleEntry(id);
  }
  return {
    begin(mode): void {
      apply(controller.start("extension", mode));
    },
    succeed(mode): void {
      apply(controller.succeed(mode));
    },
    fail(mode, reason): void {
      apply(controller.fail(mode, reason));
    },
    protect(mode, reason): void {
      apply(controller.protect(mode, reason));
    },
    conclude(mode): void {
      apply(controller.conclude(mode));
    },
    recovering(mode): void {
      apply(controller.beginRecovery(mode));
    },
    recoverSucceed(mode): void {
      apply(controller.recoverSucceed(mode));
    },
    recoverFail(mode, reason): void {
      apply(controller.recoverFail(mode, reason));
    },
  };
}
