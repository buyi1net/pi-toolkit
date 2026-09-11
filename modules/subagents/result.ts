import { existsSync } from "node:fs";
import {
  findLastAssistantMessage,
  getNewEntriesAsync,
  getSessionId,
  summarizeSessionStatsAsync,
  type SessionStats,
} from "./session.ts";

export interface ResultExit {
  exitCode: number;
  errorMessage?: string;
}

export interface ExtractedSubagentResult {
  summary: string;
  sessionId: string | null;
  stats: SessionStats | null;
}

export async function extractSubagentResult(
  sessionFile: string,
  exit: ResultExit,
  afterLine = 0,
  fallbackPrefix = "Sub-agent",
): Promise<ExtractedSubagentResult> {
  const fallback = exit.errorMessage
    ? `Subagent error: ${exit.errorMessage}`
    : exit.exitCode !== 0
      ? `${fallbackPrefix} exited with code ${exit.exitCode}`
      : `${fallbackPrefix} exited without output`;

  if (!existsSync(sessionFile)) {
    return { summary: fallback, sessionId: null, stats: null };
  }

  const entries = await getNewEntriesAsync(sessionFile, afterLine);
  return {
    summary: findLastAssistantMessage(entries) ?? fallback,
    sessionId: getSessionId(sessionFile),
    stats: await summarizeSessionStatsAsync(sessionFile),
  };
}
