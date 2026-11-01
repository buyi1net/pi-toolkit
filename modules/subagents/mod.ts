import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import {
  adoptSurface,
  closeSurface,
  createSurface,
  createSurfaceFor,
  detectSurface,
  isMuxAvailable,
  sendCommand,
} from "./surface.ts";
import { isPidAlive, spawnHeadlessPi, terminateHeadlessProcess } from "./headless.ts";
import {
  advanceStatusState,
  capStatusLines,
  forceStatusAfterInterrupt,
  loadStatusConfig,
  observeStatus,
  type StatusLivenessEvidence,
} from "./status.ts";
import { createSessionFileLivenessProbe } from "./liveness.ts";
import { formatStatusAggregate, formatTransitionLine } from "./status-lines.ts";
import { AGENT_QUEUE_DELIVERY, buildAgentEnvelope, rootTaskName } from "./agent-envelope.ts";
import type { SubagentsTranslate } from "./messages/index.ts";
import { activityDisplayLabel, readSubagentActivityFile, type ActivityReadResult } from "./activity.ts";
import { createDescendantsTracker } from "./descendants.ts";
import { createEnvelopeDelivery } from "./envelope-delivery.ts";
import { withUsageRecording } from "./usage-bridge.ts";
import { loadTierRouteConfig, MODEL_TIERS } from "./routing.ts";
import { debugLog } from "./diagnostics.ts";
import { createRuntimeRegistry, type RuntimeRecord } from "./registry.ts";
import type { RunningSubagent, SubagentResult } from "./types.ts";
import {
  buildPiPromptArgs,
  buildSubagentToolAllowlist,
  resolveEffectiveAutoExit,
  resolveEffectiveInteractive,
  resolveEffectiveSessionMode,
  resolveLaunchBehavior,
  resolveSurfaceChoice,
  subagentTaskDepth,
  canGrantSpawningToChild,
  validateAgentLifecycleConfig,
} from "./launch-config.ts";
import {
  borderLine,
  borderSegmentLine,
  contextWindowFor,
  formatContextUsage,
  formatElapsed,
  formatTokens,
  formatUsageSegments,
  widgetIcon,
} from "./display.ts";
import {
  SUBAGENTS_DIR,
  classifyToolProvisions,
  configureSubagentsExtension,
  getAgentConfigDir,
  getArtifactDir,
  getShellReadyDelayMs,
  getToolExtensionPath,
  hostOptions,
  loadAgentDefaults,
  resolveHostTierSources,
  validateToolProvision,
  widgetText,
  discoverAgentDefinitions,
} from "./mod-host.ts";
export {
  classifyToolProvisions,
  configureSubagentsExtension,
  getAgentConfigDir,
  getToolExtensionPath,
  loadAgentDefaults,
  registerToolExtension,
  resolveHostTierSources,
  validateToolProvision,
} from "./mod-host.ts";
import type { SubagentsExtensionOptions } from "./mod-host.ts";
export type { SubagentsExtensionOptions, SubagentsHostSection, ToolProvisionReport } from "./mod-host.ts";
import {
  classifyWatcherFailure,
  deliverRecoveredExit,
  deliverRecoveredHeadless,
  deliverRecoveredPane,
  publishTerminalUpdate,
  recoverRuntimeSubagents,
  waitForHeadlessExit,
  watchSubagent,
} from "./mod-delivery.ts";
import {
  canReuseMemberName,
  drainMemberMailbox,
  killMemberProcess,
  markMemberOffline,
  watchMemberRound,
} from "./mod-members.ts";
import {
  isStatusEnabled,
  renderSubagentWidgetLines,
  renderWidgetSnapshotLines,
  startWidgetRefresh,
  updateWidget,
  widgetRuntime,
} from "./mod-widget.ts";
import { registerSubagentTools } from "./mod-tools.ts";
import { applySandboxToParts, buildHeadlessPrompt } from "./mod-launch.ts";
export { applySandboxToParts, buildHeadlessPrompt } from "./mod-launch.ts";
import {
  createSubagentStartup,
  validateResumeTarget,
} from "./startup.ts";

