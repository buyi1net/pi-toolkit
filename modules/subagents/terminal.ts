import type { RuntimeRegistry } from "./registry.ts";
import type { RunningSubagent, SubagentResult } from "./types.ts";

export const HOST_RELOAD_HANDOFF_SUMMARY =
  "Subagent handed off to recovery after host reload; it is still running and " +
  "its real result will be delivered when it finishes.";

export const SESSION_DETACH_HANDOFF_SUMMARY =
  "Subagent detached because the host session was closed or switched away; it is " +
  "still running and its real result will be recovered when this session returns.";

export type WatcherTerminal =
  | {
      kind: "completed";
      summary: string;
      exitCode: number;

      sessionId?: string | null;

      userClosed?: boolean;
      errorMessage?: string;
      stats?: SubagentResult["stats"] | null;
    }
  | { kind: "handed-off"; reason: "host-reload" | "session-detach" }
  | { kind: "cancelled" }

  | { kind: "failed"; error: unknown; sessionFile?: string };

function errorText(error: unknown): string {

  const message = (error as { message?: unknown } | null | undefined)?.message;
  return message != null ? String(message) : String(error);
}

export function buildWatcherTerminal(
  running: RunningSubagent,
  terminal: WatcherTerminal,
  elapsedSeconds: number,
): SubagentResult {
  const { name, task, sessionFile } = running;
  const cohortDetails = running.cohortId ? { cohortId: running.cohortId } : {};

  switch (terminal.kind) {
    case "completed":
      return {
        name,
        task,
        summary: terminal.summary,
        sessionFile,
        ...cohortDetails,
        ...(terminal.sessionId ? { sessionId: terminal.sessionId } : {}),
        exitCode: terminal.exitCode,
        elapsed: elapsedSeconds,
        ...(terminal.userClosed ? { userClosed: true } : {}),
        ...(terminal.errorMessage ? { errorMessage: terminal.errorMessage } : {}),
        ...(terminal.stats ? { stats: terminal.stats } : {}),
      };
    case "handed-off":
      return {
        name,
        task,
        summary:
          terminal.reason === "host-reload" ? HOST_RELOAD_HANDOFF_SUMMARY : SESSION_DETACH_HANDOFF_SUMMARY,
        exitCode: 0,
        elapsed: elapsedSeconds,
        sessionFile,
        ...cohortDetails,
        handedOff: true,
      };
    case "cancelled":
      return {
        name,
        task,
        summary: "Subagent stopped.",
        exitCode: 1,
        elapsed: elapsedSeconds,
        sessionFile,
        ...cohortDetails,
        stopped: true,
      };
    case "failed":
      return {
        name,
        task,
        summary: `Subagent error: ${errorText(terminal.error)}`,
        exitCode: 1,
        elapsed: elapsedSeconds,
        ...(terminal.sessionFile !== undefined ? { sessionFile: terminal.sessionFile } : {}),
        ...cohortDetails,
        errorMessage: errorText(terminal.error),
      };
  }
}

export function failureSettlement(
  running: RunningSubagent,
  error: unknown,
): Pick<SubagentResult, "exitCode" | "errorMessage" | "sessionFile"> {
  return {
    exitCode: 1,
    errorMessage: errorText(error),
    sessionFile: running.sessionFile,
  };
}

export interface MemberTerminalActions {
  registry: RuntimeRegistry;
  killMemberProcess(running: RunningSubagent): void;
  markMemberOffline(running: RunningSubagent, reason: string): void;
}

export function takeMemberOffline(
  running: RunningSubagent,
  reason: string,
  actions: MemberTerminalActions,
  options?: { kill?: boolean },
): void {
  if (options?.kill !== false) actions.killMemberProcess(running);
  actions.markMemberOffline(running, reason);
  actions.registry.remove(running.id);
}
