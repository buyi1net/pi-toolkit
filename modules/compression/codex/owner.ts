import type {
  BeforeProviderRequestEvent,
  CompactionResult,
  ContextEvent,
  ExtensionContext,
  SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { Tool } from "@earendil-works/pi-ai";
import type { Translator } from "../../../i18n/index.ts";
import type { ModuleConfigRecord } from "../../../kit/module.ts";
import type { CodexProtocol, CodexUnsupportedPolicy, SessionCompressionOverride } from "../api.ts";
import { readCompressionSettings } from "../config.ts";
import type { CompressionFallbackLedger } from "../fallback.ts";
import { codexProtocolLabel } from "../messages/index.ts";
import { modelIdentityFromModel } from "../rules-editor.ts";
import type { CompactHandlerResult, CompactOwnerModule } from "../scheduler.ts";
import type { CompressionDisplayReporter } from "../display.ts";
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
import {
  CodexHostProjectionUnsupportedError,
  hostSessionProjection,
  type SessionProjectionFn,
} from "./host-projection.ts";
import { CodexOAuthRejectionError, CodexRoutePausedError } from "./compaction-failure.ts";
import { readModelCodexCapability } from "./capability.ts";
import { preflightCodexCompaction, resolveExpectedProfile, type CodexPreflightReason } from "./preflight.ts";
import { hasCheckpointMarker, rewriteCheckpointMarker } from "./protocol.ts";

export type CodexOwnerStage =
  | "resolve"
  | "preflight"
  | "prepare"
  | "commit"
  | "event-result"
  | "projection"
  | "finalize";

export type CodexOwnerStatus = "succeeded" | "fell-back-native" | "cancelled" | "degraded";

export interface CodexOwnerDiagnosis {
  readonly stage: CodexOwnerStage;
  readonly status: CodexOwnerStatus;

  readonly reason?: string;
  readonly at: number;
}

export interface CodexOwnerModule extends CompactOwnerModule {

  handleContext(event: ContextEvent, ctx: ExtensionContext): CodexContextEventResult | undefined;

  handleBeforeProviderRequest(event: BeforeProviderRequestEvent, ctx: ExtensionContext): unknown;

  beginSession(ctx: ExtensionContext): void;

  readonly lastDiagnosis: CodexOwnerDiagnosis | undefined;

  readonly diagnosisTrail: readonly CodexOwnerDiagnosis[];
}

export interface CodexOwnerOptions {
  readonly t: Translator;
  readonly getConfig: () => ModuleConfigRecord;

  readonly readSessionOverride?: () => SessionCompressionOverride | undefined;

  readonly fallback?: CompressionFallbackLedger;

  readonly protocolAdapters: CodexProtocolAdapterMap;

  readonly pi?: {
    readonly getAllTools: () => readonly { name: string; description: string; parameters: Tool["parameters"] }[];
    readonly getActiveTools: () => readonly string[];
  };

  readonly fetch?: typeof globalThis.fetch;
  readonly requestTimeoutMs?: number;
  readonly maxRetries?: number;
  readonly replacementTokenBudget?: number;

  readonly hostProjection?: SessionProjectionFn;

  readonly display?: (ctx: ExtensionContext) => CompressionDisplayReporter | undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function codexOwnedSource(source: CompressionStrategyResolution["source"]): boolean {
  return source === "explicit" || source === "codex-auto" || source === "session-override";
}

const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_RETRIES = 2;

function seamSupportsProjection(seam: SessionProjectionFn): boolean {
  try {
    seam([], null);
    return true;
  } catch (error) {
    if (error instanceof CodexHostProjectionUnsupportedError) return false;
    throw error;
  }
}

export function createCodexOwnerModule(options: CodexOwnerOptions): CodexOwnerModule {
  const t = options.t;
  const protocolAdapters = options.protocolAdapters;

  const hostProjection = options.hostProjection ?? hostSessionProjection;

  const hostProjectionSupported = seamSupportsProjection(hostProjection);
  const trail: CodexOwnerDiagnosis[] = [];
  let currentDiagnosis: CodexOwnerDiagnosis | undefined;

  let projectionNotified = new Set<string>();

  const record = (stage: CodexOwnerStage, status: CodexOwnerStatus, reason?: string): void => {
    currentDiagnosis = { stage, status, ...(reason === undefined ? {} : { reason }), at: Date.now() };
    trail.push(currentDiagnosis);
    if (trail.length > 16) trail.shift();
  };
  const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void => {
    if (ctx.hasUI) ctx.ui.notify(message, level);
  };

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

  function notifyNotWhitelistedOnce(ctx: ExtensionContext): void {
    const key = "codex-not-whitelisted";
    if (projectionNotified.has(key)) return;
    projectionNotified.add(key);
    notify(ctx, t("module.compression.codex.notWhitelisted"), "info");
  }

  function failBeforeCommit(
    ctx: ExtensionContext,
    stage: CodexOwnerStage,
    reason: string,
    headline: string,
    claim: boolean,
    policy: CodexUnsupportedPolicy,
    display: CompressionDisplayReporter | undefined,
  ): CompactHandlerResult {
    if (claim) {
      record(stage, "cancelled", reason);
      notify(
        ctx,
        `${headline} ${t("module.compression.codex.checkpoint.claimProtected")}`,
        policy === "error" ? "error" : "warning",
      );

      display?.protect("codex", reason);
      return { cancel: true };
    }
    if (policy === "error") {
      record(stage, "cancelled", reason);
      notify(ctx, `${headline} ${t("module.compression.codex.outcome.cancelledError")}`, "error");
      display?.fail("codex", reason);
      return { cancel: true };
    }
    record(stage, "fell-back-native", reason);
    notify(ctx, `${headline} ${t("module.compression.codex.outcome.fellBackNative")}`, "warning");

    display?.conclude("codex");
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

    const display = options.display?.(ctx);

    let recoveryIngredients:
      | {
          readonly messages: readonly CodexAgentMessage[];
          readonly prior: CodexCheckpointDetails;

          readonly buildRequest: (messages: readonly CodexRemoteLlmMessage[]) => CodexRemoteCompactionRequest;
        }
      | undefined;

    const model = ctx.model;
    if (!model) {
      return failBeforeCommit(
        ctx,
        "resolve",
        "no-model",
        t("module.compression.codex.resolve.noModel"),
        claim,
        policy,
        display,
      );
    }

    if (!codexOwnedSource(resolution.source)) {
      notifyNotWhitelistedOnce(ctx);
      record("resolve", "fell-back-native", "not-whitelisted");

      display?.conclude("codex");
      return {};
    }

    if (!hostProjectionSupported) {
      return failBeforeCommit(
        ctx,
        "preflight",
        "host-projection-unsupported",
        t("module.compression.codex.hostProjectionUnsupported"),
        claim,
        policy,
        display,
      );
    }

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
          display,
        );
        if (result.cancel !== true) {
          options.fallback?.record({ from: "codex", reason: capability.reason });
        }
        return result;
      }
    }

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
        display,
      );
    }

    try {
      const branch = event.branchEntries;
      display?.begin("codex");
      const prior = latestCheckpoint(branch);
      if (claim && !prior) {

        record("prepare", "cancelled", "checkpoint-invalid");
        notify(
          ctx,
          `${t("module.compression.codex.checkpoint.invalid")} ${t("module.compression.codex.checkpoint.claimProtected")}`,
          policy === "error" ? "error" : "warning",
        );

        display?.protect("codex", "checkpoint-invalid");
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

          record("prepare", "cancelled", "identity-mismatch");
          notify(
            ctx,
            `${t("module.compression.codex.checkpoint.incompatible", { fields: mismatched.join(", ") })} ${t(
              "module.compression.codex.checkpoint.claimProtected",
            )}`,
            policy === "error" ? "error" : "warning",
          );

          display?.protect("codex", "identity-mismatch");
          return { cancel: true };
        }
      }

      const leafId = branch.at(-1)?.id ?? null;

      let messages = [...hostProjection(branch, leafId).messages];
      if (prior) {
        const projected = projectSessionCheckpointContext(hostProjection, messages, branch, prior);
        if (!projected) {

          record("prepare", "cancelled", "projection-unverifiable");
          notify(
            ctx,
            `${t("module.compression.codex.checkpoint.unverifiable")} ${t("module.compression.codex.checkpoint.claimProtected")}`,
            policy === "error" ? "error" : "warning",
          );

          display?.protect("codex", "projection-unverifiable");
          return { cancel: true };
        }
        messages = projected;
      }

      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) throw new Error(auth.error);
      const provider = ctx.modelRegistry.getProvider(model.provider);
      if (!provider) throw new Error(t("module.compression.codex.prepare.providerUnavailable"));

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

        display?.fail("codex", "aborted");
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
          keptMessages: keptMessagesAfterCompaction(hostProjection, branch, event.preparation.firstKeptEntryId),
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

        display?.fail("codex", "commit-validation");
        return { cancel: true };
      }

      record("finalize", "succeeded", details.checkpointId);
      options.fallback?.clear();

      display?.succeed("codex");
      return { compaction };
    } catch (error) {
      if (protocol === "context-management" && (event.signal.aborted || (error instanceof DOMException && error.name === "AbortError"))) {
        record("prepare", "cancelled", "aborted");
        notify(ctx, t("module.compression.codex.contextManagement.cancelled"), "warning");
        display?.fail("codex", "aborted");
        return { cancel: true };
      }
      if (protocol === "context-management" && error instanceof ContextManagementProtocolError) {
        record("prepare", "cancelled", "context-management-invalid-response");
        notify(
          ctx,
          t("module.compression.codex.contextManagement.invalid", { error: describeError(error) }),
          "warning",
        );
        display?.fail("codex", "context-management-invalid-response");
        return { cancel: true };
      }

      if (recoveryIngredients && !event.signal.aborted) {
        try {
          const request = recoveryIngredients.buildRequest(
            convertToLlm(
              summaryPrefix(
                [...recoveryIngredients.messages],

                keptMessagesAfterCompaction(
                  hostProjection,
                  event.branchEntries,
                  event.preparation.firstKeptEntryId,
                ).filter((message) => message.role !== "compactionSummary"),
                fingerprintMessage,
              ),
            ),
          );
          const recovered = await recoverCheckpoint(request, event);
          record("prepare", "succeeded", `checkpoint-recovery:${recoveryIngredients.prior.checkpointId}`);
          notify(ctx, t("module.compression.codex.recovery.succeeded"), "warning");

          display?.succeed("codex");
          return { compaction: recovered };
        } catch (recoveryError) {
          record("prepare", "cancelled", "recovery-failed");
          notify(
            ctx,
            t("module.compression.codex.recovery.failed", { error: describeError(recoveryError) }),
            "warning",
          );

          display?.fail("codex", "recovery-failed");
          return { cancel: true };
        }
      }

      if (error instanceof CodexRoutePausedError) {
        return failBeforeCommit(
          ctx,
          "prepare",
          "route-paused",
          t("module.compression.codex.routePaused"),
          claim,
          policy,
          display,
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
          display,
        );
      }
      return failBeforeCommit(
        ctx,
        "prepare",
        "adapter-error",
        t("module.compression.codex.prepare.failed", { error: describeError(error) }),
        claim,
        policy,
        display,
      );
    }
  }

  function handleContext(event: ContextEvent, ctx: ExtensionContext): CodexContextEventResult | undefined {
    try {

      const scope = codexScope(ctx);
      if (!scope) return undefined;
      const branch = ctx.sessionManager.getBranch();
      const checkpoint = latestCheckpoint(branch);
      if (!checkpoint) return undefined;

      if (!hostProjectionSupported) {
        const key = "host-projection-unsupported";
        if (!projectionNotified.has(key)) {
          projectionNotified.add(key);
          notify(ctx, t("module.compression.codex.checkpoint.hostProjectionUnsupported"), "warning");
        }
        record("projection", "degraded", key);
        return undefined;
      }

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
      const projected = projectSessionCheckpointContext(hostProjection, event.messages, branch, checkpoint);
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
    },
    get lastDiagnosis(): CodexOwnerDiagnosis | undefined {
      return currentDiagnosis;
    },
    get diagnosisTrail(): readonly CodexOwnerDiagnosis[] {
      return [...trail];
    },
  };
}
