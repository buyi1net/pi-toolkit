import type {
  CompactionResult,
  ExtensionContext,
  SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import type { Translator } from "../../i18n/index.ts";
import { ENABLED_FIELD, type ModuleConfigRecord } from "../../kit/module.ts";
import type { CompressionMode, SessionCompressionOverride } from "./api.ts";
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
} from "./messages/index.ts";
import { modelIdentityFromModel } from "./rules-editor.ts";
import { resolveCompressionStrategy, type CompressionStrategyResolution } from "./strategy.ts";

export interface CompactHandlerResult {
  readonly cancel?: boolean;
  readonly compaction?: CompactionResult;
}

export type CompactEventReason = "manual" | "threshold" | "overflow";

export type CompactEventOutcome = "pass-through" | "cancel";

export type CompactOwnerStatus = "implemented" | "unimplemented" | "unresolved";

export interface CompactSchedulingDecision {

  readonly ownerMode: CompressionMode;

  readonly ownerStatus: CompactOwnerStatus;

  readonly outcome: CompactEventOutcome;

  readonly triggerPolicy?: "auto";
}

export interface CompactOwnerModule {

  readonly mode: CompressionMode;
  handleBeforeCompact(
    event: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
    resolution: CompressionStrategyResolution,
  ): Promise<CompactHandlerResult | void> | CompactHandlerResult | void;
}

const BUILTIN_OWNER_MODES: readonly CompressionMode[] = ["native"];

export function decideCompactHandling(
  resolution: CompressionStrategyResolution | undefined,
  _reason: CompactEventReason,
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
    return {
      ownerMode: "native",
      ownerStatus: "implemented",
      outcome: "pass-through",
      triggerPolicy: "auto",
    };
  }

  return { ownerMode: resolution.mode, ownerStatus: "implemented", outcome: "pass-through" };
}

export const COMPRESSION_STATUS_KEY = "pi-toolkit.compression";

export interface CompressionSchedulerOptions {

  readonly t: Translator;

  readonly getConfig: () => ModuleConfigRecord;

  readonly readSessionOverride?: () => SessionCompressionOverride | undefined;

  readonly owners?: readonly CompactOwnerModule[];

  readonly acpStateProbe?: (ctx: ExtensionContext) => Promise<{ readonly blocks: number } | undefined>;
}

export interface CompressionScheduler {

  handleBeforeCompact(
    event: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
  ): Promise<CompactHandlerResult | undefined>;

  beginSession(ctx: ExtensionContext): void;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createCompressionScheduler(
  options: CompressionSchedulerOptions,
): CompressionScheduler {
  const owners = new Map<CompressionMode, CompactOwnerModule>();
  for (const owner of options.owners ?? []) {
    if (!BUILTIN_OWNER_MODES.includes(owner.mode)) owners.set(owner.mode, owner);
  }
  const t = options.t;
  let notifiedSignature: string | undefined;

  const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void => {
    if (ctx.hasUI) ctx.ui.notify(message, level);
  };
  const setStatus = (ctx: ExtensionContext, text: string | undefined): void => {
    if (ctx.hasUI) ctx.ui.setStatus(COMPRESSION_STATUS_KEY, text);
  };

  function compressionEnabled(): boolean {
    return options.getConfig()[ENABLED_FIELD] !== false;
  }

  function trackResolutionChange(_ctx: ExtensionContext, _resolution: CompressionStrategyResolution | undefined): void {

  }

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

  async function handleDisabledCompaction(
    ctx: ExtensionContext,
    event: SessionBeforeCompactEvent,
  ): Promise<CompactHandlerResult> {
    setStatus(ctx, undefined);
    const report = await privateStateReport(ctx, event);
    if (report.labels.length === 0) {

      return {};
    }
    const signature = `disabled|${event.reason}|${report.labels.join("|")}`;
    if (signature !== notifiedSignature) {
      notifiedSignature = signature;
      notify(
        ctx,
        t("module.compression.disabled.protected", {
          reason: t(`module.compression.reason.${event.reason}`),
          states: report.labels.join("、"),
        }),
        "warning",
      );
    }
    setStatus(ctx, t("module.compression.lifecycle.protectedStatus"));
    return { cancel: true };
  }

  async function handleBeforeCompact(
    event: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
  ): Promise<CompactHandlerResult | undefined> {
    try {

      if (!compressionEnabled()) return await handleDisabledCompaction(ctx, event);
      const { settings } = readCompressionSettings(options.getConfig());
      const resolution = ctx.model
        ? resolveCompressionStrategy(
            modelIdentityFromModel(ctx.model),
            settings,
            options.readSessionOverride?.(),
          )
        : undefined;
      const decision = decideCompactHandling(resolution, event.reason, owners);

      trackResolutionChange(ctx, resolution);

      setStatus(ctx, undefined);

      if (decision.ownerStatus === "implemented" && decision.ownerMode === "native") {

        const protectedResult = await protectForeignPrivateState(ctx, event, resolution);
        if (protectedResult) return protectedResult;

        notifiedSignature = undefined;
      }

      if (decision.ownerStatus === "unimplemented") {

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

        if (decision.ownerMode === "codex") {
          const report = await privateStateReport(ctx, event);
          if (report.acpBlocks > 0 || report.foreignClaim) {

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
    },
  };
}
