import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { closeSurface, pollForExit, readExitSidecar, type PollResult } from "./surface.ts";
import { isPidAlive, parseHeadlessSurface, terminateHeadlessProcess } from "./headless.ts";
import { isTerminalDoneActivity } from "./activity.ts";
import {
  getModuleAbortSignal,
  MODULE_INSTANCE_KEY,
  moduleInstanceId,
  observeRunningSubagent,
  resolveResultPresentation,
  runtimeRegistry,
} from "./mod.ts";
import { deliverPendingQuestion } from "./mod-members.ts";
import { getArtifactDir } from "./mod-host.ts";
import { updateWidget } from "./mod-widget.ts";
import { createParentUpdateQueue, createParentUpdateProducers, type ParentSessionUpdate } from "./parent-update-queue.ts";
import { settleCompletionFromResult } from "./dependencies.ts";
import { extractSubagentResult } from "./result.ts";
import { routeExceptionFromResult } from "./route-error.ts";
import { buildWatcherTerminal } from "./terminal.ts";
import { debugLog } from "./diagnostics.ts";
import type { RuntimeRecord } from "./registry.ts";
import type { StartedRun, SubagentStartup } from "./startup.ts";
import type { RunningSubagent, SubagentResult } from "./types.ts";

export async function waitForHeadlessExit(
  running: RunningSubagent,
  signal: AbortSignal,
): Promise<PollResult> {
  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    const child = running.headlessChild;
    if (child) {
      if (child.promptError) {
        child.kill();
        await child.exitPromise.catch(() => {});
        deliverPendingQuestion(running);
        return {
          reason: "error",
          exitCode: 1,
          errorMessage: `Headless sub-agent "${running.name}" rejected its initial prompt: ${child.promptError}`,
        };
      }
      if (child.exited) {
        const info = await child.exitPromise;

        deliverPendingQuestion(running);

        const sidecar = readExitSidecar(running.sessionFile);
        if (sidecar) return sidecar;
        if ((info.code ?? 1) !== 0) {
          return {
            reason: "error",
            exitCode: info.code ?? 1,
            errorMessage:
              `Headless sub-agent process exited with code ${info.code ?? "null"}` +
              `${info.signal ? ` (signal ${info.signal})` : ""}.`,
          };
        }
        return { reason: "done", exitCode: 0 };
      }
    } else {

      const pid = running.pid ?? parseHeadlessSurface(running.surface);
      if (pid == null || !isPidAlive(pid)) {

        deliverPendingQuestion(running);
        const sidecar = readExitSidecar(running.sessionFile);
        return sidecar ?? { reason: "done", exitCode: 0 };
      }

      if (isTerminalDoneActivity(running.activity)) {
        deliverPendingQuestion(running);
        const sidecar = readExitSidecar(running.sessionFile);
        return sidecar ?? { reason: "done", exitCode: 0 };
      }
    }

    observeRunningSubagent(running);
    deliverPendingQuestion(running);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, 1000);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

export type WatcherFailureKind = "reload-handoff" | "session-detach" | "cancelled" | "error";

export function classifyWatcherFailure(input: {
  moduleReplaced: boolean;
  moduleAbortAborted: boolean;
  watcherSignalAborted: boolean;
}): WatcherFailureKind {
  if (input.moduleReplaced) return "reload-handoff";
  if (input.moduleAbortAborted) return "session-detach";
  if (input.watcherSignalAborted) return "cancelled";
  return "error";
}

function updatePublicAgent(running: RunningSubagent, status: import("./registry.ts").PublicAgentStatus, summary?: string): void {
  runtimeRegistry.updatePublicStatus(runtimeRegistry.publicPathFor(dirname(running.runtimeFile)), running.id, status, summary);
}

