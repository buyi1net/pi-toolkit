import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import {
  findLastAssistantOutcome,
  getNewEntries,
  getSessionId,
  readNameRegistry,
  readSubagentLoadout,
  registerName,
  resolveNameInRegistry,
} from "./session.ts";
import { normalizeSubagentName } from "./names.ts";
import { peekExitSidecar } from "./surface.ts";
import type { StartedRun, SubagentStartup } from "./startup.ts";
import { debugLog } from "./diagnostics.ts";
import { routeExceptionFromResult, type RouteException } from "./route-error.ts";
import { baseModelRef } from "./model-health.ts";
import { subagentsTableTranslator, type SubagentsTranslate } from "./messages/index.ts";
import {
  aggregateFailoverExhaustion,
  buildModelRoutingFromSnapshot,
  describeModelRouting,
  isFailoverSwitchable,
  shouldFailoverAfterFailure,
  type ModelFailoverAttempt,
  type ModelRoutingDetails,
} from "./model-failover.ts";
import {
  announceCompletion,
  dependencyExceptionResult,
  exceptionKindForOutcome,
  findDependencyCycle,
  getCompletionRecord,
  normalizeDependencyName,
  settleCompletionFromResult,
  waitForCompletion,
  type CompletionRecord,
  type DependencyException,
  type DependencyOutcome,
} from "./dependencies.ts";
import { SubagentParams, validateSpawnText } from "./params.ts";
import { describeMcpIsolation } from "./launch-config.ts";
import { cleanupSubagentArtifacts, resolveRetentionDecision } from "./retention.ts";
import type { RuntimeRegistry } from "./registry.ts";
import type { RunningSubagent, SubagentResult } from "./types.ts";

export type WaitRelease = { kind: "escape" } | { kind: "timeout" };