const WIDGET_INTERVAL_KEY = Symbol.for("pi-subagents/widget-interval");
const STATUS_INTERVAL_KEY = Symbol.for("pi-subagents/status-interval");
const POLL_ABORT_KEY = Symbol.for("pi-subagents/poll-abort-controller");
export const MODULE_INSTANCE_KEY = Symbol.for("pi-subagents/module-instance");
export const moduleInstanceId = randomUUID();
(globalThis as any)[MODULE_INSTANCE_KEY] = moduleInstanceId;

{
  const prevInterval = (globalThis as any)[WIDGET_INTERVAL_KEY];
  if (prevInterval) {
    clearInterval(prevInterval);
    (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
  }
  const prevStatusInterval = (globalThis as any)[STATUS_INTERVAL_KEY];
  if (prevStatusInterval) {
    clearInterval(prevStatusInterval);
    (globalThis as any)[STATUS_INTERVAL_KEY] = null;
  }
  const prevAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
  if (prevAbort) prevAbort.abort();
  (globalThis as any)[POLL_ABORT_KEY] = new AbortController();
}

export function getModuleAbortSignal(): AbortSignal {
  return ((globalThis as any)[POLL_ABORT_KEY] as AbortController).signal;
}

export {
  CODEX_V2_SPAWNING_TOOLS,
  spawningToolsForProtocol,
} from "./launch-config.ts";

export {
  CODEX_V2_SUBAGENT_PROTOCOL,
  validateCodexV2SpawnParams,
} from "./protocol.ts";

const statusConfig = loadStatusConfig();

function sessionPreservedNote(options?: { sessionPreserved?: boolean }): string {
  return options?.sessionPreserved === false
    ? `\n\nThis sub-agent's session artifacts were cleaned up by the retention policy; the session cannot be resumed. If the task goal is achieved, simply continue with your work — do NOT message it again unless you have a genuinely NEW instruction.`
    : `\n\nThis sub-agent has finished and its session is preserved. If the task goal is achieved, simply continue with your work — do NOT message it again unless you have a genuinely NEW instruction (repeated messaging after auto-exit creates an infinite loop).`;
}

export interface ResultEnvelopeParts {
  payload: string;
  hostNote: string;
}

export function buildResultEnvelopeParts(
  result: Pick<
    SubagentResult,
    "exitCode" | "elapsed" | "summary" | "sessionFile" | "sessionId" | "errorMessage"
  >,
  name: string,
  options?: { sessionPreserved?: boolean },
): ResultEnvelopeParts {
  const hostNote = sessionPreservedNote(options).replace(/^\n+/, "");
  if (result.errorMessage) {
    const recoveryHint = options?.sessionPreserved === false
      ? "spawn a new subagent with a corrected route or task"
      : "spawn a new subagent or continue the preserved session with followup_task";
    return {
      payload:
        `Sub-agent "${name}" failed after ${formatElapsed(result.elapsed)} ` +
        `(provider/agent error — auto-retry exhausted).\n\n` +
        `Error: ${result.errorMessage}`,
      hostNote:
        `The subagent did not produce a result. If a retry is genuinely warranted, ` +
        `${recoveryHint}. ${hostNote}`,
    };
  }
  const payload = result.summary?.trim() ? result.summary : "The sub-agent returned no result.";
  return result.exitCode !== 0
    ? { payload, hostNote: `Sub-agent "${name}" failed (exit code ${result.exitCode}). ${hostNote}` }
    : { payload, hostNote: `Sub-agent "${name}" completed in ${formatElapsed(result.elapsed)}. ${hostNote}` };
}

export function resolveResultPresentation(
  result: Pick<
    SubagentResult,
    "exitCode" | "elapsed" | "summary" | "sessionFile" | "sessionId" | "errorMessage"
  >,
  name: string,
  options?: { sessionPreserved?: boolean },
): string {

  const sessionNote = sessionPreservedNote(options);

  if (result.errorMessage) {

    const recoveryHint = options?.sessionPreserved === false
      ? "spawn a new subagent with a corrected route or task"
      : "spawn a new subagent or continue the preserved session with followup_task";
    return (
      `Sub-agent "${name}" failed after ${formatElapsed(result.elapsed)} ` +
      `(provider/agent error — auto-retry exhausted).\n\n` +
      `Error: ${result.errorMessage}\n\n` +
      `The subagent did not produce a result. If a retry is genuinely warranted, ` +
      `${recoveryHint}.${sessionNote}`
    );
  }

  return result.exitCode !== 0
    ? `Sub-agent "${name}" failed (exit code ${result.exitCode}).\n\n${result.summary}${sessionNote}`
    : `Sub-agent "${name}" completed (${formatElapsed(result.elapsed)}).\n\n${result.summary}${sessionNote}`;
}

export function subagentStatusEnvelope(lines: string[], lineLimit: number, t: SubagentsTranslate): string {
  return buildAgentEnvelope({ kind: "STATUS", taskName: rootTaskName(), payload: formatStatusAggregate(lines, lineLimit, t) });
}

export const runtimeRegistry = createRuntimeRegistry();

export const subagentsRunningView = {

  runningCount: (): number => runtimeRegistry.list().length,

  runningNames: (): readonly string[] => runtimeRegistry.list().map((running) => running.name),

  runtimeRecords: (sessionDir: string, sessionId: string): RuntimeRecord[] =>
    runtimeRegistry.readRecords(runtimeRegistry.pathFor(getArtifactDir(sessionDir, sessionId))),
};

const RUNNING_CHILDREN_COUNT_KEY = Symbol.for("pi-subagents/running-children-count");
(globalThis as any)[RUNNING_CHILDREN_COUNT_KEY] = () => runtimeRegistry.list().length;

export let latestCtx: ExtensionContext | null = null;

export let latestPi: ExtensionAPI | null = null;

export const envelopeDelivery = createEnvelopeDelivery({
  send: (message, options, host) => {
    const api = (host as ExtensionAPI | undefined) ?? latestPi;
    if (!api) return Promise.reject(new Error("Pi host is unavailable."));
    return api.sendMessage(message as never, options as never);
  },
});

let statusInterval: ReturnType<typeof setInterval> | null = null;
const sessionLivenessProbe = createSessionFileLivenessProbe();

export function observeRunningSubagent(running: RunningSubagent, observedAt = Date.now()) {
  const activityFile = running.activityFile;
  const read: ActivityReadResult = activityFile
    ? readSubagentActivityFile(activityFile, running.id)
    : { ok: false, reason: "missing" };

  running.activityRead = read.ok
    ? { ok: true }
    : { ok: false, reason: read.reason, error: read.error };

  const session = running.sessionFile
    ? sessionLivenessProbe.probe(running.sessionFile, observedAt)
    : null;
  const evidence: StatusLivenessEvidence = {
    sessionLastChangeAtMs: session?.lastChangeAtMs ?? null,
    processAlive: running.headlessChild
      ? !running.headlessChild.exited
      : running.pid != null
        ? isPidAlive(running.pid)
        : null,
  };

  if (read.ok) {
    running.activity = read.activity;
    running.statusState = observeStatus(running.statusState, {
      snapshot: "present",
      updatedAt: read.activity.updatedAt,
      sequence: read.activity.sequence,
      phase: read.activity.phase,
      active: read.activity.phase === "active",
      toolActive: read.activity.toolActive,
      activeScope: read.activity.activeScope,
      activeSince: read.activity.activeSince,
      waitingSince: read.activity.waitingSince,
      latestEvent: read.activity.latestEvent,
      activityLabel: activityDisplayLabel(read.activity),
    }, observedAt, evidence);
    return;
  }

  running.statusState = observeStatus(running.statusState, {
    snapshot: read.reason,
    snapshotError: read.error,
  }, observedAt, evidence);
}

function steerSubagent(
  running: RunningSubagent,
  message: string,
  send: (surface: string, command: string) => void = sendCommand,
): { ok: true } | { error: string } {
  const flattened = message.replace(/\s*\n\s*/g, " ").trim();

  if (running.kind === "headless") {
    if (running.stdinLost) {
      return {
        error:
          `Cannot deliver message to headless sub-agent "${running.name}": the host was ` +
          `reloaded and its stdin can no longer be reached. Its result will still be ` +
          `delivered when the process exits; spawn a fresh sub-agent if you need to steer it now.`,
      };
    }
    const child = running.headlessChild;
    if (!child) {
      return { error: `Headless sub-agent "${running.name}" has no live process handle.` };
    }
    if (child.exited) {
      return {
        error:
          `Headless sub-agent "${running.name}" has already exited; its result is being delivered. ` +
          `Use followup_task after the result arrives to continue its session.`,
      };
    }
    child.steer(flattened);
    return { ok: true };
  }
  try {
    send(running.surface, flattened);
    return { ok: true };
  } catch (error: any) {

    const muxLabel = detectSurface() === "tmux" ? "tmux" : detectSurface() === "herdr" ? "herdr" : "terminal multiplexer";
    return {
      error:
        `Failed to deliver message to subagent "${running.name}" via ${muxLabel}: ` +
        `${error?.message ?? String(error)}`,
    };
  }
}

export function handleSubagentSteer(
  params: { name?: string; message?: string },
  send: (surface: string, command: string) => void = sendCommand,
) {
  const message = params.message?.trim();
  if (!message) {
    const err = "`message` is required to steer a running subagent.";
    return { content: [{ type: "text" as const, text: err }], details: { error: err } };
  }

  const resolved = runtimeRegistry.resolveName(params.name ?? "");
  if ("error" in resolved) {
    return {
      content: [{ type: "text" as const, text: resolved.error }],
      details: { error: resolved.error },
    };
  }

  const running = resolved.running;
  const now = Date.now();
  observeRunningSubagent(running, now);

  const steer = steerSubagent(running, message, send);
  if ("error" in steer) {
    return {
      content: [{ type: "text" as const, text: steer.error }],
      details: {
        error: steer.error,
        id: running.id,
        name: running.name,
        ...(running.cohortId ? { cohortId: running.cohortId } : {}),
      },
    };
  }

  running.statusState = forceStatusAfterInterrupt(running.statusState, now);
  updateWidget();

  return {
    content: [{
      type: "text" as const,
      text:
        `Message delivered to running subagent "${running.name}". It picks this up at its next ` +
        `turn boundary. If it exits, its result still arrives as a steer message.`,
    }],
    details: {
      id: running.id,
      name: running.name,
      ...(running.cohortId ? { cohortId: running.cohortId } : {}),
      status: "steered",
    },
  };
}

function startStatusRefresh(pi: ExtensionAPI) {
  if (!isStatusEnabled() || statusInterval) return;

  const stop = () => {
    if (!statusInterval) return;
    clearInterval(statusInterval);
    statusInterval = null;
    (globalThis as any)[STATUS_INTERVAL_KEY] = null;
  };

  statusInterval = setInterval(() => {
    if ((globalThis as any)[MODULE_INSTANCE_KEY] !== moduleInstanceId || latestPi !== pi) {
      stop();
      return;
    }
    if (runtimeRegistry.list().length === 0) {
      stop();
      return;
    }

    const transitionLines: string[] = [];
    let stalledTransition = false;
    const now = Date.now();
    let shouldRefreshWidget = false;

    for (const running of runtimeRegistry.list()) {
      observeRunningSubagent(running, now);
      const { nextState, snapshot, transition } = advanceStatusState(running.statusState, now);
      if (nextState.currentKind !== running.statusState.currentKind) {
        shouldRefreshWidget = true;
      }
      running.statusState = nextState;

      if (transition && !running.interactive) {
        transitionLines.push(formatTransitionLine(running.name, snapshot, transition, widgetText));
        if (transition === "stalled") stalledTransition = true;
      }
    }

    if (shouldRefreshWidget) updateWidget();

    if (transitionLines.length > 0) {
      const capped = capStatusLines(transitionLines, statusConfig.lineLimit);
      try {
        pi.sendMessage(
          {
            customType: "subagent_status",
            content: subagentStatusEnvelope(transitionLines, statusConfig.lineLimit, widgetText),
            display: true,
            details: { lines: capped.visibleLines, overflow: capped.overflow, tone: stalledTransition ? "error" : "success" },
          },
          AGENT_QUEUE_DELIVERY,
        );
      } catch {
        stop();
      }
    }
  }, 1000);

  (globalThis as any)[STATUS_INTERVAL_KEY] = statusInterval;
}

function resolveResumeLaunchBehavior(): { autoExit: boolean; interactive: boolean } {
  return { autoExit: true, interactive: false };
}

export { needsEnvProxyForTools } from "./launch-config.ts";

export const __test__ = {
  borderLine,
  borderSegmentLine,
  isStatusEnabled,
  getShellReadyDelayMs,
  renderSubagentWidgetLines,
  renderWidgetSnapshotLines,
  loadAgentDefaults,
  discoverAgentDefinitions,
  validateResumeTarget,
  resolveEffectiveSessionMode,
  resolveLaunchBehavior,
  resolveEffectiveAutoExit,
  resolveEffectiveInteractive,
  resolveSurfaceChoice,
  validateAgentLifecycleConfig,
  buildSubagentToolAllowlist,
  subagentTaskDepth,
  canGrantSpawningToChild,
  applySandboxToParts,
  classifyToolProvisions,
  validateToolProvision,
  buildPiPromptArgs,
  observeRunningSubagent,
  getToolExtensionPath,
  steerSubagent,
  handleSubagentSteer,
  classifyWatcherFailure,
  watchMemberRound,
  canReuseMemberName,
  drainMemberMailbox,
  resolveResultPresentation,
  resolveResumeLaunchBehavior,
  buildHeadlessPrompt,
  runtimeRegistry,
  watchSubagent,
  waitForHeadlessExit,
  formatTokens,
  formatContextUsage,
  contextWindowFor,
  formatUsageSegments,
  deliverRecoveredHeadless,
  deliverRecoveredPane,
  deliverRecoveredExit,
  publishTerminalUpdate,
  widgetIcon,
};

export default function subagentsExtension(pi: ExtensionAPI, options?: SubagentsExtensionOptions) {
  configureSubagentsExtension(options ?? {});
  latestPi = pi;

  pi.on("session_start", (_event, ctx) => {
    if ((globalThis as any)[MODULE_INSTANCE_KEY] !== moduleInstanceId) return;
    latestCtx = ctx;

    widgetRuntime.tree?.dispose();
    widgetRuntime.tree = null;
    const sessionManager = ctx.sessionManager as
      | { getSessionDir?: () => string; getSessionId?: () => string }
      | undefined;
    if (
      typeof sessionManager?.getSessionDir === "function" &&
      typeof sessionManager?.getSessionId === "function"
    ) {
      const artifactDir = getArtifactDir(sessionManager.getSessionDir(), sessionManager.getSessionId());
      envelopeDelivery.loadPending(artifactDir);
      widgetRuntime.tree = createDescendantsTracker({
        rootArtifactDir: artifactDir,
        rootCwd: ctx.cwd ?? process.cwd(),
        agentConfigDir: getAgentConfigDir(),
      });
    }
    widgetRuntime.snapshot = null;
    if (ctx.hasUI) startWidgetRefresh();

    const prevAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
    if (!prevAbort || prevAbort.signal.aborted) {
      (globalThis as any)[POLL_ABORT_KEY] = new AbortController();
    }

    const healthGateway = hostOptions.modelHealth;
    if (healthGateway) {
      const loaded = loadTierRouteConfig({
        cwd: ctx.cwd,
        agentConfigDir: getAgentConfigDir(),
        injected: resolveHostTierSources(),
      });
      const union = loaded.config
        ? MODEL_TIERS.flatMap((tier) => loaded.config?.tiers[tier].pool ?? [])
        : [];
      if (union.length > 0) healthGateway.refresh(union);
    }
    recoverRuntimeSubagents(ctx, pi, startup).catch((error) => {
      debugLog("Runtime subagent recovery failed", error);
    });
  });

  pi.on("agent_before_settle", async () => {
    if ((globalThis as any)[MODULE_INSTANCE_KEY] !== moduleInstanceId) return undefined;
    const flushed = await envelopeDelivery.flushBeforeSettle(pi);
    return flushed ? { continue: true } : undefined;
  });

  pi.on("agent_settled", async (event) => {
    if ((globalThis as any)[MODULE_INSTANCE_KEY] !== moduleInstanceId) return;
    await envelopeDelivery.flushAfterSettle(event.aborted === true, pi);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if ((globalThis as any)[MODULE_INSTANCE_KEY] !== moduleInstanceId) return;
    try {
      if (ctx?.hasUI) ctx.ui.setWidget("subagent-status", undefined);
    } catch {}
    latestCtx = null;
    latestPi = null;
    widgetRuntime.tree?.dispose();
    widgetRuntime.tree = null;
    widgetRuntime.snapshot = null;
    if (widgetRuntime.interval) {
      clearInterval(widgetRuntime.interval);
      widgetRuntime.interval = null;
      (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
    }
    if (statusInterval) {
      clearInterval(statusInterval);
      statusInterval = null;
      (globalThis as any)[STATUS_INTERVAL_KEY] = null;
    }
    const moduleAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
    if (moduleAbort) moduleAbort.abort();

    hostOptions.modelErrorJournal?.clear();
    for (const agent of runtimeRegistry.list()) {
      if (agent.interactive) {

        continue;
      }
      if (agent.member) {

        killMemberProcess(agent);
        markMemberOffline(agent, "host-shutdown");
        runtimeRegistry.remove(agent.id);
        agent.abortController?.abort();
        continue;
      }

      if (agent.kind === "headless" && !agent.headlessChild && agent.pid != null) {
        terminateHeadlessProcess(agent.pid);
      }

      agent.abortController?.abort();
    }
    runtimeRegistry.clear();
  });

  const startup = createSubagentStartup({
    registry: runtimeRegistry,
    getAgentConfigDir,
    loadAgentDefaults,
    resolveHostTierSources,
    getArtifactDir,
    isMuxAvailable,
    adoptSurface,
    isPidAlive,
    terminateHeadlessProcess,
    validateResumeTarget,
    applySandboxToParts,

    validateToolProvision,
    resolveResumeLaunchBehavior,
    subagentsDir: SUBAGENTS_DIR,
    getShellReadyDelayMs,
    spawnHeadlessPi,
    createSurface,
    createSurfaceFor,
    sendCommand,
    closeSurface,
    buildHeadlessPrompt,
    startWidgetRefresh,
    startStatusRefresh,

    watchSubagent: (running, signal) =>
      withUsageRecording(watchSubagent(running, signal), running, hostOptions.recordUsage),
    watchMemberRound,
  });

  registerSubagentTools(pi, startup);
}
