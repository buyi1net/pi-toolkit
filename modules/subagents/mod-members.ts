import { dirname } from "node:path";
import { existsSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  isPidAlive,
  terminateHeadlessProcess,
} from "./headless.ts";
import {
  getNewEntries,
  getSessionId,
  type MessageEntry,
} from "./session.ts";
import { extractSubagentResult } from "./result.ts";
import { settleCompletionFromResult } from "./dependencies.ts";
import { routeExceptionFromResult } from "./route-error.ts";
import { normalizeSubagentName } from "./names.ts";
import { claimRoundSignal, claimTeamMessages, findRosterMember, rosterPath, teamRoundMarker, upsertRosterMember } from "./team.ts";
import { failureSettlement, takeMemberOffline, type MemberTerminalActions } from "./terminal.ts";
import { formatElapsed } from "./display.ts";
import type { RunningSubagent, SubagentResult } from "./types.ts";
import { getModuleAbortSignal, latestPi, moduleInstanceId, MODULE_INSTANCE_KEY, runtimeRegistry } from "./mod.ts";
import { updateWidget } from "./mod-widget.ts";
import { debugLog } from "./diagnostics.ts";

interface PendingQuestion {
  question?: unknown;
  name?: unknown;
  agent?: unknown;
}

export function killMemberProcess(running: RunningSubagent): void {
  const child = running.headlessChild;
  try {
    if (child) {
      if (!child.exited) child.abort();
      child.kill();
    } else if (running.pid != null) {
      terminateHeadlessProcess(running.pid);
    }
  } catch (error) {
    debugLog(`Could not terminate team member ${running.name}`, error);
  }
}

export function canReuseMemberName(name: string, artifactDir: string): boolean {
  const normalized = normalizeSubagentName(name, "");
  if (!normalized) return false;
  try {
    const roster = findRosterMember(rosterPath(artifactDir), normalized);
    if (!roster || roster.status !== "offline") return false;
  } catch (error) {
    debugLog(`Could not read team roster for member name reuse of ${normalized}`, error);
    return false;
  }
  return !runtimeRegistry.isNameTaken(normalized);
}

export function markMemberOffline(running: RunningSubagent, reason: string): void {
  if (!running.rosterFile) return;
  try {
    upsertRosterMember(running.rosterFile, {
      name: running.name,
      ...(running.agent ? { agent: running.agent } : {}),
      sessionFile: running.sessionFile,
      ...(running.pid != null ? { pid: running.pid } : {}),
      status: "offline",
      offlineReason: reason,
    });
  } catch (error) {
    debugLog(`Could not mark team member ${running.name} offline`, error);
  }
}

function memberTerminalActions(): MemberTerminalActions {
  return { registry: runtimeRegistry, killMemberProcess, markMemberOffline };
}

export function drainMemberMailbox(running: RunningSubagent): void {
  if (!running.rosterFile) return;
  const teamDir = dirname(running.rosterFile);
  const child = running.headlessChild;
  if (!child || child.exited) return;
  for (const message of claimTeamMessages(teamDir, running.name)) {

    if (normalizeSubagentName(message.to, "") !== normalizeSubagentName(running.name, "")) continue;
    try {
      child.steer(`[team message from "${message.from}"] ${message.text}`);
    } catch (error) {
      debugLog(`Could not inject team message to ${running.name}`, error);
    }
  }
}

export async function deliverMemberRoundResult(
  running: RunningSubagent,
  outcome: { exitCode: number; errorMessage?: string; roundSeq?: number },
): Promise<void> {
  const pi = latestPi;
  if (!pi) return;
  const elapsed = Math.floor((Date.now() - running.startTime) / 1000);
  let summary = "";
  let stats: NonNullable<SubagentResult["stats"]> | undefined;
  let sessionId: string | null = null;
  try {
    const extracted = await extractSubagentResult(
      running.sessionFile,
      { exitCode: outcome.exitCode, ...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}) },
      running.roundEntryBaseline ?? 0,
      "Team member round",
    );
    summary = extracted.summary;
    stats = extracted.stats ?? undefined;
    sessionId = extracted.sessionId;
  } catch (error) {
    debugLog(`Could not extract team member round result for ${running.name}`, error);
    summary = outcome.errorMessage ?? `Team member "${running.name}" finished its round (no extractable summary).`;
  }
  const failed = outcome.exitCode !== 0 || !!outcome.errorMessage;
  const routeException = failed ? routeExceptionFromResult({ errorMessage: outcome.errorMessage }, running.model) : undefined;
  pi.sendMessage(
    {
      customType: "subagent_result",
      content:
        `Team member "${running.name}" finished a round:\n\n${summary}`,
      display: true,
      details: {
        name: running.name,
        task: "(team member round)",
        agent: running.agent,
        exitCode: outcome.exitCode,
        elapsed,
        sessionFile: running.sessionFile,
        ...(sessionId ? { sessionId } : {}),
        status: failed ? "failed" : "completed",
        roundDelivery: "member-round",
        ...(outcome.roundSeq != null ? { roundSeq: outcome.roundSeq } : {}),
        ...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
        ...(stats ? { stats } : {}),
        ...(routeException ? { routeException } : {}),
        ...(running.cohortId ? { cohortId: running.cohortId } : {}),
      },
    },
    { triggerTurn: true, deliverAs: "steer" },
  );
}

