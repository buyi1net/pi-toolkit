import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ENABLED_FIELD, type ModuleContext } from "../../kit/module.ts";
import { COMPRESSION_STATUS_SERVICE_NAME, type CompressionMode, type ModelIdentity } from "./api.ts";
import { createCodexOwnerModule } from "./codex/owner.ts";
import { createRemoteV2CompactionAdapter } from "./codex/remote-v2.ts";
import { createResponsesCompactAdapter } from "./codex/remote-compact.ts";
import { createContextManagementAdapter } from "./codex/remote-context-management.ts";
import { readCompressionSettings } from "./config.ts";
import { createCompressionFallbackLedger } from "./fallback.ts";
import { createAcpEngine, type AcpCompressionEngine } from "./acp/engine.ts";
import { createAcpOwner } from "./acp/owner.ts";
import {
  COMPRESSION_DISPLAY_ENTRY_TYPE,
  createDisplayPresentation,
  createDisplayReporter,
  type CompressionDisplayEntryData,
  type CompressionDisplayReporter,
} from "./display.ts";
import { readAcpSidecarBlockCount } from "./acp/sidecar.ts";
import { makeAcpCompressTool } from "./acp/compress-tool.ts";
import { makeAcpDecompressTool } from "./acp/decompress-tool.ts";
import { makeAcpSearchTool } from "./acp/search-tool.ts";
import { formatCompressionProblem } from "./messages/index.ts";
import { createCompressionScheduler } from "./scheduler.ts";
import { modelIdentityFromModel } from "./rules-editor.ts";
import { sessionCompressionOverride } from "./session-override.ts";
import { createCompressionStatusService } from "./status.ts";
import { resolveCompressionStrategy } from "./strategy.ts";

function acpPossibleInSettings(section: unknown): boolean {
  const { settings } = readCompressionSettings(section);
  return (
    settings.defaultMode === "acp" || settings.acpAutoDetect || settings.modelRules.some((rule) => rule.mode === "acp")
  );
}

function sessionResolvesAcp(context: ModuleContext, ctx: ExtensionContext): boolean {
  return resolveModeFor(context, ctx.model) === "acp";
}

function resolveModeFor(context: ModuleContext, model: ExtensionContext["model"]): CompressionMode | undefined {
  if (!model) return undefined;
  const { settings } = readCompressionSettings(context.getConfig());
  return resolveCompressionStrategy(modelIdentityFromModel(model), settings, sessionCompressionOverride.get()).mode;
}

