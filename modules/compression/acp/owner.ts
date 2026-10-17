// ACP 压缩 owner（工单 08）：以 CompactOwnerModule 身份接入统一压缩调度器。
//
// 职责（规格「所有者生命周期与失败回退」+ ACP 契约）：
// - session_before_compact 阶段成为压缩所有者：接管自动（threshold/overflow）
//   与手动（manual）两种压缩，一律返回取消——ACP 模式的压缩由自身经 context
//   投影 + compress 工具管理，Pi 原生 summary 不再产生第二套压缩坐标；
// - preflight：宿主缺 buildContextEntries 接缝时 ACP 无法投影。此时若本会话
//   没有任何 ACP 私有状态（规格允许：resolve/preflight 失败且无私态可回
//   native），空结果交回 Pi 原生流程并给 warning 诊断；已有私态则照样取消并
//   报错，不让 native 覆盖；
// - sidecar 明确失败（版本不兼容 / 重建失败）：取消 + error 诊断，明确失败而
//   不是伪装成功，也不静默回 native；
// - 接管/取消诊断按会话内「诊断键」去重（同一情形只提示一次），状态行复用
//   调度器的 COMPRESSION_STATUS_KEY。

import type { ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import type { Translator } from "../../../i18n/index.ts";
import type { CompressionFallbackLedger } from "../fallback.ts";
import { hasActiveCheckpointClaim, hasForeignCheckpointClaim, latestCheckpoint } from "../codex/checkpoint.ts";
import type { CompactHandlerResult, CompactOwnerModule } from "../scheduler.ts";
import { COMPRESSION_STATUS_KEY } from "../scheduler.ts";
import { readAcpSidecarBlockCount } from "./sidecar.ts";
import { acpHostSupported, type AcpCompressionEngine } from "./engine.ts";

export interface AcpOwnerDeps {
  /**
   * Lazy engine 代理（工单 01）：注册期不强制实例化引擎；只有真正需要 ACP 运行态时
   * （压缩接管、状态探测）才解析。模块被关闭或配置已无 ACP 可能性时返回 undefined。
   */
  readonly engine: () => AcpCompressionEngine | undefined;
  readonly t: Translator;
  /** 降级记账接缝（工单 06）：宿主缺投影接缝而回退 Pi 原生时记 fallbackFrom=acp */
  readonly fallback?: CompressionFallbackLedger;
}

export interface AcpOwner {
  /** 调度器注入的 owner 模块（mode: "acp"） */
  readonly owner: CompactOwnerModule;
  /** 会话开始：清诊断去重（mod.ts 的 session_start 调用） */
  beginSession(_ctx: ExtensionContext): void;
}

export function createAcpOwner(deps: AcpOwnerDeps): AcpOwner {
  const { t } = deps;
  let notifiedKeys = new Set<string>();

  function notifyOnce(
    ctx: ExtensionContext,
    key: string,
    level: "info" | "warning" | "error",
    message: string,
  ): void {
    if (notifiedKeys.has(key)) return;
    notifiedKeys.add(key);
    if (ctx.hasUI) ctx.ui.notify(message, level);
  }

  async function handleBeforeCompact(
    event: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
  ): Promise<CompactHandlerResult> {
    const reason = t(`module.compression.reason.${event.reason}`);
    const engine = deps.engine();
    if (!engine) {
      // 策略已解析到 ACP 却拿不到引擎（模块刚被关闭等边界）：保守取消，
      // 不让 Pi 原生 summary 抹掉可能存在的私有状态（关闭态的完整保护矩阵
      // 在 scheduler.ts 的 handleDisabledCompaction）
      notifyOnce(ctx, `engine-missing|${event.reason}`, "error", t("module.compression.acp.toolUnavailable"));
      return { cancel: true };
    }

    // preflight：宿主接缝不具备。「无私态」的判定看已提交的压缩块（工单 12 修正）：
    // session_start 的 beginSession 会为全新会话建空的初始状态槽（0 块、零提交），
    // 那不是规格意义上的私有状态——允许回退 native（规格：resolve/preflight
    // 失败且无私态可回退）。内存无块也可能是日志不可读触发的 mismatch 重建，
    // 再探磁盘 sidecar：盘上有已提交块同样取消并保留，不让 native 覆盖坐标
    if (!acpHostSupported(ctx)) {
      const state = engine.currentState(ctx);
      let hasCommittedState = state !== undefined && state.blocks.length > 0;
      if (!hasCommittedState) {
        const sessionManager = ctx.sessionManager as { getSessionFile?: () => string | undefined };
        const sessionFile =
          typeof sessionManager.getSessionFile === "function" ? sessionManager.getSessionFile() : undefined;
        const diskBlocks = await readAcpSidecarBlockCount(sessionFile);
        hasCommittedState = diskBlocks !== undefined && diskBlocks > 0;
      }
      if (!hasCommittedState) {
        notifyOnce(
          ctx,
          `host-unsupported|${event.reason}`,
          "warning",
          t("module.compression.acp.hostUnsupported", { reason }),
        );
        if (ctx.hasUI) ctx.ui.setStatus(COMPRESSION_STATUS_KEY, undefined);
        // 工单 06：本次确实回退到了 Pi 原生（没有 ACP 私态），记降级给状态栏：
        // 策略说 acp、实际在跑 native，用户应该看得到这个差距
        deps.fallback?.record({ from: "acp", reason: "host-unsupported" });
        return {};
      }
      // 有已提交私态但宿主接缝缺失：取消并保留原状态（不让 native 覆盖坐标）
      notifyOnce(
        ctx,
        `host-unsupported-state|${event.reason}`,
        "error",
        t("module.compression.acp.hostUnsupportedWithState", { reason }),
      );
      return { cancel: true };
    }

    // 确保状态装载（beginSession 已在 session_start 做过；这里兜底幂等）
    await engine.beginSession(ctx);

    const state = engine.currentState(ctx);
    if (!state) {
      // sidecar 明确失败（newer-schema / 重建失败）：取消 + error，明确失败
      notifyOnce(
        ctx,
        `state-failed|${event.reason}`,
        "error",
        t("module.compression.acp.compactUnavailable", { reason }),
      );
      return { cancel: true };
    }

    // 正常接管：ACP 管理压缩（context 投影 + compress 工具），取消 Pi 原生。
    // 手动 /compact 同样取消（规格固定：ACP 接管自动或手动压缩时返回取消），
    // 诊断告知压缩改由 ACP 管理
    notifyOnce(
      ctx,
      `takeover|${event.reason}`,
      "info",
      t("module.compression.acp.takeover", { reason }),
    );
    // 跨模式切换保护（工单 11）：会话携带 Codex checkpoint 声明（模型从 codex
    // 白名单切到 ACP 命中的模型）——ACP 模式下 opaque 历史不会被回放，声明只以
    // 明文 fallback 文本出现在视图里。不静默：一次性诊断说明去向与新会话选项
    if (hasActiveCheckpointClaim(event.branchEntries)) {
      const checkpoint = latestCheckpoint(event.branchEntries);
      notifyOnce(
        ctx,
        "foreign-codex-claim",
        "warning",
        t("module.compression.acp.foreignClaim", {
          identity: checkpoint
            ? `${checkpoint.details.provider}/${checkpoint.details.modelId}`
            : t("module.compression.acp.foreignClaimUnparsed"),
        }),
      );
    } else if (hasForeignCheckpointClaim(event.branchEntries)) {
      // 外部压缩扩展（pi-codex-compact）的声明（工单 12 检测与诊断级）：ACP 同样
      // 不回放它的 opaque 历史；告知外部扩展迁移路径，真停用归工单 14
      notifyOnce(ctx, "foreign-extension-claim", "warning", t("module.compression.acp.foreignExtensionClaim"));
    }
    if (ctx.hasUI) {
      ctx.ui.setStatus(COMPRESSION_STATUS_KEY, t("module.compression.acp.status"));
    }
    return { cancel: true };
  }

  return {
    owner: {
      mode: "acp",
      handleBeforeCompact,
    },
    beginSession(_ctx: ExtensionContext): void {
      // 新会话：接管/取消诊断重新提示（session_start 流程见 mod.ts）
      notifiedKeys = new Set();
    },
  };
}
