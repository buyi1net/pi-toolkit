// Codex 压缩 owner（工单 04）：按规格「所有者生命周期与失败回退」把
// resolve → preflight → prepare → commit → event result → projection →
// finalize 七个阶段接进统一调度器。
//
// 上游对应：reference/Pi生态/pi-codex-compact/source/src/codex-compact.ts
// （MIT，来源登记见 ../UPSTREAM.md）。提取与适配：
// - 上游的「路由判定 + 远程请求 + checkpoint 构造 + 回放」主干保留；路由
//   判定不再看 model.api / enabled 开关（上游 resolveCompactionRoute），而是
//   由策略解析的 provider/model 白名单先行筛选（本 owner 只处理 mode=codex 且
//   source 为 explicit / codex-auto / session-override 的解析结果——session-override
//   是用户在会话里就地选定的 Codex，已过资格校验）——同 provider 的
//   openai-responses 标记不构成接管资格（工单 02：自动检测只看官方地址口径）；
// - 上游的 OAuth 拒绝路由暂停（rejection-state）、checkpoint recovery
//   （checkpoint-recovery 的 provider.stream 摘要恢复）、context-management
//   的 continuation 编排归工单 05/06/07；本工单的失败回退按规格保守处理：
//   commit 前失败按 onUnsupported 回退 native 或严格报错；已提交 checkpoint
//   后只取消并保留状态，绝不静默二次压缩；
// - projection 失败（回放校验不过）按上游降级语义处理：不注入 opaque
//   历史，请求视图保持 Pi 原样（fallback 文案继续可见），checkpoint 保留。
//
// 私有状态：Codex 的 checkpoint 没有独立 sidecar——details 随 compaction
// entry 由宿主原子落盘；因此 commit 阶段 = 构造并完整校验将落盘的
// compaction 载荷（创建即校验，失败则零写入），event result 阶段 = 交给
// 调度器 / Pi。commit 失败不得回退 native（那等于启动另一种压缩），只能
// 取消并报告。