async function watchHeadlessSubagent(
  running: RunningSubagent,
  signal: AbortSignal,
): Promise<SubagentResult> {
  const { startTime, sessionFile } = running;

  try {
    const result = await waitForHeadlessExit(running, AbortSignal.any([signal, getModuleAbortSignal()]));
    const elapsed = Math.floor((Date.now() - startTime) / 1000);

    const extracted = await extractSubagentResult(sessionFile, result);
    if (running.interruptRequested) {
      updatePublicAgent(running, "waiting", "Current round interrupted; context is preserved for follow-up.");
      return {
        name: running.name,
        task: running.task,
        summary: "Current round interrupted; context is preserved for follow-up.",
        sessionFile,
        exitCode: 0,
        elapsed,
        interruptedRound: true,
      };
    }

    updatePublicAgent(running, "completed", extracted.summary);
    runtimeRegistry.remove(running.id);

    try {
      running.headlessChild?.kill();
    } catch (error) {
      debugLog(`Could not dispose completed headless child ${running.surface}`, error);
    }

    return buildWatcherTerminal(running, {
      kind: "completed",
      summary: extracted.summary,
      exitCode: result.exitCode,
      ...(extracted.sessionId ? { sessionId: extracted.sessionId } : {}),
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
      ...(extracted.stats ? { stats: extracted.stats } : {}),
    }, elapsed);
  } catch (err: any) {
    const moduleWasReplaced = (globalThis as any)[MODULE_INSTANCE_KEY] !== moduleInstanceId;
    const failureKind = classifyWatcherFailure({
      moduleReplaced: moduleWasReplaced,
      moduleAbortAborted: getModuleAbortSignal().aborted,
      watcherSignalAborted: signal.aborted,
    });
    updatePublicAgent(running, "handed_off", "Subagent handed off for recovery after host reload.");
    runtimeRegistry.remove(running.id, { keepRecord: true });
    if (failureKind === "reload-handoff" || failureKind === "session-detach") {

      return buildWatcherTerminal(running, {
        kind: "handed-off",
        reason: failureKind === "reload-handoff" ? "host-reload" : "session-detach",
      }, Math.floor((Date.now() - startTime) / 1000));
    }

    const child = running.headlessChild;
    try {
      if (child) {
        if (!child.exited) child.abort();
        child.kill();
      } else if (running.pid != null) {
        terminateHeadlessProcess(running.pid);
      }
    } catch (error) {
      debugLog(`Could not kill ${failureKind === "cancelled" ? "stopped" : "failed"} headless child ${running.surface}`, error);
    }
    updatePublicAgent(running, failureKind === "cancelled" ? "interrupted" : "failed", failureKind === "cancelled" ? "Subagent interrupted." : String(err));
    runtimeRegistry.removeRecord(running.runtimeFile, running.id);
    if (failureKind === "cancelled") {
      return buildWatcherTerminal(running, { kind: "cancelled" }, Math.floor((Date.now() - startTime) / 1000));
    }
    return buildWatcherTerminal(running, { kind: "failed", error: err }, Math.floor((Date.now() - startTime) / 1000));
  }
}

export async function watchSubagent(
  running: RunningSubagent,
  signal: AbortSignal,
): Promise<SubagentResult> {
  if (running.kind === "headless") return watchHeadlessSubagent(running, signal);
  const { surface, startTime, sessionFile } = running;

  try {
    const result = await pollForExit(surface, AbortSignal.any([signal, getModuleAbortSignal()]), {
      interval: 1000,
      sessionFile,
      sentinelToken: running.sentinelToken,
      onTick() {
        observeRunningSubagent(running);
        deliverPendingQuestion(running);
      },
    });

    const elapsed = Math.floor((Date.now() - startTime) / 1000);

    const extracted = await extractSubagentResult(sessionFile, result);
    if (running.interruptRequested) {
      updatePublicAgent(running, "waiting", "Current round interrupted; context is preserved for follow-up.");
      return {
        name: running.name,
        task: running.task,
        summary: "Current round interrupted; context is preserved for follow-up.",
        sessionFile,
        exitCode: 0,
        elapsed,
        interruptedRound: true,
      };
    }
    const summary = extracted.summary;
    const stats = extracted.stats;
    const subagentSessionId = extracted.sessionId;

    updatePublicAgent(running, result.reason === "user_closed" ? "interrupted" : "completed", summary);
    runtimeRegistry.remove(running.id);

    try {
      closeSurface(surface);
    } catch (error) {

      debugLog(`Could not close completed pane ${surface}`, error);
    }

    if (running.stopRequested && result.reason === "user_closed") {
      return buildWatcherTerminal(running, { kind: "cancelled" }, elapsed);
    }
    if (result.reason === "user_closed") {
      return buildWatcherTerminal(running, { kind: "completed", summary, exitCode: result.exitCode, userClosed: true, ...(subagentSessionId ? { sessionId: subagentSessionId } : {}), ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}), ...(stats ? { stats } : {}) }, elapsed);
    }
    return buildWatcherTerminal(running, {
      kind: "completed",
      summary,
      exitCode: result.exitCode,
      ...(subagentSessionId ? { sessionId: subagentSessionId } : {}),
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
      ...(stats ? { stats } : {}),
    }, elapsed);
  } catch (err: any) {
    const moduleWasReplaced = (globalThis as any)[MODULE_INSTANCE_KEY] !== moduleInstanceId;
    const failureKind = classifyWatcherFailure({
      moduleReplaced: moduleWasReplaced,
      moduleAbortAborted: getModuleAbortSignal().aborted,
      watcherSignalAborted: signal.aborted,
    });
    const publicStatus = failureKind === "reload-handoff" || failureKind === "session-detach" ? "handed_off" : failureKind === "cancelled" ? "interrupted" : "failed";
    updatePublicAgent(running, publicStatus, failureKind === "cancelled" ? "Subagent interrupted." : failureKind === "error" ? String(err) : "Subagent handed off for recovery.");
    runtimeRegistry.remove(running.id, { keepRecord: true });
    if (failureKind === "reload-handoff" || failureKind === "session-detach") {

      return buildWatcherTerminal(running, {
        kind: "handed-off",
        reason: failureKind === "reload-handoff" ? "host-reload" : "session-detach",
      }, Math.floor((Date.now() - startTime) / 1000));
    }

    if (!running.interactive) {
      try {
        closeSurface(surface);
      } catch (error) {
        debugLog(`Could not close cancelled pane ${surface}`, error);
      }
    }
    if (!(signal.aborted && running.interactive)) {
      runtimeRegistry.removeRecord(running.runtimeFile, running.id);
    }
    if (failureKind === "cancelled") {
      return buildWatcherTerminal(running, { kind: "cancelled" }, Math.floor((Date.now() - startTime) / 1000));
    }
    return buildWatcherTerminal(running, { kind: "failed", error: err }, Math.floor((Date.now() - startTime) / 1000));
  }
}

