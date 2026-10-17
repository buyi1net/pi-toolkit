// 统一压缩调度器（工单 03 + 工单 11 生命周期与切换保护）：模块内唯一的压缩
// owner 入口。
//
// 职责（规格「压缩所有权与现有接缝」「所有者生命周期与失败回退」）：
// - 每次压缩准备开始（session_before_compact）时，用当前会话模型身份 + 配置节
//   经 resolveCompressionStrategy 解析策略，按解析结果决定单一 owner 与事件行为；
//   resume / fork / 宿主重载都以 session_start 到达：beginSession 用当前模型重新
//   解析一次并给 noteworthy 解析一行诊断；会话内解析结果变化（模型切换/配置
//   实时变更）在事件边界检测并一次性提示（工单 11）；
// - native 是内建实现：auto 触发策略下 manual / threshold / overflow 三种
//   reason 全部空结果交回 Pi；manual 触发策略下 manual 交回 Pi、threshold 与
//   overflow 返回取消（取消后不写入任何 summary，诊断告知需手动 /compact 或新建
//   会话，不是故障）；
// - codex / acp owner（工单 04/08）注入后接管对应模式；
// - 跨模式切换保护（工单 11）：native 放行前检查分支上的 Codex checkpoint 声明
//   与 ACP sidecar 活动状态（探测口注入，磁盘兜底），发现外来私有状态时取消本次
//   压缩并保留原历史，不静默重放不兼容状态；codex 接管前同样检查活动 ACP
//   sidecar，不启动第二套压缩坐标覆盖已提交状态；
// - handler 全程兜异常：任何内部错误不得击穿宿主，交回 Pi 原生流程并进诊断；
// - native 模式不注册 context / context_with_system / before_provider_request，
//   不产生任何第三方上下文修改（codex / acp owner 接入后才按 owner 协调注册）。
//
// Pi 1.3.0 事件契约（dist/core/extensions/types.d.ts + runner.js emit + agent-session.js
// compact()/_runAutoCompaction 实测）：reason 只有 manual / threshold / overflow 三个
// 公开值；handler 返回 { cancel?: true } 取消本次压缩（自动路径宿主发 aborted 的
// compaction_end / session_compact_failed，不写 summary），返回 { compaction } 提供
// 自定义压缩结果，未取消且未提供结果（空结果）时由 Pi 继续 native 流程。