import type {
  BeforeProviderRequestEvent,
  CompactionResult,
  ContextEvent,
  ExtensionContext,
  SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { buildSessionContext, convertToLlm } from "@earendil-works/pi-coding-agent";
import type { Translator } from "../../../i18n/index.ts";
import type { ModuleConfigRecord } from "../../../kit/module.ts";
import type { CodexProtocol, CodexUnsupportedPolicy, SessionCompressionOverride } from "../api.ts";
import { readCompressionSettings } from "../config.ts";
import type { CompressionFallbackLedger } from "../fallback.ts";
import { codexProtocolLabel } from "../messages/index.ts";
import { modelIdentityFromModel } from "../rules-editor.ts";
import type { CompactHandlerResult, CompactOwnerModule } from "../scheduler.ts";
import { type CompressionStrategyResolution, resolveCompressionStrategy } from "../strategy.ts";
import {
  ContextManagementProtocolError,
  CONTEXT_MANAGEMENT_HISTORY_TOKEN_BUDGET,
  validateContextManagementHistory,
} from "./context-management.ts";
import type { CodexAgentMessage } from "./checkpoint.ts";
import { recoverCheckpoint, summaryPrefix } from "./checkpoint-recovery.ts";
import type {
  CodexProtocolAdapterMap,
  CodexRemoteCompactionRequest,
  CodexRemoteLlmMessage,
  CodexRemoteProvider,
  CodexRemoteProviderHeaders,
  CodexRemoteTool,
  PriorCheckpointPayload,
} from "./remote.ts";

/** context 接缝的返回形状（Pi 0.85.1 未导出 ContextEventResult，用结构形状） */
type CodexContextEventResult = { messages?: CodexAgentMessage[] };
import {
  buildReplacementHistory,
  checkpointMarker,
  codexCheckpointIdentity,
  createCheckpointDetails,
  fallbackSummary,
  fingerprintMessage,
  hasActiveCheckpointClaim,
  latestCheckpoint,
  REPLACEMENT_BYTE_BUDGET,
  type CodexCheckpointDetails,
} from "./checkpoint.ts";
import { keptMessagesAfterCompaction, projectSessionCheckpointContext } from "./checkpoint-projection.ts";
import { CodexOAuthRejectionError, CodexRoutePausedError } from "./compaction-failure.ts";
import { readModelCodexCapability } from "./capability.ts";
import { preflightCodexCompaction, resolveExpectedProfile, type CodexPreflightReason } from "./preflight.ts";
import { hasCheckpointMarker, rewriteCheckpointMarker } from "./protocol.ts";

/** owner 状态行 key（压缩进行中的提示；区别于调度器的取消常驻提示） */
export const CODEX_OWNER_STATUS_KEY = "pi-toolkit.compression.codex";

/** 规格的 owner 阶段（诊断用机读值） */
export type CodexOwnerStage =
  | "resolve"
  | "preflight"
  | "prepare"
  | "commit"
  | "event-result"
  | "projection"
  | "finalize";

/** 阶段处置结果：succeeded / 回退 native / 取消 / 降级（projection 不注入） */
export type CodexOwnerStatus = "succeeded" | "fell-back-native" | "cancelled" | "degraded";

/** owner 诊断（规格：模式、模式来源、状态来源与失败阶段都要可读可查） */
export interface CodexOwnerDiagnosis {
  readonly stage: CodexOwnerStage;
  readonly status: CodexOwnerStatus;
  /** 机读原因（api-not-responses / identity-mismatch / adapter-error…） */
  readonly reason?: string;
  readonly at: number;
}

/** Codex owner 的完整模块面（session_before_compact 之外还有投影接缝） */
export interface CodexOwnerModule extends CompactOwnerModule {
  /** context 接缝：把 marker 投影进请求视图（mod.ts 注册） */
  handleContext(event: ContextEvent, ctx: ExtensionContext): CodexContextEventResult | undefined;
  /** before_provider_request 接缝：marker → replacement history（mod.ts 注册） */
  handleBeforeProviderRequest(event: BeforeProviderRequestEvent, ctx: ExtensionContext): unknown;
  /** 会话边界：清诊断去重与状态行残留（mod.ts 在 session_start 调用） */
  beginSession(ctx: ExtensionContext): void;
  /** 最近一次处置的诊断（测试与菜单诊断观察用） */
  readonly lastDiagnosis: CodexOwnerDiagnosis | undefined;
  /** 本次会话的阶段轨迹（有界；验收断言各阶段结果用） */
  readonly diagnosisTrail: readonly CodexOwnerDiagnosis[];
}

export interface CodexOwnerOptions {
  readonly t: Translator;
  readonly getConfig: () => ModuleConfigRecord;
  /** 当前会话覆盖读口（工单 05；未注入 = 永不覆盖，完全按配置解析） */
  readonly readSessionOverride?: () => SessionCompressionOverride | undefined;
  /** 降级记账接缝（工单 06）：运行期复核不通过时记 fallbackFrom=codex，
   *  finalize 成功时幂等清除；未注入 = 不记账（独立装载 / 测试不需要状态栏） */
  readonly fallback?: CompressionFallbackLedger;
  /** 协议适配器表（工单 05/06/07 接入；本构建为空 = 协议不可用，preflight 拦截） */
  readonly protocolAdapters: CodexProtocolAdapterMap;
  /** 工具目录接缝（压缩请求的 tools 视图；测试与独立装载可缺席） */
  readonly pi?: {
    readonly getAllTools: () => readonly { name: string; description: string; parameters: unknown }[];
    readonly getActiveTools: () => readonly string[];
  };
  /** 可注入 transport（真实协议适配器消费；fake 测试不需要） */
  readonly fetch?: typeof globalThis.fetch;
  readonly requestTimeoutMs?: number;
  readonly maxRetries?: number;
  readonly replacementTokenBudget?: number;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Codex owner 认可的解析来源（工单 02 的白名单判定）：显式规则命中、官方 OpenAI
 * Responses / Codex OAuth 链路的自动检测，或用户在会话里就地选定的 Codex 覆盖
 * （工单 05：已过资格校验，是显式选择，不是默认策略）。默认策略与 ACP 自动检测都
 * 不算白名单（默认策略选 codex 时按未白名单处理，只提示不改写）。投影接缝与压缩
 * 事件共用这一处判定，避免两条路径对同一会话给出不同结论。
 */
function codexOwnedSource(source: CompressionStrategyResolution["source"]): boolean {
  return source === "explicit" || source === "codex-auto" || source === "session-override";
}

/** 工单 05/06/07 适配器消费的远程请求超时/重试默认值（上游 settings 同款基线） */
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_RETRIES = 2;

/**
 * 建 Codex owner。装配：mod.ts 传入宿主译者、配置读取、协议适配器表与
 * pi 工具接缝；调度器经 owners 注入接管 mode=codex 的 session_before_compact。
 */
export function createCodexOwnerModule(options: CodexOwnerOptions): CodexOwnerModule {
  const t = options.t;
  const protocolAdapters = options.protocolAdapters;
  const trail: CodexOwnerDiagnosis[] = [];
  let currentDiagnosis: CodexOwnerDiagnosis | undefined;
  /** 投影类通知的去重指纹（每次请求都会走 context，必须去重） */
  let projectionNotified = new Set<string>();

  const record = (stage: CodexOwnerStage, status: CodexOwnerStatus, reason?: string): void => {
    currentDiagnosis = { stage, status, ...(reason === undefined ? {} : { reason }), at: Date.now() };
    trail.push(currentDiagnosis);
    if (trail.length > 16) trail.shift();
  };
  const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void => {
    if (ctx.hasUI) ctx.ui.notify(message, level);
  };
  const setStatus = (ctx: ExtensionContext, text: string | undefined): void => {
    if (ctx.hasUI) ctx.ui.setStatus(CODEX_OWNER_STATUS_KEY, text);
  };

  /** 会话模型 + 解析结果（投影接缝每次请求重解析；与调度器同源输入） */
  function codexScope(
    ctx: ExtensionContext,
  ): { model: NonNullable<ExtensionContext["model"]>; resolution: CompressionStrategyResolution } | undefined {
    if (!ctx.model) return undefined;
    const { settings } = readCompressionSettings(options.getConfig());
    const resolution = resolveCompressionStrategy(
      modelIdentityFromModel(ctx.model),
      settings,
      options.readSessionOverride?.(),
    );
    if (resolution.mode !== "codex" || !codexOwnedSource(resolution.source)) return undefined;
    return { model: ctx.model, resolution };
  }

  /** 白名单外的 codex 解析（默认策略配了 codex 等）：零行为 + 一次性提示 */
  function notifyNotWhitelistedOnce(ctx: ExtensionContext): void {
    const key = "codex-not-whitelisted";
    if (projectionNotified.has(key)) return;
    projectionNotified.add(key);
    notify(ctx, t("module.compression.codex.notWhitelisted"), "info");
  }

  /**
   * commit 前失败的统一处置（resolve/preflight/prepare）：
   * - 分支上已有 checkpoint 声明：取消并保留（native 回退会覆盖 opaque 状态，
   *   规格禁止）；strict 策略升为 error 级；
   * - 无声明 + onUnsupported=error：取消并报错（不回退）；
   * - 无声明 + onUnsupported=native：空结果交回 Pi 原生压缩。
   */
  function failBeforeCommit(
    ctx: ExtensionContext,
    stage: CodexOwnerStage,
    reason: string,
    headline: string,
    claim: boolean,
    policy: CodexUnsupportedPolicy,
  ): CompactHandlerResult {
    if (claim) {
      record(stage, "cancelled", reason);
      notify(
        ctx,
        `${headline} ${t("module.compression.codex.checkpoint.claimProtected")}`,
        policy === "error" ? "error" : "warning",
      );
      return { cancel: true };
    }
    if (policy === "error") {
      record(stage, "cancelled", reason);
      notify(ctx, `${headline} ${t("module.compression.codex.outcome.cancelledError")}`, "error");
      return { cancel: true };
    }
    record(stage, "fell-back-native", reason);
    notify(ctx, `${headline} ${t("module.compression.codex.outcome.fellBackNative")}`, "warning");
    return {};
  }

  function unsupportedHeadline(reason: CodexPreflightReason, api: string | undefined, protocol?: CodexProtocol): string {
    if (reason === "api-not-responses") {
      return t("module.compression.codex.unsupported.apiNotResponses", { api: api ?? "" });
    }
    if (reason === "profile-conflict") {
      return t("module.compression.codex.unsupported.profileConflict", { api: api ?? "" });
    }
    return t("module.compression.codex.unsupported.protocolUnavailable", {
      protocol: codexProtocolLabel(protocol, t),
    });
  }

  function activeTools(): CodexRemoteTool[] {
    const pi = options.pi;
    if (!pi) return [];
    const available = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
    return pi.getActiveTools().flatMap((name) => {
      const tool = available.get(name);
      return tool ? [{ name: tool.name, description: tool.description, parameters: tool.parameters }] : [];
    });
  }

  async function handleBeforeCompact(
    event: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
    resolution: CompressionStrategyResolution,
  ): Promise<CompactHandlerResult | undefined> {
    const claim = hasActiveCheckpointClaim(event.branchEntries);
    const policy: CodexUnsupportedPolicy = resolution.onUnsupported ?? "native";
    const protocol: CodexProtocol = resolution.protocol ?? "remote-v2";
    /** 摘要恢复（工单 11 接线）的原料：鉴权与 provider 就绪、投影完成、分支上
     * 有同身份可回放的 checkpoint 后才填充；远程压缩失败时据此尝试把 opaque
     * 历史翻成明文续接摘要（规格「兼容的恢复」路径，见 catch）。provider/鉴权
     * 经组装器闭包捕获（S2 去重），不再单独携带。 */
    let recoveryIngredients:
      | {
          readonly messages: readonly CodexAgentMessage[];
          readonly prior: CodexCheckpointDetails;
          /** 恢复请求组装器（S2 去重）：与主请求共用公共字段展开，只补恢复视图的
           *  messages（前缀摘要 + 保留区间 + fingerprint）与空 tools */
          readonly buildRequest: (messages: readonly CodexRemoteLlmMessage[]) => CodexRemoteCompactionRequest;
        }
      | undefined;

    // ── resolve：模型身份就位（调度器已解析，这里只取当前模型事实）
    const model = ctx.model;
    if (!model) {
      return failBeforeCommit(
        ctx,
        "resolve",
        "no-model",
        t("module.compression.codex.resolve.noModel"),
        claim,
        policy,
      );
    }
    // 白名单防线：codex 只对显式规则命中、官方能力自动检测或当前会话覆盖生效
    // （默认策略不算白名单）
    if (!codexOwnedSource(resolution.source)) {
      notifyNotWhitelistedOnce(ctx);
      record("resolve", "fell-back-native", "not-whitelisted");
      return {};
    }

    // ── preflight（工单 06 挂账一）：codex-auto 与会话覆盖的接管资格运行期复核。
    // 策略层（strategy.ts）是纯函数，只看得到模型目录里的 baseUrl；「模型声明官方
    // 地址、auth 实际指向中转」只有在这里用真实 getApiKeyAndHeaders 才看得出来。
    // 显式规则不参与复核：那正是用户为自建 / 中转端点主动开的口子。
    // 复核不通过就不接管：真的交回 Pi 原生时才记降级（来源 + 机读原因）；取消并
    // 保留私态的分支（已有 checkpoint / 严格报错）原生根本没跑，不能标 [fallback]。
    if (resolution.source === "codex-auto" || resolution.source === "session-override") {
      const capability = await readModelCodexCapability(ctx.modelRegistry, {
        ...model,
        api: model.api ?? "",
        baseUrl: model.baseUrl ?? "",
      });
      if (!capability.capable) {
        const result = failBeforeCommit(
          ctx,
          "preflight",
          capability.reason,
          t("module.compression.codex.capabilityRecheck", {
            detail: t(`module.compression.codex.capability.${capability.reason}`),
          }),
          claim,
          policy,
        );
        if (result.cancel !== true) {
          options.fallback?.record({ from: "codex", reason: capability.reason });
        }
        return result;
      }
    }

    // ── preflight：确定性能力判断（不发请求）
    const preflight = preflightCodexCompaction({
      api: model.api,
      ruleProfile: resolution.profile,
      protocol,
      adapters: protocolAdapters,
    });
    if (preflight.status === "unsupported") {
      return failBeforeCommit(
        ctx,
        "preflight",
        preflight.reason,
        unsupportedHeadline(preflight.reason, preflight.api, preflight.protocol),
        claim,
        policy,
      );
    }

    // ── prepare：在内存构造压缩请求与 checkpoint 载荷（仍无任何写入）
    try {
      const branch = event.branchEntries;
      const prior = latestCheckpoint(branch);
      if (claim && !prior) {
        // 有 opaque 声明但不可解析：不能当明文 summary 二次压缩
        record("prepare", "cancelled", "checkpoint-invalid");
        notify(
          ctx,
          `${t("module.compression.codex.checkpoint.invalid")} ${t("module.compression.codex.checkpoint.claimProtected")}`,
          policy === "error" ? "error" : "warning",
        );
        return { cancel: true };
      }
      if (prior) {
        const mismatched = codexCheckpointIdentity(prior.details, {
          provider: model.provider,
          modelId: model.id,
          api: model.api,
          profile: preflight.profile,
          protocol,
        });
        if (mismatched.length > 0) {
          // 模型切换等身份漂移：保留 checkpoint，取消本次（不得静默二次压缩）
          record("prepare", "cancelled", "identity-mismatch");
          notify(
            ctx,
            `${t("module.compression.codex.checkpoint.incompatible", { fields: mismatched.join(", ") })} ${t(
              "module.compression.codex.checkpoint.claimProtected",
            )}`,
            policy === "error" ? "error" : "warning",
          );
          return { cancel: true };
        }
      }

      const leafId = branch.at(-1)?.id ?? null;
      let messages = buildSessionContext(branch, leafId).messages;
      if (prior) {
        const projected = projectSessionCheckpointContext(messages, branch, prior);
        if (!projected) {
          // 保存的会话日志无法验证上一个 checkpoint 的投影：历史保留，取消
          record("prepare", "cancelled", "projection-unverifiable");
          notify(
            ctx,
            `${t("module.compression.codex.checkpoint.unverifiable")} ${t("module.compression.codex.checkpoint.claimProtected")}`,
            policy === "error" ? "error" : "warning",
          );
          return { cancel: true };
        }
        messages = projected;
      }

      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) throw new Error(auth.error);
      const provider = ctx.modelRegistry.getProvider(model.provider);
      if (!provider) throw new Error(t("module.compression.codex.prepare.providerUnavailable"));

      // 组装 CodexRemoteCompactionRequest（评审修复 S2 去重）：profile / 鉴权三段 /
      // 信号 / 超时 / 重试 / fetch 的条件展开只写一份；主请求与恢复路径的差异
      // （provider、messages 来源、tools、priorCheckpoint）经 parts 传入
      const buildRemoteRequest = (parts: {
        readonly provider: CodexRemoteProvider;
        readonly auth: {
          readonly apiKey?: string;
          readonly headers?: CodexRemoteProviderHeaders;
          readonly env?: Record<string, string>;
        };
        readonly messages: readonly CodexRemoteLlmMessage[];
        readonly tools: readonly CodexRemoteTool[];
        readonly priorCheckpoint?: PriorCheckpointPayload;
      }): CodexRemoteCompactionRequest => ({
        provider: parts.provider,
        model,
        profile: preflight.profile,
        context: {
          systemPrompt: ctx.getSystemPrompt?.(),
          messages: parts.messages,
          tools: parts.tools,
        },
        protocol,
        ...(parts.auth.apiKey === undefined ? {} : { apiKey: parts.auth.apiKey }),
        ...(parts.auth.headers === undefined ? {} : { headers: parts.auth.headers }),
        ...(parts.auth.env === undefined ? {} : { env: parts.auth.env }),
        signal: event.signal,
        ...(parts.priorCheckpoint === undefined ? {} : { priorCheckpoint: parts.priorCheckpoint }),
        requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
      if (prior) {
        // 身份与投影均已验证：远程压缩失败时的摘要恢复原料就绪（见 catch）
        recoveryIngredients = {
          messages,
          prior: prior.details,
          buildRequest: (llmMessages) =>
            buildRemoteRequest({
              provider,
              auth,
              messages: llmMessages,
              tools: [],
              priorCheckpoint: {
                marker: checkpointMarker(prior.details.checkpointId),
                replacementHistory: prior.details.replacementHistory,
              },
            }),
        };
      }

      setStatus(
        ctx,
        t("module.compression.codex.status.running", { protocol: codexProtocolLabel(protocol, t) }),
      );
      const response = await preflight.adapter(
        buildRemoteRequest({
          provider,
          auth,
          messages: convertToLlm(messages),
          tools: activeTools(),
          ...(prior
            ? {
                priorCheckpoint: {
                  marker: checkpointMarker(prior.details.checkpointId),
                  replacementHistory: prior.details.replacementHistory,
                },
              }
            : {}),
        }),
      );
      if (event.signal.aborted) {
        record("prepare", "cancelled", "aborted");
        return { cancel: true };
      }

      const replacementHistory =
        protocol === "context-management"
          ? validateContextManagementHistory(response.replacementHistory ?? [], {
              byteBudget: REPLACEMENT_BYTE_BUDGET,
              tokenBudget: CONTEXT_MANAGEMENT_HISTORY_TOKEN_BUDGET,
            })
          : buildReplacementHistory(
              response.compactedOutput?.slice(0, -1) ?? response.promptInput,
              response.item,
              { tokenBudget: options.replacementTokenBudget },
            );
      if (replacementHistory.length === 0) {
        throw new Error(t("module.compression.codex.prepare.emptyReplacement"));
      }

      // ── commit：构造并完整校验将随 compaction entry 落盘的载荷。
      // 创建即校验（round-trip parse）失败 = commit 失败：不返回成功结果、
      // 不启动另一种压缩，取消并报告（原会话日志完整保留）。
      let details: CodexCheckpointDetails;
      let compaction: CompactionResult;
      try {
        details = createCheckpointDetails({
          provider: model.provider,
          api: model.api,
          profile: preflight.profile,
          modelId: model.id,
          protocol,
          replacementHistory,
          keptMessages: keptMessagesAfterCompaction(branch, event.preparation.firstKeptEntryId),
        });
        compaction = {
          summary: fallbackSummary(details.checkpointId),
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
          usage: response.usage,
          details,
        };
      } catch (error) {
        record("commit", "cancelled", "commit-validation");
        notify(
          ctx,
          t("module.compression.codex.commit.failed", { error: describeError(error) }),
          "error",
        );
        return { cancel: true };
      }

      // ── event result：把 compaction 交给调度器 → Pi（details 随 entry 原子落盘；
      // 该阶段的失败模式由调度器的异常兜底覆盖——owner 抛错时空结果交回 Pi 并进诊断）。
      // ── finalize：成功路径无通知（状态行在 finally 清除），诊断记录最终态。
      // 工单 06：Codex 压缩真正成功即清降级（幂等；无降级记录时不递增 revision）
      record("finalize", "succeeded", details.checkpointId);
      options.fallback?.clear();
      return { compaction };
    } catch (error) {
      if (protocol === "context-management" && (event.signal.aborted || (error instanceof DOMException && error.name === "AbortError"))) {
        record("prepare", "cancelled", "aborted");
        notify(ctx, t("module.compression.codex.contextManagement.cancelled"), "warning");
        return { cancel: true };
      }
      if (protocol === "context-management" && error instanceof ContextManagementProtocolError) {
        record("prepare", "cancelled", "context-management-invalid-response");
        notify(
          ctx,
          t("module.compression.codex.contextManagement.invalid", { error: describeError(error) }),
          "warning",
        );
        return { cancel: true };
      }
      // ── checkpoint 摘要恢复（工单 11 接线）：远程压缩已就绪但失败，分支上有
      // 同身份可回放的 checkpoint——用一次普通推理请求把 opaque 历史翻成明文
      // 续接摘要（规格三选一中的「兼容的恢复」，有损；上游同款触发面：仅覆盖
      // 远程尝试就绪后的失败——身份不匹配/投影不可验证/取消在更早的确定性分支
      // 返回，不进入恢复）。恢复自身失败不回退 native（已提交状态不得被另一套
      // 压缩覆盖）：取消并保留，诊断给出可重试动作。
      if (recoveryIngredients && !event.signal.aborted) {
        try {
          const request = recoveryIngredients.buildRequest(
            convertToLlm(
              summaryPrefix(
                [...recoveryIngredients.messages],
                // 上游同款：保留区间里的旧 compaction 条目被新压缩抑制，不参与
                // 前缀对齐（projectedKeptMessages 的 compaction 过滤）
                keptMessagesAfterCompaction(event.branchEntries, event.preparation.firstKeptEntryId).filter(
                  (message) => message.role !== "compactionSummary",
                ),
                fingerprintMessage,
              ),
            ),
          );
          setStatus(ctx, t("module.compression.codex.recovery.status"));
          const recovered = await recoverCheckpoint(request, event);
          record("prepare", "succeeded", `checkpoint-recovery:${recoveryIngredients.prior.checkpointId}`);
          notify(ctx, t("module.compression.codex.recovery.succeeded"), "warning");
          return { compaction: recovered };
        } catch (recoveryError) {
          record("prepare", "cancelled", "recovery-failed");
          notify(
            ctx,
            t("module.compression.codex.recovery.failed", { error: describeError(recoveryError) }),
            "warning",
          );
          return { cancel: true };
        }
      }
      // 协议适配器（工单 05 起）的两类带标签失败给专用诊断文案：路由暂停（未发
      // 请求）与 OAuth 操作拒绝（已发请求但被拒）；其余仍走通用 prepare 失败文案。
      // 处置矩阵不变（failBeforeCommit 按 claim × onUnsupported 决定回退/取消）。
      if (error instanceof CodexRoutePausedError) {
        return failBeforeCommit(
          ctx,
          "prepare",
          "route-paused",
          t("module.compression.codex.routePaused"),
          claim,
          policy,
        );
      }
      if (error instanceof CodexOAuthRejectionError) {
        return failBeforeCommit(
          ctx,
          "prepare",
          "oauth-rejected",
          t("module.compression.codex.oauthRejected", { error: describeError(error) }),
          claim,
          policy,
        );
      }
      return failBeforeCommit(
        ctx,
        "prepare",
        "adapter-error",
        t("module.compression.codex.prepare.failed", { error: describeError(error) }),
        claim,
        policy,
      );
    } finally {
      setStatus(ctx, undefined);
    }
  }

  function handleContext(event: ContextEvent, ctx: ExtensionContext): CodexContextEventResult | undefined {
    try {
      // 未命中 codex 白名单（含同 provider 的 openai-responses 标记）：零行为
      const scope = codexScope(ctx);
      if (!scope) return undefined;
      const branch = ctx.sessionManager.getBranch();
      const checkpoint = latestCheckpoint(branch);
      if (!checkpoint) return undefined;
      // 身份期望用当前模型与规则推导（不依赖适配器可用性——已存在的
      // checkpoint 回放不能因本构建未接协议而失效）
      const expectedProfile = resolveExpectedProfile(scope.model.api, scope.resolution.profile);
      if (expectedProfile === undefined) {
        record("projection", "degraded", "profile-unresolvable");
        return undefined;
      }
      const mismatched = codexCheckpointIdentity(checkpoint.details, {
        provider: scope.model.provider,
        modelId: scope.model.id,
        api: scope.model.api,
        profile: expectedProfile,
        protocol: scope.resolution.protocol ?? "remote-v2",
      });
      if (mismatched.length > 0) {
        const key = `identity|${mismatched.join(",")}`;
        if (!projectionNotified.has(key)) {
          projectionNotified.add(key);
          notify(
            ctx,
            t("module.compression.codex.checkpoint.incompatible", { fields: mismatched.join(", ") }),
            "warning",
          );
        }
        record("projection", "degraded", "identity-mismatch");
        return undefined;
      }
      const projected = projectSessionCheckpointContext(event.messages, branch, checkpoint);
      if (!projected) {
        const key = "projection-failed";
        if (!projectionNotified.has(key)) {
          projectionNotified.add(key);
          notify(ctx, t("module.compression.codex.checkpoint.projectionFailed"), "warning");
        }
        record("projection", "degraded", "projection-unverifiable");
        return undefined;
      }
      record("projection", "succeeded", checkpoint.details.checkpointId);
      return { messages: projected };
    } catch (error) {
      // 投影异常不得击穿请求：保持 Pi 原视图（降级），记录诊断
      record("projection", "degraded", describeError(error));
      return undefined;
    }
  }

  function handleBeforeProviderRequest(event: BeforeProviderRequestEvent, ctx: ExtensionContext): unknown {
    try {
      const scope = codexScope(ctx);
      if (!scope) return undefined;
      const checkpoint = latestCheckpoint(ctx.sessionManager.getBranch());
      if (!checkpoint) return undefined;
      const marker = checkpointMarker(checkpoint.details.checkpointId);
      if (!hasCheckpointMarker(event.payload, marker)) return undefined;
      const expectedProfile = resolveExpectedProfile(scope.model.api, scope.resolution.profile);
      if (expectedProfile === undefined) return undefined;
      const identity = codexCheckpointIdentity(checkpoint.details, {
        provider: scope.model.provider,
        modelId: scope.model.id,
        api: scope.model.api,
        profile: expectedProfile,
        protocol: scope.resolution.protocol ?? "remote-v2",
      });
      if (identity.length > 0) return undefined;
      try {
        return rewriteCheckpointMarker(event.payload, marker, checkpoint.details.replacementHistory);
      } catch (error) {
        const key = "rewrite-failed";
        if (!projectionNotified.has(key)) {
          projectionNotified.add(key);
          notify(ctx, t("module.compression.codex.rewrite.failed", { error: describeError(error) }), "warning");
        }
        record("projection", "degraded", "rewrite-failed");
        return undefined;
      }
    } catch (error) {
      record("projection", "degraded", describeError(error));
      return undefined;
    }
  }

  return {
    mode: "codex",
    handleBeforeCompact,
    handleContext,
    handleBeforeProviderRequest,
    beginSession(ctx: ExtensionContext): void {
      projectionNotified = new Set<string>();
      currentDiagnosis = undefined;
      trail.length = 0;
      setStatus(ctx, undefined);
    },
    get lastDiagnosis(): CodexOwnerDiagnosis | undefined {
      return currentDiagnosis;
    },
    get diagnosisTrail(): readonly CodexOwnerDiagnosis[] {
      return [...trail];
    },
  };
}

/** 导出便于测试与后续工单引用的常量（kind 供 claim 断言） */