export async function recoverRuntimeSubagents(
  ctx: { sessionManager: { getSessionId(): string; getSessionDir(): string } },
  pi: ExtensionAPI,
  startup: SubagentStartup,
): Promise<void> {
  const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), ctx.sessionManager.getSessionId());
  for (const outcome of await startup.recover(ctx, pi)) {
    if (outcome.kind === "exited") {
      await deliverRecoveredExit(outcome.record, outcome.exit, pi, artifactDir);
      continue;
    }
    if (outcome.kind === "running") {
      if (outcome.recovered === "pane") {
        deliverRecoveredPane(outcome.run, pi, artifactDir);
      } else {
        deliverRecoveredHeadless(outcome.run, pi, artifactDir);
      }
    }
  }
}

function terminalStatus(result: SubagentResult): "completed" | "failed" | "interrupted" {
  return result.userClosed || result.stopped ? "interrupted" : result.exitCode === 0 && !result.errorMessage ? "completed" : "failed";
}

export function publishTerminalUpdate(artifactDir: string, running: RunningSubagent, result: SubagentResult, updateId: string): ParentSessionUpdate {
  const producers = createParentUpdateProducers(createParentUpdateQueue(artifactDir));
  const input = {
    agent_id: running.id,
    task_name: running.name,
    status: terminalStatus(result),
    summary: result.summary || result.errorMessage || "Subagent finished.",
    update_id: updateId,
    final_text: result.summary || result.errorMessage || undefined,
  };
  return result.userClosed ? producers.surfaceClosed(input) : producers.watcherTerminal(input);
}

export function deliverSpawnTerminal(running: RunningSubagent, result: SubagentResult, pi: ExtensionAPI, deliveryId?: string, source: "spawn" | "followup" | "recovered-exit" | "recovered-headless" | "recovered-pane" = "spawn"): void {
  if (result.handedOff || result.interruptedRound) return;
  const failed = result.exitCode !== 0 || !!result.errorMessage;
  const routeException = routeExceptionFromResult(result, running.model);
  const content = resolveResultPresentation(result, running.name);
  pi.sendMessage({
    customType: "subagent_result",
    content,
    display: true,
    details: {
      name: running.name,
      task: running.task,
      agent: running.agent,
      exitCode: result.exitCode,
      elapsed: result.elapsed,
      sessionFile: result.sessionFile,
      status: result.userClosed ? "user_closed" : result.stopped ? "cancelled" : failed ? "failed" : "completed",
      ...(result.userClosed ? { userClosed: true } : {}),
      ...(running.cohortId ? { cohortId: running.cohortId } : {}),
      ...(result.sessionId ? { sessionId: result.sessionId } : {}),
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
      ...(result.stats ? { stats: result.stats } : {}),
      ...(routeException ? { routeException } : {}),
      delivery: source === "recovered-exit" ? "recovered-watcher" : `${source}-watcher`,
      ...(source.startsWith("recovered-") ? { recovered: source === "recovered-exit" ? "headless-exited" : source.slice("recovered-".length) } : {}),
      ...(deliveryId ? { delivery_id: deliveryId } : {}),
    },
  }, { triggerTurn: true, deliverAs: "steer" });
}