import type {
  CompactionResult,
  ExtensionContext,
  SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import type { Translator } from "../../i18n/index.ts";
import type { ModuleConfigRecord } from "../../kit/module.ts";
import type { CompressionMode, NativeTriggerPolicy } from "./api.ts";
import { readCompressionSettings } from "./config.ts";
import {
  foreignCheckpointIdentity,
  hasActiveCheckpointClaim,
  hasForeignCheckpointClaim,
  latestCheckpoint,
} from "./codex/checkpoint.ts";
import {
  compressionModeLabel,
  compressionSourceLabel,
  formatResolutionDiagnosis,
} from "./messages/index.ts";
import { modelIdentityFromModel } from "./rules-editor.ts";
import { resolveCompressionStrategy, type CompressionStrategyResolution } from "./strategy.ts";

/**
 * 调度器返回给 Pi 的结果：与 Pi 的 SessionBeforeCompactResult 结构一致
 * （cancel 取消本次压缩；compaction 提供自定义压缩结果；两者都缺席 = 空结果，
 * 未取消且未提供结果时由 Pi 继续 native 流程）。
 */
export interface CompactHandlerResult {
  readonly cancel?: boolean;
  readonly compaction?: CompactionResult;
}

/** reason 的三个公开值（Pi 1.3.0 实测；只按这三个值决策，不引入其它取值） */
export type CompactEventReason = "manual" | "threshold" | "overflow";

/** 事件处置：pass-through = 空结果交回 Pi；cancel = 取消本次压缩 */
export type CompactEventOutcome = "pass-through" | "cancel";

/**
 * owner 就绪状态：
 * - implemented：该模式有实现单元（当前仅 native 内建；codex/acp 归工单 04/08）；
 * - unimplemented：策略解析出该模式但没有实现单元，不接管、交回 Pi 原生流程；
 * - unresolved：连模型身份都拿不到（无会话模型），同样不接管。
 */
export type CompactOwnerStatus = "implemented" | "unimplemented" | "unresolved";

/** 单一 owner 判定的产出（纯数据，可序列化，供调度与诊断消费） */
export interface CompactSchedulingDecision {
  /** 解析出的 owner 模式（unresolved 时回 native） */
  readonly ownerMode: CompressionMode;
  /** owner 就绪状态 */
  readonly ownerStatus: CompactOwnerStatus;
  /** 事件处置 */
  readonly outcome: CompactEventOutcome;
  /** 生效触发策略（ownerMode=native 时携带；codex/acp 固定 auto） */
  readonly triggerPolicy?: NativeTriggerPolicy;
  /** 取消的机读原因（outcome=cancel 时携带） */
  readonly cancelledBecause?: "manual-policy";
}

/**
 * 压缩 owner 实现单元（工单 04 codex / 工单 08 acp 的接入点）：
 * 实现该接口并经 createCompressionScheduler 的 owners 注入即可接管对应模式的
 * session_before_compact——返回 { compaction } 提供压缩结果、{ cancel: true } 取消、
 * 空结果交回 Pi。native 由调度器内建，不可覆盖。owner 抛出的异常由调度器统一兜住
 * （交回 Pi 原生流程并进诊断），不会击穿宿主。
 */
export interface CompactOwnerModule {
  /** 接管的模式（native 会被拒绝，保持内建行为） */
  readonly mode: CompressionMode;
  handleBeforeCompact(
    event: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
    resolution: CompressionStrategyResolution,
  ): Promise<CompactHandlerResult | void> | CompactHandlerResult | void;
}

/** native owner 恒为内建实现（判定用，不进注入表） */
const BUILTIN_OWNER_MODES: readonly CompressionMode[] = ["native"];

/**
 * 单一 owner 判定 + 事件处置决策（纯函数，测试与调度器共用）：
 * - 无解析结果（无会话模型）→ native / unresolved / pass-through；
 * - codex / acp 且无对应 owner 实现单元 → unimplemented / pass-through；
 * - native + auto 触发策略 → 三种 reason 全部 pass-through（保留 Pi 原生阈值、
 *   溢出恢复与手动 /compact）；
 * - native + manual 触发策略 → manual 事件 pass-through（继续 Pi 原生压缩），
 *   threshold / overflow 事件 cancel（自动压缩按策略取消）。
 */
export function decideCompactHandling(
  resolution: CompressionStrategyResolution | undefined,
  reason: CompactEventReason,
  owners: ReadonlyMap<CompressionMode, CompactOwnerModule> = new Map(),
): CompactSchedulingDecision {
  if (resolution === undefined) {
    return { ownerMode: "native", ownerStatus: "unresolved", outcome: "pass-through" };
  }
  const implemented =
    BUILTIN_OWNER_MODES.includes(resolution.mode) || owners.has(resolution.mode);
  if (!implemented) {
    return { ownerMode: resolution.mode, ownerStatus: "unimplemented", outcome: "pass-through" };
  }
  if (resolution.mode === "native") {
    if (resolution.triggerPolicy === "manual" && reason !== "manual") {
      return {
        ownerMode: "native",
        ownerStatus: "implemented",
        outcome: "cancel",
        triggerPolicy: resolution.triggerPolicy,
        cancelledBecause: "manual-policy",
      };
    }
    return {
      ownerMode: "native",
      ownerStatus: "implemented",
      outcome: "pass-through",
      triggerPolicy: resolution.triggerPolicy,
    };
  }
  // codex / acp owner 已注入（工单 04/08 后）：处置交 owner 决定，调度器先行放行
  return { ownerMode: resolution.mode, ownerStatus: "implemented", outcome: "pass-through" };
}

/** 压缩模块在状态行的 key（取消自动压缩后的常驻提示，手动 /compact 后清除） */
export const COMPRESSION_STATUS_KEY = "pi-toolkit.compression";

/** 解析结果是否值得在会话边界提示（默认 native 且无回退原因的会话保持安静） */
function resolutionNoteworthy(resolution: CompressionStrategyResolution): boolean {
  return resolution.mode !== "native" || resolution.source !== "default" || resolution.fallbackReason !== undefined;
}

export interface CompressionSchedulerOptions {
  /** 宿主实时译者（模块键表收窄在 messages/） */
  readonly t: Translator;
  /** 读本模块配置节（mod.ts 注入 context.getConfig；每次压缩准备开始时重读） */
  readonly getConfig: () => ModuleConfigRecord;
  /** 工单 04/08 注入的 codex / acp owner（native 内建，注入会被忽略） */
  readonly owners?: readonly CompactOwnerModule[];
  /** ACP 私有状态探测（工单 11 跨模式切换保护）：返回本会话当前活动的 ACP
   * sidecar（blocks>0 视为活动）；探测失败或缺席按无状态处理 */
  readonly acpStateProbe?: (ctx: ExtensionContext) => Promise<{ readonly blocks: number } | undefined>;
}

export interface CompressionScheduler {
  /** session_before_compact 的唯一入口（mod.ts 注册，一个模块一个 handler） */
  handleBeforeCompact(
    event: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
  ): Promise<CompactHandlerResult | undefined>;
  /** 会话开始：清空上一会话的诊断去重与状态行残留 */
  beginSession(ctx: ExtensionContext): void;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 建调度器实例（mod.ts 装配时调用一次）。诊断口径：
 * - 取消：通知一次（含 reason 与工单 02 的单行诊断）+ 状态行常驻
 *   「需手动 /compact 或新建会话」提示（不是故障，用 info 级）；同一决定不重复
 *   通知，reason 或策略变化后重新通知；
 * - owner 未实现（codex/acp 已解析）：通知一次 info 说明本次继续 Pi 原生实现；
 * - 内部异常：error 级通知 + 空结果交回 Pi 原生流程；
 * - pass-through 时清掉状态行的取消提示（上下文已恢复或用户已手动压缩）。
 */
export function createCompressionScheduler(
  options: CompressionSchedulerOptions,
): CompressionScheduler {
  const owners = new Map<CompressionMode, CompactOwnerModule>();
  for (const owner of options.owners ?? []) {
    if (!BUILTIN_OWNER_MODES.includes(owner.mode)) owners.set(owner.mode, owner);
  }
  const t = options.t;
  let notifiedSignature: string | undefined;
  /** 会话内最近一次解析结果（模型切换/配置变更后的重解析诊断用，工单 11） */
  let lastResolution: CompressionStrategyResolution | undefined;

  const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void => {
    if (ctx.hasUI) ctx.ui.notify(message, level);
  };
  const setStatus = (ctx: ExtensionContext, text: string | undefined): void => {
    if (ctx.hasUI) ctx.ui.setStatus(COMPRESSION_STATUS_KEY, text);
  };

  /** 当前模型 × 配置的实时解析（压缩事件与会话边界共用同一接缝） */
  function resolveCurrent(ctx: ExtensionContext): CompressionStrategyResolution | undefined {
    if (!ctx.model) return undefined;
    const { settings } = readCompressionSettings(options.getConfig());
    return resolveCompressionStrategy(modelIdentityFromModel(ctx.model), settings);
  }

  /** 策略变化诊断（工单 11：模型切换/配置变更在事件边界被重新解析）：新旧任一
   * 值得注意时提示一次；两侧都是默认 native 的会话保持安静 */
  function trackResolutionChange(ctx: ExtensionContext, resolution: CompressionStrategyResolution | undefined): void {
    if (lastResolution === undefined || resolution === undefined) return;
    const changed =
      lastResolution.mode !== resolution.mode ||
      lastResolution.source !== resolution.source ||
      lastResolution.protocol !== resolution.protocol ||
      lastResolution.triggerPolicy !== resolution.triggerPolicy;
    if (!changed) return;
    if (!(resolutionNoteworthy(lastResolution) || resolutionNoteworthy(resolution))) return;
    notify(
      ctx,
      t("module.compression.lifecycle.reparsed", {
        previous: `${compressionModeLabel(lastResolution.mode, t)}（${compressionSourceLabel(lastResolution.source, t)}）`,
        diagnosis: formatResolutionDiagnosis(resolution, t),
      }),
      "info",
    );
  }

  /** 会话当前的活动私有状态报告（跨模式切换保护，工单 11；外部扩展声明检测，
   * 工单 12）：Codex checkpoint 声明看会话分支（纯函数），ACP sidecar 经注入
   * 的探测口；labels 为可读清单。foreignClaim = 最新 compaction 携带上游
   * 外部压缩扩展（pi-codex-compact）的 kind——内置模块不回放也不覆盖它 */
  async function privateStateReport(
    ctx: ExtensionContext,
    event: SessionBeforeCompactEvent,
  ): Promise<{
    readonly labels: readonly string[];
    readonly codexClaim: boolean;
    readonly foreignClaim: boolean;
    readonly acpBlocks: number;
  }> {
    const labels: string[] = [];
    let codexClaim = false;
    let foreignClaim = false;
    if (hasActiveCheckpointClaim(event.branchEntries)) {
      codexClaim = true;
      const checkpoint = latestCheckpoint(event.branchEntries);
      labels.push(
        checkpoint
          ? t("module.compression.lifecycle.state.codexClaim", {
              identity: `${checkpoint.details.provider}/${checkpoint.details.modelId}`,
            })
          : t("module.compression.lifecycle.state.codexClaimUnparsed"),
      );
    } else if (hasForeignCheckpointClaim(event.branchEntries)) {
      // 外部压缩扩展的声明（上游 kind）：不是本仓状态，但同样是不能被静默
      // 二次压缩的 opaque 坐标——按外来私有状态保护（检测与诊断级，迁移归工单 14）
      foreignClaim = true;
      labels.push(
        t("module.compression.lifecycle.state.foreignClaim", {
          identity: foreignCheckpointIdentity(event.branchEntries),
        }),
      );
    }
    let acpBlocks = 0;
    if (options.acpStateProbe) {
      try {
        const acp = await options.acpStateProbe(ctx);
        if (acp && acp.blocks > 0) {
          acpBlocks = acp.blocks;
          labels.push(t("module.compression.lifecycle.state.acpSidecar", { blocks: String(acp.blocks) }));
        }
      } catch {
        // 探测失败不阻断压缩决策：按无 ACP 状态处理
      }
    }
    return { labels, codexClaim, foreignClaim, acpBlocks };
  }

  /** 危险请求的跨模式保护（工单 11）：native 放行前发现活动私有状态 → 取消并
   * 保留原历史（不得让 Pi 原生 summary 消化另一套压缩坐标），诊断告知切回原
   * 模型或新建会话；纯外部扩展声明（工单 12）用专属诊断——「切回原模型」对它
   * 无意义，正确的去向是外部扩展迁移（工单 14）或新建会话 */
  async function protectForeignPrivateState(
    ctx: ExtensionContext,
    event: SessionBeforeCompactEvent,
    resolution: CompressionStrategyResolution | undefined,
  ): Promise<CompactHandlerResult | undefined> {
    const report = await privateStateReport(ctx, event);
    if (report.labels.length === 0) return undefined;
    return cancelWithProtectedNotice(
      ctx,
      event,
      resolution,
      report,
      report.foreignClaim && !report.codexClaim && report.acpBlocks === 0,
    );
  }

  /** 保护取消 + 一次性通知（两处共用，评审修复 S1 去重）：构造保护签名、按签名
   *  去重通知、状态行常驻保护提示，返回 { cancel: true }。foreignOnly 决定文案
   *  选择（外部扩展专属 vs 通用），由调用方判定——native 放行侧还要求无 codex
   *  声明，codex 接管侧不把 codex 自己的声明当外来状态。 */
  function cancelWithProtectedNotice(
    ctx: ExtensionContext,
    event: SessionBeforeCompactEvent,
    resolution: CompressionStrategyResolution | undefined,
    report: { readonly labels: readonly string[]; readonly foreignClaim: boolean },
    foreignOnly: boolean,
  ): CompactHandlerResult {
    const signature = `protected|${decisionOwnerLabelOf(resolution)}|${report.labels.join("|")}`;
    if (signature !== notifiedSignature) {
      notifiedSignature = signature;
      notify(
        ctx,
        foreignOnly
          ? t("module.compression.lifecycle.foreignProtected", {
              reason: t(`module.compression.reason.${event.reason}`),
              identity: foreignCheckpointIdentity(event.branchEntries),
            })
          : t("module.compression.lifecycle.protected", {
              reason: t(`module.compression.reason.${event.reason}`),
              states: report.labels.join("、"),
              mode: `${compressionModeLabel(resolution?.mode ?? "native", t)}（${compressionSourceLabel(
                resolution?.source ?? "default",
                t,
              )}）`,
            }),
        "warning",
      );
    }
    setStatus(ctx, t("module.compression.lifecycle.protectedStatus"));
    return { cancel: true };
  }

  function decisionOwnerLabelOf(resolution: CompressionStrategyResolution | undefined): string {
    return resolution ? `${resolution.mode}|${resolution.source}` : "native|unresolved";
  }

  function decisionSignature(decision: CompactSchedulingDecision, reason: CompactEventReason): string {
    return JSON.stringify([
      decision.ownerMode,
      decision.ownerStatus,
      decision.outcome,
      decision.triggerPolicy ?? null,
      decision.cancelledBecause ?? null,
      reason,
    ]);
  }

  async function handleBeforeCompact(
    event: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
  ): Promise<CompactHandlerResult | undefined> {
    try {
      const { settings } = readCompressionSettings(options.getConfig());
      const resolution = ctx.model
        ? resolveCompressionStrategy(modelIdentityFromModel(ctx.model), settings)
        : undefined;
      const decision = decideCompactHandling(resolution, event.reason, owners);
      // 生命周期边界（工单 11）：本次事件的重新解析结果与会话内上一次不同
      // （模型切换 / 配置实时变更）→ 一次性诊断，之后按新策略处置
      trackResolutionChange(ctx, resolution);
      lastResolution = resolution;

      if (decision.outcome === "cancel") {
        // 取消自动压缩：不写入任何 summary（Pi 契约下宿主只发 aborted 事件），
        // 诊断要让用户知道需要手动 /compact 或新建会话——这不是故障
        const signature = decisionSignature(decision, event.reason);
        if (signature !== notifiedSignature) {
          notifiedSignature = signature;
          notify(
            ctx,
            t("module.compression.schedule.cancelled", {
              reason: t(`module.compression.reason.${event.reason}`),
              diagnosis: resolution ? formatResolutionDiagnosis(resolution, t) : "",
            }),
            "info",
          );
        }
        setStatus(ctx, t("module.compression.schedule.status"));
        return { cancel: true };
      }

      // 空结果交回 Pi（含 owner 未实现与无模型的防御路径）：清掉取消提示残留
      setStatus(ctx, undefined);

      if (decision.ownerStatus === "implemented" && decision.ownerMode === "native") {
        // 跨模式切换保护（工单 11）：native 即将接管压缩，但分支上有 Codex
        // checkpoint 或 ACP sidecar 的活动私有状态——取消并保留，不静默重放。
        // 先查保护再重置取消去重：保护取消的签名不能被放行分支的重置抹掉
        const protectedResult = await protectForeignPrivateState(ctx, event, resolution);
        if (protectedResult) return protectedResult;
        // native 放行（Pi 将完成本次压缩）：重置取消诊断去重，下次再次越过
        // 阈值时重新提示；owner 未实现的诊断仍按会话内模式去重，不随事件刷屏
        notifiedSignature = undefined;
      }

      if (decision.ownerStatus === "unimplemented") {
        // owner 未实现的诊断按模式去重（不随 reason 变化重复刷屏）
        const signature = `unimplemented|${decision.ownerMode}`;
        if (signature !== notifiedSignature) {
          notifiedSignature = signature;
          notify(
            ctx,
            t("module.compression.schedule.ownerUnimplemented", {
              mode: compressionModeLabel(decision.ownerMode, t),
              source: compressionSourceLabel(resolution?.source ?? "default", t),
            }),
            "info",
          );
        }
        return {};
      }

      if (decision.ownerStatus === "implemented" && decision.ownerMode !== "native" && resolution) {
        // 工单 04/08 的 owner 分发：owner 返回空结果同样交回 Pi。
        // 跨模式切换保护（工单 11）：codex 接管前发现活动 ACP sidecar——不启动
        // 第二套压缩坐标覆盖已提交状态，取消并告知去向；外部压缩扩展的
        // checkpoint 声明（工单 12）同样拦截——接管会把它压成新坐标，静默搁浅
        // 外部 opaque 历史
        if (decision.ownerMode === "codex") {
          const report = await privateStateReport(ctx, event);
          if (report.acpBlocks > 0 || report.foreignClaim) {
            // 文案选择与 native 放行侧的差异：codex 自己的 checkpoint 声明不是
            // 外来状态，foreignClaim 且无 ACP sidecar 时才用外部扩展专属文案
            return cancelWithProtectedNotice(
              ctx,
              event,
              resolution,
              report,
              report.foreignClaim && report.acpBlocks === 0,
            );
          }
        }
        const owner = owners.get(decision.ownerMode);
        if (owner) {
          const ownerResult = await owner.handleBeforeCompact(event, ctx, resolution);
          if (ownerResult && (ownerResult.cancel || ownerResult.compaction)) return ownerResult;
          return {};
        }
      }

      return {};
    } catch (error) {
      // handler 异常不得击穿宿主：交回 Pi 原生流程并进诊断
      notify(ctx, t("module.compression.schedule.handlerError", { error: describeError(error) }), "error");
      setStatus(ctx, undefined);
      return {};
    }
  }

  return {
    handleBeforeCompact,
    beginSession(ctx: ExtensionContext): void {
      notifiedSignature = undefined;
      setStatus(ctx, undefined);
      // 生命周期边界的重新解析诊断（工单 11）：resume / fork / 宿主重载都以
      // session_start 到达——用当前模型实时解析一次策略， noteworthy 的解析
      // 给一行 info（默认 native 会话保持安静）；后续事件的解析变化另行提示。
      // 解析失败不击穿会话启动（配置问题由配置节诊断另行呈现）
      try {
        const resolution = resolveCurrent(ctx);
        if (resolution && resolutionNoteworthy(resolution)) {
          notify(
            ctx,
            t("module.compression.lifecycle.sessionStart", {
              diagnosis: formatResolutionDiagnosis(resolution, t),
            }),
            "info",
          );
        }
        lastResolution = resolution;
      } catch {
        lastResolution = undefined;
      }
    },
  };
}