type DispatchMarkerAssociation = "matched" | "absent" | "unreadable";
type MemberRoundConsumption = "delivered" | "not-associated" | "association-error";

const MAX_ROUND_ASSOCIATION_RETRIES = 3;

function readDispatchMarkerAssociation(
  sessionFile: string,
  baseline: number,
  roundId: string,
): DispatchMarkerAssociation {
  const marker = teamRoundMarker(roundId);
  try {
    return getNewEntries(sessionFile, baseline).some((entry) => {
      if (entry.type !== "message") return false;
      const msg = (entry as MessageEntry).message;
      if (!msg || msg.role !== "user") return false;
      return (msg.content ?? []).some(
        (block) => typeof block.text === "string" && block.text.includes(marker),
      );
    }) ? "matched" : "absent";
  } catch (error) {
    debugLog(`Could not read session entries for round association of ${sessionFile}`, error);
    return "unreadable";
  }
}

async function finalizeMemberFailure(
  running: RunningSubagent,
  reason: string,
  errorMessage: string,
  roundSeq?: number,
): Promise<void> {
  const hadRound = running.dispatchedRound === true;
  const baseline = running.roundEntryBaseline;
  running.dispatchedRound = false;
  running.dispatchedRoundId = undefined;
  running.pendingRoundSignal = undefined;
  running.roundAssociationAttempts = 0;
  takeMemberOffline(running, reason, memberTerminalActions());
  settleCompletionFromResult(running.name, failureSettlement(running, errorMessage));
  updateWidget();
  if (hadRound) {
    running.roundEntryBaseline = baseline;
    await deliverMemberRoundResult(running, {
      exitCode: 1,
      errorMessage,
      ...(roundSeq != null ? { roundSeq } : {}),
    });
  }
  running.roundEntryBaseline = undefined;
}

async function consumeDispatchedMemberRound(
  running: RunningSubagent,
  round: { seq: number },
): Promise<MemberRoundConsumption> {
  if (!running.dispatchedRound) return "not-associated";

  const association = running.dispatchedRoundId
    ? readDispatchMarkerAssociation(
        running.sessionFile,
        running.roundEntryBaseline ?? 0,
        running.dispatchedRoundId,
      )
    : "matched" as const;
  if (association === "unreadable") return "association-error";
  if (association === "absent") return "not-associated";

  running.dispatchedRound = false;
  running.dispatchedRoundId = undefined;
  if (running.rosterFile) {
    try {
      upsertRosterMember(running.rosterFile, {
        name: running.name,
        ...(running.agent ? { agent: running.agent } : {}),
        sessionFile: running.sessionFile,
        ...(running.pid != null ? { pid: running.pid } : {}),
        status: "idle",
        lastRoundAt: Date.now(),
      });
    } catch (error) {
      debugLog(`Could not mark team member ${running.name} idle`, error);
    }
  }
  await deliverMemberRoundResult(running, { exitCode: 0, roundSeq: round.seq });
  return "delivered";
}

async function handleMemberRoundSignal(
  running: RunningSubagent,
  round: { name: string; seq: number; at: number },
): Promise<"handled" | "retry" | "failed"> {
  const consumption = await consumeDispatchedMemberRound(running, round);
  if (consumption !== "association-error") {
    running.pendingRoundSignal = undefined;
    running.roundAssociationAttempts = 0;
    return "handled";
  }

  const attempts = (running.roundAssociationAttempts ?? 0) + 1;
  if (attempts < MAX_ROUND_ASSOCIATION_RETRIES) {
    running.pendingRoundSignal = round;
    running.roundAssociationAttempts = attempts;
    debugLog(
      `Deferring team member ${running.name} round ${round.seq} after unreadable session association ` +
        `(attempt ${attempts}/${MAX_ROUND_ASSOCIATION_RETRIES})`,
    );
    return "retry";
  }

  const errorMessage =
    `Could not reliably associate team member "${running.name}" round ${round.seq} with its ` +
    `dispatch marker because the session file could not be read. The member was taken offline ` +
    `instead of silently dropping the round; resume or respawn it if the work still matters.`;
  await finalizeMemberFailure(running, "round-association-failed", errorMessage, round.seq);
  return "failed";
}