export async function deliverRecoveredExit(
  record: RuntimeRecord,
  exit: { exitCode: number; errorMessage?: string },
  pi: ExtensionAPI,
  artifactDir: string,
): Promise<void> {
  try {
    const extracted = await extractSubagentResult(
      record.sessionFile,
      { exitCode: exit.exitCode, ...(exit.errorMessage ? { errorMessage: exit.errorMessage } : {}) },
    );
    const elapsedForRecord = Math.max(0, Math.floor((Date.now() - record.startTime) / 1000));
    const exitResult = {
      summary: extracted.summary,
      sessionFile: record.sessionFile,
      ...(record.cohortId ? { cohortId: record.cohortId } : {}),
      ...(extracted.sessionId ? { sessionId: extracted.sessionId } : {}),
      exitCode: exit.exitCode,
      elapsed: elapsedForRecord,
      ...(exit.errorMessage ? { errorMessage: exit.errorMessage } : {}),
      ...(extracted.stats ? { stats: extracted.stats } : {}),
    };

    settleCompletionFromResult(record.name, exitResult);
    const update = publishTerminalUpdate(artifactDir, record as unknown as RunningSubagent, exitResult as SubagentResult, `recover:${record.id}:terminal`);
    deliverSpawnTerminal(record as unknown as RunningSubagent, exitResult as SubagentResult, pi, update.delivery_id, "recovered-exit");
  } catch (error) {
    debugLog(`Could not recover finished headless subagent ${record.name}`, error);
  }
}

export function deliverRecoveredHeadless(run: StartedRun, pi: ExtensionAPI, artifactDir: string): void {
  const running = run.running;
  const recoveredSource = "recovered-headless" as const;
  run.watch
    .then((result) => {
      const terminal = result as SubagentResult;
      updateWidget();
      settleCompletionFromResult(running.name, terminal);

      if (terminal.handedOff) return;
      const update = publishTerminalUpdate(artifactDir, running, terminal, `recover:${running.id}:terminal`);
      deliverSpawnTerminal(running, terminal, pi, update.delivery_id, recoveredSource);
    })
    .catch((error) => {
      updateWidget();
      settleCompletionFromResult(running.name, { exitCode: 1, errorMessage: error?.message ?? String(error) });
      const failure = { exitCode: 1, errorMessage: error?.message ?? String(error) } as SubagentResult;
      const update = publishTerminalUpdate(artifactDir, running, failure, `recover:${running.id}:terminal`);
      deliverSpawnTerminal(running, failure, pi, update.delivery_id, recoveredSource);
    });
}

export function deliverRecoveredPane(run: StartedRun, pi: ExtensionAPI, artifactDir: string): void {
  const running = run.running;
  const recoveredSource = "recovered-pane" as const;
  run.watch
    .then((result) => {
      const terminal = result as SubagentResult;
      updateWidget();

      settleCompletionFromResult(running.name, terminal, {
        ...(terminal.userClosed ? { status: "cancelled" as const } : {}),
      });

      if (terminal.handedOff) return;
      const update = publishTerminalUpdate(artifactDir, running, terminal, `recover:${running.id}:terminal`);
      deliverSpawnTerminal(running, terminal, pi, update.delivery_id, recoveredSource);
    })
    .catch((error) => {
      updateWidget();
      settleCompletionFromResult(running.name, { exitCode: 1, errorMessage: error?.message ?? String(error) });
      const failure = { exitCode: 1, errorMessage: error?.message ?? String(error) } as SubagentResult;
      const update = publishTerminalUpdate(artifactDir, running, failure, `recover:${running.id}:terminal`);
      deliverSpawnTerminal(running, failure, pi, update.delivery_id, recoveredSource);
    });
}