export async function waitForSubagentTerminal(params: {
  watchPromise: Promise<SubagentResult>;
  running: RunningSubagent;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<SubagentResult | WaitRelease> {
  const { watchPromise, running, signal, timeoutMs } = params;
  const guarded = watchPromise.then(
    (value) => value,
    (error) => syntheticWatcherError(running, error),
  );
  if (!signal && timeoutMs == null) return guarded;
  return new Promise<SubagentResult | WaitRelease>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let onAbort: (() => void) | null = null;
    const settle = (value: SubagentResult | WaitRelease) => {
      if (timer != null) clearTimeout(timer);
      if (onAbort && signal) signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    if (signal) {
      onAbort = () => settle({ kind: "escape" });
      if (signal.aborted) {
        settle({ kind: "escape" });
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    if (timeoutMs != null) {
      timer = setTimeout(() => settle({ kind: "timeout" }), timeoutMs);
    }
    guarded.then((value) => settle(value));
  });
}

export { validateTimeoutMs } from "./startup.ts";

export interface SubagentToolDeps {

  allowlist: Set<string> | null;
  discoverAgents: () => Array<{ name: string }>;

  startup: SubagentStartup;

  muxUnavailableResult: () => any;
  getArtifactDir: (sessionDir: string, sessionId: string) => string;

  registry: RuntimeRegistry;

  canReuseMemberName?: (name: string, artifactDir: string) => boolean;
  updateWidget: () => void;
  resolveResultPresentation: (
    result: SubagentResult,
    name: string,
    options?: { sessionPreserved?: boolean },
  ) => string;

  recordModelError?: (model: string, exception: RouteException) => void;

  t?: SubagentsTranslate;
}

function syntheticWatcherError(running: RunningSubagent, error: unknown): SubagentResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    name: running.name,
    task: running.task,
    summary: `Subagent error: ${message}`,
    exitCode: 1,
    elapsed: Math.floor((Date.now() - running.startTime) / 1000),
    errorMessage: message,
    sessionFile: running.sessionFile,
    ...(running.cohortId ? { cohortId: running.cohortId } : {}),
  };
}

function applyRetentionToRunning(
  running: RunningSubagent,
  policy: "auto" | "preserve" | "discard",
  outcome: { cancelled: boolean; failed: boolean; handedOff: boolean },
): Record<string, unknown> {
  const decision = resolveRetentionDecision({
    policy,
    interactive: running.interactive,
    kind: running.kind,
    ...outcome,
  });
  if (decision.action === "delete") {
    const cleanup = cleanupSubagentArtifacts({
      sessionFile: running.sessionFile,
      ...(running.activityFile ? { activityFile: running.activityFile } : {}),
      ...(running.contextFiles?.length ? { contextFiles: running.contextFiles } : {}),
    });
    return cleanup.skipped.length > 0
      ? { policy, outcome: "preserved", reason: "pending-ask" }
      : {
          policy,
          outcome: "cleaned",
          reason: decision.reason,
          ...(cleanup.removed.length ? { removed: cleanup.removed } : {}),
          ...(cleanup.errors.length ? { errors: cleanup.errors } : {}),
        };
  }
  return { policy, outcome: "preserved", reason: decision.reason };
}

function registerDetachedLateDelivery(
  pi: ExtensionAPI,
  deps: SubagentToolDeps,
  running: RunningSubagent,
  watchPromise: Promise<SubagentResult>,
  retentionPolicy: "auto" | "preserve" | "discard",
  modelRouting?: ModelRoutingDetails | null,
): void {
  watchPromise
    .then((late) => {
      deps.updateWidget();
      if (late.interruptedRound) {
        deps.updateWidget();
        return;
      }

      settleCompletionFromResult(running.name, late, {
        ...(late.userClosed || late.stopped ? { status: "cancelled" as const } : {}),
      });

      if (late.handedOff) return;
      const failed = late.exitCode !== 0 || !!late.errorMessage;
      const retentionDetails = applyRetentionToRunning(running, retentionPolicy, {
        cancelled: !!late.userClosed || !!late.stopped,
        failed,
        handedOff: false,
      });
      const presentation = late.stopped
        ? `Sub-agent "${running.name}" was stopped explicitly (subagent_stop) after the wait had been detached — ` +
          `no result was produced. Its session is preserved; resume it with subagent_message if the task still matters.`
        : deps.resolveResultPresentation(late, running.name, {
            sessionPreserved: retentionDetails.outcome !== "cleaned",
          });

      const routingNote =
        modelRouting && !late.stopped && !late.userClosed
          ? describeModelRouting(modelRouting)
          : null;
      const content = routingNote ? `${presentation}\n\n${routingNote}` : presentation;
      const routeException = late.userClosed || late.stopped
        ? undefined
        : routeExceptionFromResult(late, running.model);
      pi.sendMessage(
        {
          customType: "subagent_result",
          content,
          display: true,
          details: {
            name: running.name,
            task: running.task,
            agent: running.agent,
            ...(running.cohortId ? { cohortId: running.cohortId } : {}),
            exitCode: late.exitCode,
            elapsed: late.elapsed,
            sessionFile: late.sessionFile,
            status: late.userClosed ? "user_closed" : late.stopped ? "cancelled" : failed ? "failed" : "completed",
            lateDelivery: "detached",
            retention: retentionDetails,
            ...(late.userClosed ? { userClosed: true } : {}),
            ...(late.sessionId ? { sessionId: late.sessionId } : {}),
            ...(late.errorMessage ? { errorMessage: late.errorMessage } : {}),
            ...(late.stats ? { stats: late.stats } : {}),
            ...(routeException ? { routeException } : {}),
            ...(modelRouting ? { modelRouting } : {}),
          },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    })
    .catch((error: any) => {
      deps.updateWidget();

      settleCompletionFromResult(running.name, {
        exitCode: 1,
        errorMessage: error?.message ?? String(error),
        sessionFile: running.sessionFile,
      });
      pi.sendMessage(
        {
          customType: "subagent_result",
          content: `Sub-agent "${running.name}" error after detached wait: ${error?.message ?? String(error)}`,
          display: true,
          details: {
            name: running.name,
            task: running.task,
            ...(running.cohortId ? { cohortId: running.cohortId } : {}),
            error: error?.message,
            lateDelivery: "detached",
          },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    });
}

const UPSTREAM_SUMMARY_LIMIT = 1600;

function buildUpstreamAppendix(outcomes: DependencyOutcome[]): string {
  const blocks = outcomes.map((outcome) => {
    const raw = (outcome.summary ?? "").trim();
    const summary =
      raw.length > UPSTREAM_SUMMARY_LIMIT
        ? raw.slice(0, UPSTREAM_SUMMARY_LIMIT) + "…(truncated)"
        : raw || "(no summary text captured)";
    return `Upstream subagent "${outcome.name}" completed:\n${summary}`;
  });
  return `[Upstream dependency results — context only, not your task]\n${blocks.join("\n\n")}`;
}

export type DependsOnResolution =
  | { ok: true; appendix: string }
  | { ok: false; appendix: ""; exception: DependencyException };

function blockedResolution(exception: DependencyException): DependsOnResolution {
  return { ok: false, appendix: "", exception };
}

function cacheDiskOutcome(dep: string, outcome: DependencyOutcome): void {
  if (!getCompletionRecord(dep)) announceCompletion(dep).settle(outcome);
}

export async function resolveDependsOn(params: {
  ownName: string;
  dependsOn: string[];
  artifactDir: string;
  registry: RuntimeRegistry;
  signal?: AbortSignal;
  ownRecord?: CompletionRecord;
}): Promise<DependsOnResolution> {
  const { ownName, dependsOn, artifactDir, registry, signal } = params;
  const completed: DependencyOutcome[] = [];
  const seen = new Set<string>();

  for (const rawEntry of dependsOn) {
    const dep = normalizeDependencyName(rawEntry ?? "");
    if (!dep) {
      return blockedResolution({
        kind: "unknown_dependency",
        dependency: "",
        message: "Invalid dependsOn entry: dependency names must be non-empty.",
      });
    }
    if (dep === ownName) {
      return blockedResolution({
        kind: "self_dependency",
        dependency: dep,
        message: `Subagent "${ownName}" cannot depend on itself — that would deadlock the launch. Remove it from dependsOn.`,
      });
    }
    if (seen.has(dep)) continue;
    seen.add(dep);

    const record = getCompletionRecord(dep);
    if (record) {

      if (record.member) {
        return blockedResolution({
          kind: "member_dependency",
          dependency: dep,
          message:
            `"${dep}" is a persistent team member (member: true) — members stay alive between rounds and have no process-level ` +
            `terminal state, so they cannot be a dependsOn target. Consume each round's steer-delivered result instead, or drop the dependency.`,
        });
      }
      if (!record.settled && record.interactive) {
        return blockedResolution({
          kind: "interactive_dependency",
          dependency: dep,
          message:
            `"${dep}" is an interactive (demo) subagent without a waitable terminal state, so it cannot be a dependsOn target. ` +
            `Consume its steer-delivered result instead, or drop the dependency.`,
        });
      }

      params.ownRecord?.waitingOn.add(dep);
      const cycle = findDependencyCycle(ownName, dep);
      if (cycle) {
        return blockedResolution({
          kind: "dependency_cycle",
          dependency: dep,
          message:
            `Dependency cycle detected: ${cycle.join(" → ")}. Sibling subagent calls in the same message cannot wait on ` +
            `each other — nothing was launched for "${ownName}". Break the cycle by removing one dependsOn edge.`,
        });
      }
      let outcome: DependencyOutcome;
      try {
        outcome = await waitForCompletion(dep, signal);
      } catch (error: any) {
        return blockedResolution({
          kind: "aborted",
          dependency: dep,
          message: `${error?.message ?? String(error)}. Nothing was launched for "${ownName}".`,
        });
      } finally {
        params.ownRecord?.waitingOn.delete(dep);
      }
      if (outcome.status !== "completed") {
        const reason: Record<string, string> = {
          dependency_failed: `Upstream subagent "${dep}" failed, so this call was NOT launched. Decide whether to respawn the upstream subagent or continue without it — do not treat this task as started.`,
          dependency_cancelled: `Upstream subagent "${dep}" was cancelled, so this call was NOT launched. Respawn or resume it first if this task still matters.`,
          dependency_handed_off: `Upstream subagent "${dep}" was handed off to recovery after a host reload and has no waitable result, so this call was NOT launched.`,
        };
        return blockedResolution({
          kind: exceptionKindForOutcome(outcome.status),
          dependency: dep,
          message: reason[exceptionKindForOutcome(outcome.status)],
          ...(outcome.exitCode !== undefined || outcome.errorMessage || outcome.sessionFile
            ? {
                upstream: {
                  ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
                  ...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
                  ...(outcome.sessionFile ? { sessionFile: outcome.sessionFile } : {}),
                },
              }
            : {}),
        });
      }
      completed.push(outcome);
      continue;
    }

    const running = registry.findByName(dep);
    if (running) {
      return blockedResolution({
        kind: "running_without_waiter",
        dependency: dep,
        message:
          `"${dep}" is running in this session but has no waitable completion record ` +
          `(its watcher started outside this session's dependency registry, e.g. after a host reload). ` +
          `Failing fast instead of waiting forever — wait for its result message or resume it explicitly, then retry this call.`,
      });
    }

    const entry = resolveNameInRegistry(artifactDir, dep);
    if (!entry) {
      return blockedResolution({
        kind: "unknown_dependency",
        dependency: dep,
        message:
          `No subagent named "${dep}" in this session — it is not running, not announced by a sibling call in this message, ` +
          `and not in the session name registry. Check the spelling, spawn it first, or drop the dependency.`,
      });
    }
    if (!entry.sessionFile || !existsSync(entry.sessionFile)) {
      return blockedResolution({
        kind: "unknown_dependency",
        dependency: dep,
        message: `"${dep}" is registered but its session file is missing (${entry.sessionFile ?? "none"}); its outcome cannot be determined.`,
      });
    }
    const loadout = readSubagentLoadout(entry.sessionFile);
    if (loadout?.member) {
      return blockedResolution({
        kind: "member_dependency",
        dependency: dep,
        message:
          `"${dep}" is a persistent team member — members stay alive between rounds and have no process-level ` +
          `terminal state, so they cannot be a dependsOn target. Consume each round's steer-delivered result instead.`,
      });
    }
    if (loadout && loadout.autoExit === false) {
      return blockedResolution({
        kind: "interactive_dependency",
        dependency: dep,
        message:
            `"${dep}" is an interactive (demo) subagent (auto-exit disabled) without a waitable terminal result, ` +
            `so it cannot be a dependsOn target.`,
      });
    }
    const exit = peekExitSidecar(entry.sessionFile);
    if (exit && (exit.exitCode !== 0 || exit.errorMessage)) {
      const outcome: DependencyOutcome = {
        name: dep,
        status: "failed",
        exitCode: exit.exitCode,
        ...(exit.errorMessage ? { errorMessage: exit.errorMessage } : {}),
        sessionFile: entry.sessionFile,
        source: "session-file",
      };
      cacheDiskOutcome(dep, outcome);
      return blockedResolution({
        kind: "dependency_failed",
        dependency: dep,
        message: `Upstream subagent "${dep}" failed in an earlier turn, so this call was NOT launched.`,
        upstream: {
          exitCode: exit.exitCode,
          ...(exit.errorMessage ? { errorMessage: exit.errorMessage } : {}),
          sessionFile: entry.sessionFile,
        },
      });
    }
    let assistantOutcome: ReturnType<typeof findLastAssistantOutcome>;
    try {
      assistantOutcome = findLastAssistantOutcome(getNewEntries(entry.sessionFile, 0));
    } catch {
      assistantOutcome = { summary: null, errorMessage: null };
    }
    if (assistantOutcome.errorMessage) {
      const outcome: DependencyOutcome = {
        name: dep,
        status: "failed",
        ...(assistantOutcome.summary ? { summary: assistantOutcome.summary } : {}),
        exitCode: 1,
        errorMessage: assistantOutcome.errorMessage,
        sessionFile: entry.sessionFile,
        source: "session-file",
      };
      cacheDiskOutcome(dep, outcome);
      return blockedResolution({
        kind: "dependency_failed",
        dependency: dep,
        message:
          `Upstream subagent "${dep}" failed in an earlier turn (${assistantOutcome.errorMessage}), ` +
          `so this call was NOT launched.`,
        upstream: {
          exitCode: 1,
          errorMessage: assistantOutcome.errorMessage,
          sessionFile: entry.sessionFile,
        },
      });
    }
    if (assistantOutcome.summary == null) {
      return blockedResolution({
        kind: "unknown_dependency",
        dependency: dep,
        message:
          `"${dep}" is registered but no final result could be read from its session file, so its outcome cannot be determined. ` +
          `It may still be running under another host; do not depend on it.`,
      });
    }
    const outcome: DependencyOutcome = {
      name: dep,
      status: "completed",
      summary: assistantOutcome.summary,
      sessionFile: entry.sessionFile,
      source: "session-file",
    };
    cacheDiskOutcome(dep, outcome);
    completed.push(outcome);
  }

  return { ok: true, appendix: completed.length > 0 ? buildUpstreamAppendix(completed) : "" };
}

export function registerSubagentTool(pi: ExtensionAPI, deps: SubagentToolDeps): void {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "CALLING CONTRACT: `agent` and a non-empty `task` are required. The task must state the concrete work and expected output. " +
      "Prefer `tier` so the configured model pool selects a valid route. If using `model`, copy the exact provider/model route " +
      "from the host model catalog (for example `my-llm/glm-5.3`); never infer a provider from a model brand name. " +
      "A unique bare model id is normalized when the catalog can identify it, and known-invalid routes are rejected with exact candidates. " +
      "Spawn a sub-agent as an independent process. " +
      "AUTONOMOUS SUBAGENTS (agents defined with auto-exit): by default they run HEADLESS — an independent background pi process with NO pane/tab — and the call BLOCKS until the sub-agent reaches a terminal state; its real result is returned directly as this tool's result, never a placeholder. " +
      "Multiple subagent calls in the SAME assistant message run in PARALLEL, and the turn continues only after all of them have settled, so batch them freely and end your turn after spawning. " +
      "VISIBLE DEMO SUBAGENTS (agents defined without auto-exit / interactive: true): the call returns immediately with only an acknowledgement; the sub-agent runs in a visible pane that belongs to the user, and the result is delivered later as a steer message that starts a new turn. Never block on a demo subagent. " +
      "ESCAPE / ABORT SEMANTICS: aborting this tool call (e.g. the user presses Escape) does NOT cancel the sub-agent — the wait is only DETACHED. The call returns a `detached` non-terminal result; the sub-agent keeps running (its session, runtime registration and dependency record are all preserved), and its real result is delivered later as a steer message, exactly once. Do not respawn a detached sub-agent. The ONLY way to actually terminate a running sub-agent early is the subagent_stop tool. " +
      "TIMEOUT (timeoutMs): optional wait bound in milliseconds (>= 1000) for the autonomous hard barrier. When it fires the call returns a structured non-terminal `timed-out` result — the sub-agent is NOT killed or cancelled, nothing is cleaned up and no summary is fabricated; it behaves exactly like an Escape-detach, and the real result arrives later as a single steer message. DependsOn consumers keep waiting for the real terminal state (the timeout covers the post-launch run wait only). Omit timeoutMs to wait indefinitely (existing behavior); refused for interactive agents. Siblings in the same message each return their own tool result — a timed-out call is not a batch summary. " +
      "PERSISTENT TEAM MEMBERS (member: true): spawns a long-lived headless team member instead of a one-shot sub-agent. The call returns an immediate ack (no hard barrier); the member stays alive between rounds, receives follow-up rounds via team_dispatch, and each round's result is delivered once as a steer message. Members may fire-and-forget message each other via team_send along the profile's peer-send ACL. Refused combinations: surface 'pane', interactive agents, retention 'discard', timeoutMs, dependsOn. Members cannot be dependsOn targets. Terminate a member explicitly with subagent_stop; host shutdown or /reload terminates members and marks them offline (session preserved for explicit resume). " +
      "surface parameter: 'auto' (default — headless for autonomous, visible pane for interactive), 'background' (force headless; refused for interactive agents), 'pane' (force a visible pane). " +
      "RETENTION parameter: 'auto' (default) | 'preserve' | 'discard' — controls what happens to a headless autonomous sub-agent's session artifacts (session JSONL, .loadout.json, context task/system-prompt files, activity/runtime registration) AFTER this call has settled with the real result. 'auto': successful runs are cleaned up; failed/cancelled/handed-off runs are preserved so you can resume them with subagent_message. 'preserve': always keep everything. 'discard': always clean up after a terminal state, including failures — use when you know you will never resume. Visible pane / demo sub-agents are ALWAYS preserved regardless. Cleanup never affects the tool result." +
      "tier parameter: 'fast' | 'balanced' | 'flagship' preset resolved from the pi-subagents config (ordered candidate pools models.fast/balanced/flagship — arrays where the first entry is the preferred model; aliases quick/balance/standard/deep/strong accepted). Candidates are tried in configured order: candidates that verifiably lack a capability required by the agent profile (frontmatter `capabilities`) or do not support the resolved thinking level are skipped in favor of later candidates, as are candidates whose provider is known (from the last runtime status refresh) to have exhausted its quota, be offline, or be persistently unstable; unknown/unconfirmed status never blocks a candidate. FAILOVER: if the actually-launched candidate dies on a TRANSIENT route error (rate limit / overload / timeout / temporary 5xx) before doing any work (zero tool calls), the call automatically retries the next untried candidate — each candidate at most once, in configured order, with the overall timeoutMs budget covering all attempts; parameter/credential/quota/context errors are NOT auto-retried. The tool result records the preferred model, the actual model, and the downgrade reason in details.modelRouting; if every candidate fails, a clear aggregated per-attempt error is returned. An explicit `model` always wins over `tier` (and is verified, never swapped — no failover); a tier without a configured candidate pool inherits the parent session model when available; without a parent model it fails clearly — models are never silently swapped. " +
      "DEPENDENCIES (dependsOn): pass `dependsOn: [names]` to make this call WAIT for those same-session subagents to reach a terminal state BEFORE launching — including siblings issued in the SAME assistant message (the dependent call waits on the upstream completion promise; independent siblings still run in parallel). " +
      "When all dependencies completed, a short real-results context block is appended to `task`. If any dependency failed or was cancelled, this call does NOT launch and the tool result details carry a structured `dependencyException` (kind, dependency, upstream error) — no pane/process is created. " +
      "Rejected without launching: this call's own name, unknown names (not running, not announced by a sibling, not in the session registry), running-without-waiter (e.g. after a host reload), and interactive demo subagents (no waitable terminal state). Dependencies finished in an earlier turn are resolved from the session registry. " +
      "ROUTE FAILURES: when a sub-agent dies on quota/auth/rate-limit/model/context errors, the tool result details carry a structured `route_exception` (kind, retryable, provider/model, suggestedActions) for YOU to decide on. Tier-pool launches auto-switch candidates ONLY for transient errors with zero progress (see the tier parameter); for everything else there is no automatic fallback — sibling subagents keep running, and you choose whether to respawn (same or different model) or report to the user. " +
      "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. If you need a deliberate one-time diagnostic snapshot, use subagent_inspect; do not call it repeatedly just to wait. " +
      "DO NOT fabricate, assume, or summarize results you do not yet have. " +
      "PANE SAFETY: you may freely create panes and read from or send keys to panes when the task requires it; but NEVER close or kill a pane you did not create yourself — before terminating any pane, verify it is yours (spawned by you in this session) or ask the user. Panes you did not create may belong to the user or other agents and may hold running work. " +
      "After spawning, either end your turn immediately, or work on other independent tasks (including spawning more subagents in parallel). The harness handles delivery for you.",
    promptSnippet:
      "Call with both required fields: agent=<available agent> and task=<non-empty concrete work request>. Prefer tier for model-pool routing; if model is supplied, use the exact provider/model route from the catalog and do not infer a provider from the brand. " +
      "Autonomous subagents run headless and return their real result; demo subagents run in a pane and deliver results later. Do not poll or fabricate results.",
    parameters: SubagentParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!params || typeof params !== "object") {
        return {
          content: [{ type: "text", text: "Invalid subagent parameters: provide an agent and a non-empty task." }],
          details: { error: "invalid parameters" },
          isError: true,
        };
      }
      const currentAgent = process.env.PI_SUBAGENT_AGENT;
      if (params.agent && currentAgent && params.agent === currentAgent) {
        return {
          content: [{
            type: "text",
            text: `You are the ${currentAgent} agent — do not start another ${currentAgent}. You were spawned to do this work yourself. Complete the task directly.`,
          }],
          details: { error: "self-spawn blocked" },
          isError: true,
        };
      }

      const permittedAgents = deps.allowlist
        ? [...deps.allowlist]
        : deps.discoverAgents().map((agent) => agent.name);
      const permittedSet = new Set(permittedAgents);
      const permittedList = permittedAgents.join(", ") || "(none)";

      if (!params.agent) {
        return {
          content: [{
            type: "text",
            text: `You must specify which agent to spawn via the "agent" field. Available agents: ${permittedList}.`,
          }],
          details: { error: "agent required" },
          isError: true,
        };
      }
      if (!permittedSet.has(params.agent)) {
        return {
          content: [{
            type: "text",
            text:
              `You may not spawn the "${params.agent}" agent — it is not ` +
              `${deps.allowlist ? "in your allowlist" : "a known agent"}. ` +
              `Available agents: ${permittedList}.`,
          }],
          details: { error: deps.allowlist ? "agent not in allowlist" : "unknown agent" },
          isError: true,
        };
      }

      const taskError = validateSpawnText("task", params.task);
      if (taskError) {
        return {
          content: [{ type: "text", text: taskError }],
          details: { error: "task required" },
          isError: true,
        };
      }

      const planned = deps.startup.planSpawn(params, ctx);
      if (planned.kind === "error") {
        if (planned.muxUnavailable) return deps.muxUnavailableResult();
        return {
          content: [{ type: "text", text: planned.error }],
          details: planned.details ?? { error: planned.error },
          isError: true,
        };
      }
      const plan = planned.plan;

      const mcpNote = plan.toolAllowlist !== undefined ? describeMcpIsolation(plan.toolAllowlist) : null;
      const timeoutMs = params.timeoutMs ?? null;

      const parentArtifactDir = deps.getArtifactDir(
        ctx.sessionManager.getSessionDir(),
        ctx.sessionManager.getSessionId(),
      );
      let reservedName: string | null = null;
      const suppliedName = params.name?.trim();
      if (!suppliedName) {
        const registryNames = new Set(Object.keys(readNameRegistry(parentArtifactDir)));
        params.name = deps.registry.uniqueName(normalizeSubagentName(params.agent), registryNames);
        reservedName = params.name;
        deps.registry.reserveName(reservedName);
      } else {
        params.name = normalizeSubagentName(suppliedName);
        const registeredEntry = resolveNameInRegistry(parentArtifactDir, params.name);

        const memberNameReuse =
          params.member === true &&
          !!registeredEntry &&
          (deps.canReuseMemberName?.(params.name, parentArtifactDir) ?? false);
        const clash =
          deps.registry.isNameTaken(params.name) ||
          (Boolean(registeredEntry) && !memberNameReuse);
        if (clash) {
          const reuseHint = registeredEntry && !memberNameReuse
            ? params.member === true
              ? ` ("${params.name}" is not an offline team member in this session's roster; pick another name.)`
              : ` (to restart the offline team member "${params.name}", spawn it with member: true.)`
            : "";
          const error = `Subagent name "${params.name}" is already in use in this session.${reuseHint} Pick another name.`;
          return { content: [{ type: "text", text: error }], details: { error }, isError: true };
        }
        reservedName = params.name;
        deps.registry.reserveName(reservedName);
      }

      let running: RunningSubagent;
      let started: StartedRun;
      try {

        const ownRecord = announceCompletion(params.name, {
          interactive: plan.interactive,
          ...(plan.member ? { member: true } : {}),
        });

        if (params.dependsOn?.length) {
          const resolution = await resolveDependsOn({
            ownName: params.name,
            dependsOn: params.dependsOn,
            artifactDir: parentArtifactDir,
            registry: deps.registry,
            signal,
            ownRecord,
          });
          if (!resolution.ok) {

            ownRecord.settle({
              name: params.name,
              status: "failed",
              errorMessage: resolution.exception.message,
              source: "dependency-blocked",
            });
            return dependencyExceptionResult(resolution.exception);
          }
          if (resolution.appendix) {
            params.task = `${params.task}\n\n${resolution.appendix}`;
          }
        }
        started = await deps.startup.spawn(plan, ctx, pi);

        running = started.running;
        if (plan.cohortId) running.cohortId = plan.cohortId;
      } catch (error: any) {

        settleCompletionFromResult(params.name, {
          exitCode: 1,
          errorMessage: error?.message ?? String(error),
        }, { source: "launch-failure" });
        throw error;
      } finally {
        if (reservedName) deps.registry.releaseName(reservedName);
      }

      registerName(parentArtifactDir, running.name, {
        sessionFile: running.sessionFile,
        sessionId: getSessionId(running.sessionFile),
        ...(running.cohortId ? { cohortId: running.cohortId } : {}),
        ...(running.anchoredLoadout ? { anchored: true } : {}),
      });

      if (running.member) {
        running.dispatchedRound = true;
        running.roundEntryBaseline = 0;

        Promise.resolve(started.watch).catch((error) => {
          debugLog(`Team member round watcher failed for ${running.name}`, error);
        });
        return {
          content: [{
            type: "text",
            text:
              `Team member "${params.name}" launched and is now running its FIRST round in the background. ` +
              `Do NOT generate or assume results — each round's real result is delivered as a steer message exactly once when it ends. ` +
              `Dispatch follow-up rounds with team_dispatch({ name: "${params.name}", task: "…" }); ` +
              `members can message each other via team_send when the profile's peer-send ACL allows it; ` +
              `stop the member explicitly with subagent_stop.`,
          }],
          details: {
            id: running.id,
            name: params.name,
            task: params.task,
            agent: params.agent,
            ...(running.cohortId ? { cohortId: running.cohortId } : {}),
            sessionFile: running.sessionFile,
            status: "member-started",
            member: true,
            ...(mcpNote ? { mcp: mcpNote } : {}),
            ...(plan.tierConfigProblems ? { configProblems: [...plan.tierConfigProblems] } : {}),
          },
        };
      }

      if (running.interactive) {
        const interactiveRouting: ModelRoutingDetails | null = buildModelRoutingFromSnapshot(
          running.modelRouting,
          { actualModel: running.model ?? null },
        );
        const interactiveWatch = started.watch as Promise<SubagentResult>;
        running.watchPromise = interactiveWatch;
        interactiveWatch
          .then((result) => {
            if (result.interruptedRound) return;
            deps.updateWidget();

            settleCompletionFromResult(running.name, result, {
              ...(result.userClosed ? { status: "cancelled" as const } : {}),
            });

            if (result.handedOff) return;
            const presentation = deps.resolveResultPresentation(result, running.name);

            const interactiveRoutingNote =
              !result.userClosed && !result.stopped && interactiveRouting
                ? describeModelRouting(interactiveRouting)
                : null;
            const content = interactiveRoutingNote
              ? `${presentation}\n\n${interactiveRoutingNote}`
              : presentation;
            const routeException = result.userClosed
              ? undefined
              : routeExceptionFromResult(result, running.model);
            pi.sendMessage(
              {
                customType: "subagent_result",
                content,
                display: true,
                details: {
                  name: running.name,
                  task: running.task,
                  agent: running.agent,
                  ...(running.cohortId ? { cohortId: running.cohortId } : {}),
                  exitCode: result.exitCode,
                  elapsed: result.elapsed,
                  sessionFile: result.sessionFile,
                  status: result.userClosed ? "user_closed" : result.exitCode !== 0 || result.errorMessage ? "failed" : "completed",
                  ...(result.userClosed ? { userClosed: true } : {}),
                  ...(result.sessionId ? { sessionId: result.sessionId } : {}),
                  ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
                  ...(result.stats ? { stats: result.stats } : {}),
                  ...(routeException ? { routeException } : {}),
                  ...(interactiveRouting ? { modelRouting: interactiveRouting } : {}),
                },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          })
          .catch((error) => {
            deps.updateWidget();
            settleCompletionFromResult(running.name, { exitCode: 1, errorMessage: error?.message ?? String(error) });

            pi.sendMessage(
              {
                customType: "subagent_result",
                content: `Sub-agent "${running.name}" error: ${error?.message ?? String(error)}`,
                display: true,
                details: {
                  name: running.name,
                  task: running.task,
                  ...(running.cohortId ? { cohortId: running.cohortId } : {}),
                  error: error?.message,
                },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          });

        return {
          content: [{
            type: "text",
            text:
              `Sub-agent "${params.name}" launched and is now running in the background. ` +
              `Do NOT generate or assume any results — you have no idea what the sub-agent will do or produce. ` +
              `The results will be delivered to you automatically as a steer message when the sub-agent finishes. ` +
              `Until then, move on to other work or tell the user you're waiting.`,
          }],
          details: {
            id: running.id,
            name: params.name,
            task: params.task,
            agent: params.agent,
            ...(running.cohortId ? { cohortId: running.cohortId } : {}),
            sessionFile: running.sessionFile,
            status: "started",
            ...(mcpNote ? { mcp: mcpNote } : {}),
            ...(plan.tierConfigProblems ? { configProblems: [...plan.tierConfigProblems] } : {}),
          },
        };
      }

      const retentionPolicy = params.retention ?? "auto";
      const waitDeadline = timeoutMs != null ? Date.now() + timeoutMs : null;

      const routingSnapshot = running.modelRouting ?? null;
      const failoverBase =
        routingSnapshot?.tier != null &&
        routingSnapshot.pool != null &&
        routingSnapshot.pool.length > 0 &&
        routingSnapshot.fallbackReason == null
          ? {
              tier: routingSnapshot.tier,
              pool: routingSnapshot.pool,
              preferred: routingSnapshot.preferred ?? routingSnapshot.pool[0]!,
            }
          : null;
      const failoverAttempts: ModelFailoverAttempt[] = [];
      const failedCandidates = new Set<string>();
      let activePlan = plan;
      let attemptIndex = 1;

      const buildAttemptModelRouting = (): ModelRoutingDetails | null =>
        buildModelRoutingFromSnapshot(routingSnapshot, {
          actualModel: running.model ?? null,
          attempts: failoverAttempts,
        });

      for (;;) {
      const watchPromise = started.watch as Promise<SubagentResult>;
      running.watchPromise = watchPromise;

      const raced = await waitForSubagentTerminal({
        watchPromise,
        running,
        signal,

        timeoutMs: waitDeadline != null ? Math.max(0, waitDeadline - Date.now()) : undefined,
      });
      if (typeof raced === "object" && "kind" in raced) {
        running.waitReleased = raced.kind;
        deps.registry.markWaitReleased(running.runtimeFile, running.id, raced.kind);

        const releaseRouting = buildAttemptModelRouting();
        registerDetachedLateDelivery(
          pi,
          deps,
          running,
          watchPromise,
          retentionPolicy,
          releaseRouting,
        );
        if (raced.kind === "timeout") {
          return {
            content: [{
              type: "text",
              text:
                `Sub-agent "${running.name}" wait timed out after ${Math.round(timeoutMs! / 1000)}s (timeoutMs) — this is NOT a result. ` +
                `The sub-agent itself is STILL RUNNING and was NOT cancelled, and no summary exists yet — do not assume or fabricate one. ` +
                `Its real result will be delivered as a steer message when it finishes, exactly once. ` +
                `Do not respawn it. You can steer it meanwhile (subagent_message), stop it (subagent_stop), or simply wait. ` +
                `Sibling calls in this message each return their own tool result; this is not a batch summary.`,
            }],
            details: {
              id: running.id,
              name: running.name,
              task: running.task,
              agent: running.agent,
              ...(running.cohortId ? { cohortId: running.cohortId } : {}),
              sessionFile: running.sessionFile,
              elapsed: Math.floor((Date.now() - running.startTime) / 1000),
              timeoutMs,
              status: "timed-out",
              ...(releaseRouting ? { modelRouting: releaseRouting } : {}),
            },
          };
        }
        return {
          content: [{
            type: "text",
            text:
              `Sub-agent "${running.name}" was DETACHED: your tool-call wait was aborted (Escape), but the sub-agent ` +
              `itself is STILL RUNNING and was NOT cancelled — no result exists yet, so do not assume or fabricate one. ` +
              `Its real result will be delivered as a steer message when it finishes, exactly once. ` +
              `Do not respawn it. You can still steer it meanwhile (subagent_message) or stop it explicitly (subagent_stop).`,
          }],
          details: {
            id: running.id,
            name: running.name,
            task: running.task,
            agent: running.agent,
            ...(running.cohortId ? { cohortId: running.cohortId } : {}),
            sessionFile: running.sessionFile,
            elapsed: Math.floor((Date.now() - running.startTime) / 1000),
            status: "detached",
            ...(releaseRouting ? { modelRouting: releaseRouting } : {}),
          },
        };
      }
      const result: SubagentResult = raced;
      if (result.interruptedRound) {
        deps.updateWidget();
        return {
          content: [{ type: "text", text: `Sub-agent "${running.name}" current round interrupted; context is preserved for followup_task.` }],
          details: {
            id: running.id,
            name: running.name,
            task: running.task,
            sessionFile: running.sessionFile,
            status: "waiting",
            interrupted: true,
          },
        };
      }

      if (failoverBase) {
        const cancelledNow =
          started.signal.aborted || !!result.userClosed || !!result.stopped;
        const routeExceptionNow = cancelledNow
          ? undefined
          : routeExceptionFromResult(result, running.model);
        const untried = failoverBase.pool.filter(
          (candidate) => !failedCandidates.has(baseModelRef(candidate)),
        ).length;

        const failedModel =
          running.model ?? activePlan.effectiveModel ?? failoverBase.preferred;
        if (routeExceptionNow && isFailoverSwitchable(routeExceptionNow.kind) && deps.recordModelError) {
          deps.recordModelError(failedModel, routeExceptionNow);
        }
        const decision = shouldFailoverAfterFailure({
          result: {
            stopped: !!result.stopped,
            userClosed: !!result.userClosed,
            handedOff: !!result.handedOff,
          },
          routeException: routeExceptionNow,
          toolCount: result.stats?.toolCount ?? null,
          waitBudgetMs: waitDeadline != null ? waitDeadline - Date.now() : null,
          untriedCandidates: untried,
        });
        if (decision.failover) {

          failoverAttempts.push({
            index: attemptIndex,
            model: failedModel,
            kind: routeExceptionNow?.kind ?? "unknown",
            message: result.errorMessage ?? routeExceptionNow?.message ?? "unknown error",
            elapsedSeconds: result.elapsed,
          });
          failedCandidates.add(baseModelRef(failedModel));
          applyRetentionToRunning(running, retentionPolicy, {
            cancelled: false,
            failed: true,
            handedOff: false,
          });

          const replan = deps.startup.planSpawn(params, ctx, { excludeModels: failedCandidates });
          if (replan.kind === "error") {
            const aggregated = aggregateFailoverExhaustion({
              tier: failoverBase.tier,
              pool: failoverBase.pool,
              attempts: failoverAttempts,
              remainingError: replan.error,
            });
            settleCompletionFromResult(
              running.name,
              {
                exitCode: 1,
                summary: aggregated,
                sessionFile: running.sessionFile,
                errorMessage: aggregated,
              },
              { source: "watcher" },
            );
            const finalRetention = applyRetentionToRunning(running, retentionPolicy, {
              cancelled: false,
              failed: true,
              handedOff: false,
            });
            const aggregatedRouting = buildAttemptModelRouting();
            return {
              content: [{ type: "text", text: aggregated }],
              details: {
                id: running.id,
                name: running.name,
                task: running.task,
                agent: running.agent,
                ...(running.cohortId ? { cohortId: running.cohortId } : {}),
                sessionFile: running.sessionFile,
                exitCode: 1,
                elapsed: result.elapsed,
                status: "failed",
                retention: finalRetention,
                errorMessage: aggregated,
                ...(result.sessionId ? { sessionId: result.sessionId } : {}),
                ...(result.stats ? { stats: result.stats } : {}),
                ...(routeExceptionNow ? { routeException: routeExceptionNow } : {}),
                ...(aggregatedRouting ? { modelRouting: aggregatedRouting } : {}),
              },
            };
          }
          activePlan = replan.plan;

          deps.registry.reserveName(running.name);
          let nextStarted: StartedRun;
          try {
            nextStarted = await deps.startup.spawn(activePlan, ctx, pi);
          } catch (error: any) {

            settleCompletionFromResult(
              running.name,
              { exitCode: 1, errorMessage: error?.message ?? String(error) },
              { source: "launch-failure" },
            );
            throw error;
          } finally {
            deps.registry.releaseName(running.name);
          }
          if (activePlan.cohortId) nextStarted.running.cohortId = activePlan.cohortId;

          registerName(parentArtifactDir, nextStarted.running.name, {
            sessionFile: nextStarted.running.sessionFile,
            sessionId: getSessionId(nextStarted.running.sessionFile),
            ...(nextStarted.running.cohortId ? { cohortId: nextStarted.running.cohortId } : {}),
            ...(nextStarted.running.anchoredLoadout ? { anchored: true } : {}),
          });
          running = nextStarted.running;
          started = nextStarted;
          attemptIndex += 1;

          deps.updateWidget();
          continue;
        }
      }

      const userClosed = !!result.userClosed;
      const cancelled = started.signal.aborted || userClosed || !!result.stopped;
      const failed = result.exitCode !== 0 || !!result.errorMessage;
      const routeException = cancelled ? undefined : routeExceptionFromResult(result, running.model);

      settleCompletionFromResult(running.name, result, {
        ...(cancelled ? { status: "cancelled" as const } : {}),
      });

      const retentionDetails = applyRetentionToRunning(running, retentionPolicy, {
        cancelled,
        failed,
        handedOff: !!result.handedOff,
      });
      if (result.handedOff) {

        const handoffRouting = buildAttemptModelRouting();
        return {
          content: [{
            type: "text",
            text:
              `Sub-agent "${running.name}" was handed off to recovery because the host was reloaded (/reload). ` +
              `It is still running; its real result will be delivered as a steer message when it finishes. ` +
              `Do not treat this as a failure and do not spawn a replacement.`,
          }],
          details: {
            id: running.id,
            name: running.name,
            task: running.task,
            agent: running.agent,
            ...(running.cohortId ? { cohortId: running.cohortId } : {}),
            sessionFile: result.sessionFile,
            elapsed: result.elapsed,
            status: "handed-off",
            retention: retentionDetails,
            ...(handoffRouting ? { modelRouting: handoffRouting } : {}),
          },
        };
      }

      const modelRouting = buildAttemptModelRouting();
      const routingNote = modelRouting ? describeModelRouting(modelRouting) : null;
      const presentation = deps.resolveResultPresentation(result, running.name, {
        sessionPreserved: retentionDetails.outcome !== "cleaned",
      });
      const presentationWithRouting = routingNote ? `${presentation}\n\n${routingNote}` : presentation;
      return {
        content: [{
          type: "text",
          text: userClosed
            ? `Sub-agent "${running.name}" was closed by the user: its pane is gone and no result was produced. ` +
              `This is not a provider or agent error. Its session is preserved; resume it with ` +
              `subagent_message({ name: "${running.name}", message: "…" }) if the task still matters.`
            : cancelled
            ? retentionDetails.outcome === "cleaned"
              ? `Sub-agent "${running.name}" was stopped before finishing — no result was produced. ` +
                `Its session artifacts were cleaned up (retention: ${retentionPolicy}).`
              : `Sub-agent "${running.name}" was stopped before finishing — no result was produced. ` +
                `Its session is preserved; resume it with subagent_message({ name: "${running.name}", message: "…" }) if needed.`
            : presentationWithRouting,
        }],
        details: {
          id: running.id,
          name: running.name,
          task: running.task,
          agent: running.agent,
          ...(running.cohortId ? { cohortId: running.cohortId } : {}),
          sessionFile: result.sessionFile,
          exitCode: result.exitCode,
          elapsed: result.elapsed,
          status: userClosed ? "user_closed" : cancelled ? "cancelled" : failed ? "failed" : "completed",
          retention: retentionDetails,
          ...(userClosed ? { userClosed: true } : {}),
          ...(result.sessionId ? { sessionId: result.sessionId } : {}),
          ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
          ...(result.stats ? { stats: result.stats } : {}),
          ...(routeException ? { routeException } : {}),
          ...(modelRouting ? { modelRouting } : {}),
          ...(mcpNote ? { mcp: mcpNote } : {}),
          ...(plan.tierConfigProblems ? { configProblems: [...plan.tierConfigProblems] } : {}),
        },
      };
      }
    },

    renderCall(args, theme) {
      const partialArgs = args as Record<string, unknown>;
      const agentName = typeof partialArgs.agent === "string" && partialArgs.agent ? partialArgs.agent : "";
      const name = typeof partialArgs.name === "string" && partialArgs.name ? partialArgs.name : agentName || "(unnamed)";
      const task = typeof partialArgs.task === "string" ? partialArgs.task : "";
      const cwdHint = typeof partialArgs.cwd === "string" && partialArgs.cwd ? theme.fg("dim", ` in ${partialArgs.cwd}`) : "";
      let text = theme.fg("toolTitle", theme.bold(deps.t?.("module.subagents.tool.subagent.display") ?? "Run subagent")) + " " + theme.fg("accent", name) + cwdHint;
      if (task) {
        const firstLine = task.split("\n").find((line: string) => line.trim()) ?? "";
        const preview = firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
        if (preview) text += "\n" + theme.fg("toolOutput", preview);
        const totalLines = task.split("\n").length;
        if (totalLines > 1) text += theme.fg("muted", ` (${totalLines} lines)`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, options, theme) {
      const details = result.details as any;
      const t = deps.t ?? subagentsTableTranslator("en");
      if (details?.status === "started") {
        if (!options.expanded) return new Text("", 0, 0);
        return new Text(theme.fg("toolOutput", t("module.subagents.tool.subagent.result.started")), 0, 0);
      }
      if (details?.status === "member-started") {
        if (!options.expanded) return new Text("", 0, 0);
        return new Text(theme.fg("toolOutput", t("module.subagents.tool.subagent.result.memberStarted")), 0, 0);
      }
      if (details?.status === "handed-off") {
        return new Text(theme.fg("toolOutput", t("module.subagents.tool.subagent.result.handedOff")), 0, 0);
      }
      if (details?.status === "detached") {
        return new Text(theme.fg("toolOutput", t("module.subagents.tool.subagent.result.detached")), 0, 0);
      }
      if (details?.status === "user_closed") {
        return new Text(theme.fg("warning", t("module.subagents.tool.subagent.result.closedByUser")), 0, 0);
      }
      if (details?.status === "timed-out") {
        return new Text(theme.fg("warning", t("module.subagents.tool.subagent.result.timedOut")), 0, 0);
      }
      if (details?.status === "completed" || details?.status === "failed" || details?.status === "cancelled") {
        if (details.status === "completed" && !options.expanded) return new Text("", 0, 0);
        const label = details.status === "completed"
          ? t("module.subagents.widget.result.completed")
          : details.status === "cancelled"
            ? t("module.subagents.widget.result.cancelled")
            : t("module.subagents.widget.result.failed");
        return new Text(theme.fg(details.status === "failed" ? "error" : details.status === "cancelled" ? "warning" : "toolOutput", label), 0, 0);
      }
      const content = result.content[0];
      const text = content && content.type === "text" ? content.text : "";
      return new Text(theme.fg("error", text), 0, 0);
    },
  });
}