export function registerCompression(context: ModuleContext): void {

  sessionCompressionOverride.reset();

  const compressionEnabled = (): boolean => context.getConfig()[ENABLED_FIELD] !== false;

  const acpActive = (ctx: ExtensionContext): boolean => compressionEnabled() && sessionResolvesAcp(context, ctx);

  let sessionModel: ModelIdentity | undefined;

  const fallbackLedger = createCompressionFallbackLedger();

  const statusService = createCompressionStatusService({
    isEnabled: compressionEnabled,
    readSettings: () => readCompressionSettings(context.getConfig()).settings,
    readModel: () => sessionModel,

    readSessionOverride: () => sessionCompressionOverride.get(),

    readFallback: () => fallbackLedger.read(),
    clearFallback: () => fallbackLedger.clear(),
  });
  context.services.register(COMPRESSION_STATUS_SERVICE_NAME, statusService);

  const acpDiagSeen = new Set<string>();
  const RECOVERY_ROUTED_DIAGNOSTICS = new Set([
    "sidecar-mismatch",
    "sidecar-corrupt",
    "sidecar-newer",
    "sidecar-rebuilt",
    "sidecar-rebuild-failed",
    "sidecar-config-generation",
    "projection-unavailable",
  ]);

  const displayPresentation = createDisplayPresentation();
  displayPresentation.registerRenderer(context.pi, context.t);

  function displayFor(ctx: ExtensionContext): CompressionDisplayReporter | undefined {
    if (!ctx.hasUI) return undefined;
    const sessionManager = ctx.sessionManager as {
      appendCustomEntry?: (customType: string, data?: unknown) => string;
    };
    if (typeof sessionManager.appendCustomEntry !== "function") return undefined;
    return createDisplayReporter(
      displayPresentation,
      (data: CompressionDisplayEntryData) => sessionManager.appendCustomEntry!(COMPRESSION_DISPLAY_ENTRY_TYPE, data),
    );
  }

  let engine: AcpCompressionEngine | undefined;
  const engineFor = (): AcpCompressionEngine | undefined => {
    if (engine) return engine;
    if (!compressionEnabled()) return undefined;

    if (!acpPossibleInSettings(context.getConfig()) && sessionCompressionOverride.get() !== "acp") {
      return undefined;
    }
    engine = createAcpEngine({
      t: context.t,
      diagnostics: (key, level, message, ctx) => {

        if (displayFor(ctx) && RECOVERY_ROUTED_DIAGNOSTICS.has(key)) return;
        if (acpDiagSeen.has(key)) return;
        acpDiagSeen.add(key);
        if (ctx.hasUI) ctx.ui.notify(message, level);
      },

      recoveryEvents: (event, ctx) => {
        const display = displayFor(ctx);
        if (!display) return;
        if (event.kind === "recovering") display.recovering("acp");
        else if (event.kind === "recovered") display.recoverSucceed("acp");
        else display.recoverFail("acp", event.reason);
      },

      readAcpSettings: () => readCompressionSettings(context.getConfig()).settings.acp,
    });
    return engine;
  };

  engineFor();

  const acpOwnerBundle = createAcpOwner({
    engine: () => engineFor(),
    t: context.t,

    fallback: fallbackLedger,

    display: displayFor,
  });

  const codexOwner = createCodexOwnerModule({
    t: context.t,
    getConfig: () => context.getConfig(),
    readSessionOverride: () => sessionCompressionOverride.get(),

    fallback: fallbackLedger,
    protocolAdapters: {
      "remote-v2": createRemoteV2CompactionAdapter(),
      "responses-compact": createResponsesCompactAdapter(),
      "context-management": createContextManagementAdapter(),
    },
    pi: context.pi,

    display: displayFor,
  });

  const scheduler = createCompressionScheduler({
    t: context.t,
    getConfig: () => context.getConfig(),
    owners: [codexOwner, acpOwnerBundle.owner],
    readSessionOverride: () => sessionCompressionOverride.get(),
    acpStateProbe: async (ctx: ExtensionContext) => {
      try {

        const inMemory = engine?.currentState(ctx);
        if (inMemory && inMemory.blocks.length > 0) return { blocks: inMemory.blocks.length };
        const sessionManager = ctx.sessionManager as { getSessionFile?: () => string | undefined };
        const sessionFile =
          typeof sessionManager.getSessionFile === "function" ? sessionManager.getSessionFile() : undefined;
        const blocks = await readAcpSidecarBlockCount(sessionFile ?? undefined);
        return blocks === undefined ? undefined : { blocks };
      } catch {
        return undefined;
      }
    },
  });

  let reportedSignature: string | undefined;

  context.pi.on("session_start", async (_event, ctx) => {

    sessionCompressionOverride.reset();

    fallbackLedger.reset();
    sessionModel = ctx.model ? modelIdentityFromModel(ctx.model) : undefined;
    scheduler.beginSession(ctx);
    codexOwner.beginSession(ctx);
    acpOwnerBundle.beginSession(ctx);
    acpDiagSeen.clear();

    try {
      const expired = displayPresentation.controller.restore(ctx.sessionManager.getBranch());
      if (expired !== undefined) {
        const sessionManager = ctx.sessionManager as {
          appendCustomEntry?: (customType: string, data?: unknown) => string;
        };
        const id = sessionManager.appendCustomEntry?.(COMPRESSION_DISPLAY_ENTRY_TYPE, expired);
        if (id !== undefined) displayPresentation.markVisibleEntry(id);
      }
    } catch {

    }
    const currentEngine = engineFor();
    if (currentEngine) {
      try {
        await currentEngine.beginSession(ctx);
      } catch {

      }
    }
    if (!ctx.hasUI) return;
    const { problems } = readCompressionSettings(context.getConfig());
    if (problems.length === 0) {
      reportedSignature = undefined;
      return;
    }
    const signature = JSON.stringify(problems);
    if (signature === reportedSignature) return;
    reportedSignature = signature;
    for (const problem of problems) {
      ctx.ui.notify(formatCompressionProblem(problem, context.t), "warning");
    }
  });

  context.pi.on("model_select", (event, ctx) => {
    if (event.model) sessionModel = modelIdentityFromModel(event.model);
    fallbackLedger.reset();

    const current = displayPresentation.controller.current;
    if (current?.state === "in-progress") {
      const nextMode = resolveModeFor(context, event.model);

      if (!compressionEnabled() || (nextMode !== undefined && nextMode !== current.mode)) {
        displayFor(ctx)?.conclude(current.mode);
      }
    }
  });

  context.pi.on("session_compact", (event) => {
    statusService.noteCompaction({ fromExtension: event.fromExtension });
  });

  context.pi.on("session_before_compact", async (event, ctx) => {
    const stale = displayPresentation.controller.current;
    if (stale?.state === "in-progress") {
      const mode = resolveModeFor(context, ctx.model);

      if (!compressionEnabled() || (mode !== undefined && mode !== stale.mode)) {
        displayFor(ctx)?.conclude(stale.mode);
      }
    }
    return scheduler.handleBeforeCompact(event, ctx);
  });

  context.pi.on("context", async (event, ctx) => {
    if (!compressionEnabled()) return undefined;
    if (sessionResolvesAcp(context, ctx)) {
      const acpEngine = engineFor();
      if (!acpEngine) return undefined;
      try {
        return await acpEngine.handleContext(event, ctx, true);
      } catch {

        return undefined;
      }
    }
    return codexOwner.handleContext(event, ctx);
  });
  context.pi.on("before_provider_request", (event, ctx) => {

    if (!compressionEnabled()) return undefined;
    return codexOwner.handleBeforeProviderRequest(event, ctx);
  });

  context.pi.on("session_shutdown", async (_event, ctx) => {
    await engine?.endSession(ctx);
    acpDiagSeen.clear();
    sessionModel = undefined;
    sessionCompressionOverride.reset();
    fallbackLedger.reset();
  });

  context.pi.registerTool(
    makeAcpCompressTool({
      engine: () => engineFor(),
      t: context.t,
      isSessionActive: acpActive,
      readAcpSettings: () => readCompressionSettings(context.getConfig()).settings.acp,

      clearFallback: () => fallbackLedger.clear(),

      conclude: (ctx) => displayFor(ctx)?.succeed("acp"),
    }),
  );
  context.pi.registerTool(
    makeAcpDecompressTool({
      engine: () => engineFor(),
      t: context.t,
      isSessionActive: acpActive,
    }),
  );
  context.pi.registerTool(
    makeAcpSearchTool({
      engine: () => engineFor(),
      t: context.t,
      isSessionActive: acpActive,
    }),
  );
}
