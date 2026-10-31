import type { ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import type { Translator } from "../../../i18n/index.ts";
import type { CompressionFallbackLedger } from "../fallback.ts";
import { hasActiveCheckpointClaim, hasForeignCheckpointClaim, latestCheckpoint } from "../codex/checkpoint.ts";
import type { CompactHandlerResult, CompactOwnerModule } from "../scheduler.ts";
import type { CompressionDisplayReporter } from "../display.ts";
import { COMPRESSION_STATUS_KEY } from "../scheduler.ts";
import { readAcpSidecarBlockCount } from "./sidecar.ts";
import { acpHostSupported, type AcpCompressionEngine } from "./engine.ts";

export interface AcpOwnerDeps {

  readonly engine: () => AcpCompressionEngine | undefined;
  readonly t: Translator;

  readonly fallback?: CompressionFallbackLedger;

  readonly display?: (ctx: ExtensionContext) => CompressionDisplayReporter | undefined;
}

export interface AcpOwner {

  readonly owner: CompactOwnerModule;

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
    const display = deps.display?.(ctx);
    const engine = deps.engine();
    if (!engine) {

      if (display) {
        display.fail("acp", "engine-missing");
      } else {
        notifyOnce(ctx, `engine-missing|${event.reason}`, "error", t("module.compression.acp.toolUnavailable"));
      }
      return { cancel: true };
    }

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

        deps.fallback?.record({ from: "acp", reason: "host-unsupported" });

        display?.conclude("acp");
        return {};
      }

      if (display) {
        display.protect("acp", "host-unsupported-state");
      } else {
        notifyOnce(
          ctx,
          `host-unsupported-state|${event.reason}`,
          "error",
          t("module.compression.acp.hostUnsupportedWithState", { reason }),
        );
      }
      return { cancel: true };
    }

    await engine.beginSession(ctx);

    const state = engine.currentState(ctx);
    if (!state) {

      if (display) {
        display.fail("acp", "state-failed");
      } else {
        notifyOnce(
          ctx,
          `state-failed|${event.reason}`,
          "error",
          t("module.compression.acp.compactUnavailable", { reason }),
        );
      }
      return { cancel: true };
    }

    if (display) {
      display.begin("acp");
    } else {
      notifyOnce(
        ctx,
        `takeover|${event.reason}`,
        "info",
        t("module.compression.acp.takeover", { reason }),
      );
      if (ctx.hasUI) {
        ctx.ui.setStatus(COMPRESSION_STATUS_KEY, t("module.compression.acp.status"));
      }
    }

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

      notifyOnce(ctx, "foreign-extension-claim", "warning", t("module.compression.acp.foreignExtensionClaim"));
    }
    return { cancel: true };
  }

  return {
    owner: {
      mode: "acp",
      handleBeforeCompact,
    },
    beginSession(_ctx: ExtensionContext): void {

      notifiedKeys = new Set();
    },
  };
}