export async function watchMemberRound(running: RunningSubagent, signal: AbortSignal): Promise<void> {
  const combined = AbortSignal.any([signal, getModuleAbortSignal()]);
  for (;;) {
    if (combined.aborted) return;
    const moduleWasReplaced = (globalThis as any)[MODULE_INSTANCE_KEY] !== moduleInstanceId;
    if (moduleWasReplaced) {
      takeMemberOffline(running, "host-reload", memberTerminalActions());
      return;
    }

    const child = running.headlessChild;
    if (child?.promptError) {
      const errorMessage =
        `Headless team member "${running.name}" rejected its prompt: ${child.promptError}`;
      await finalizeMemberFailure(running, "prompt-rejected", errorMessage);
      return;
    }
    const alive = child ? !child.exited : running.pid != null && isPidAlive(running.pid);
    if (!alive) {

      const round = running.pendingRoundSignal ?? claimRoundSignal(running.sessionFile);
      if (round) {
        const consumption = await consumeDispatchedMemberRound(running, round);
        running.pendingRoundSignal = undefined;
        running.roundAssociationAttempts = 0;
        if (consumption === "association-error") {
          const errorMessage =
            `Could not reliably associate team member "${running.name}" round ${round.seq} with its ` +
            `dispatch marker because the session file could not be read. The member was taken offline ` +
            `instead of silently dropping the round; resume or respawn it if the work still matters.`;
          await finalizeMemberFailure(running, "round-association-failed", errorMessage, round.seq);
          return;
        }
      }
      const unfinishedRound = running.dispatchedRound === true;
      const baseline = running.roundEntryBaseline;
      running.dispatchedRound = false;
      running.dispatchedRoundId = undefined;
      running.pendingRoundSignal = undefined;
      running.roundAssociationAttempts = 0;

      takeMemberOffline(running, "process-exited", memberTerminalActions(), { kill: false });
      if (unfinishedRound) {
        running.roundEntryBaseline = baseline;
        await deliverMemberRoundResult(running, {
          exitCode: 1,
          errorMessage: `Team member "${running.name}" process exited before finishing its in-flight round. ` +
            `Its session is preserved; resume or respawn it if the work still matters.`,
        });
      }
      running.roundEntryBaseline = undefined;
      return;
    }

    deliverPendingQuestion(running);
    drainMemberMailbox(running);

    const round = running.pendingRoundSignal ?? claimRoundSignal(running.sessionFile);
    if (round) {
      const outcome = await handleMemberRoundSignal(running, round);
      if (outcome === "failed") return;
    }

    await new Promise<void>((resolve, reject) => {
      if (combined.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        combined.removeEventListener("abort", onAbort);
        resolve();
      }, 1000);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      combined.addEventListener("abort", onAbort, { once: true });
    }).catch(() => {});
    if (combined.aborted) return;
  }
}

export function deliverPendingQuestion(running: RunningSubagent): void {
  const askFile = `${running.sessionFile}.ask`;
  const claimedAskFile = `${askFile}.${process.pid}.${randomUUID()}.processing`;
  let payload: PendingQuestion | null = null;
  try {

    renameSync(askFile, claimedAskFile);
    payload = JSON.parse(readFileSync(claimedAskFile, "utf-8")) as PendingQuestion;
  } catch (error) {
    if (existsSync(askFile)) {

      debugLog(`Could not claim question sidecar for ${running.name}`, error);
    }
  } finally {
    try {
      unlinkSync(claimedAskFile);
    } catch (error) {
      if (existsSync(claimedAskFile)) debugLog(`Could not remove claimed question sidecar for ${running.name}`, error);
    }
  }
  if (typeof payload?.question !== "string" || !payload.question.trim()) return;

  const name = running.name;
  const sessionId = existsSync(running.sessionFile) ? getSessionId(running.sessionFile) : null;
  const elapsed = Math.floor((Date.now() - running.startTime) / 1000);
  const replyHint = `\n\nReply with send_message({ target: "${name}", message: "…" }) — the target accepts an agent id, canonical task path, or unique local task name. If it has already finished, use followup_task({ target: "${name}", task: "…" }) instead.`;

  latestPi?.sendMessage(
    {
      customType: "subagent_question",
      content: `Sub-agent "${name}" asks (${formatElapsed(elapsed)}):\n\n${payload.question}${replyHint}`,
      display: true,
      details: {
        name,
        agent: running.agent,
        question: payload.question,
        ...(sessionId ? { sessionId } : {}),
      },
    },
    { triggerTurn: true, deliverAs: "steer" },
  );
}
