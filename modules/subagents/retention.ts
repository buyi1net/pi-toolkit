import { existsSync, rmSync } from "node:fs";
import { debugLog } from "./diagnostics.ts";

export type RetentionPolicy = "auto" | "preserve" | "discard";

export interface RetentionInput {
  policy: RetentionPolicy;

  interactive: boolean;

  kind?: "pane" | "headless";
  cancelled: boolean;
  failed: boolean;
  handedOff: boolean;
}

export type RetentionDecision =
  | { action: "preserve"; reason: string }
  | { action: "delete"; reason: string };

export function resolveRetentionDecision(input: RetentionInput): RetentionDecision {
  if (input.handedOff) return { action: "preserve", reason: "handed-off" };
  if (input.interactive || input.kind !== "headless") {
    return { action: "preserve", reason: "pane" };
  }
  if (input.policy === "preserve") return { action: "preserve", reason: "policy=preserve" };
  if (input.policy === "discard") return { action: "delete", reason: "policy=discard" };
  if (input.cancelled) return { action: "preserve", reason: "cancelled" };
  if (input.failed) return { action: "preserve", reason: "failed" };
  return { action: "delete", reason: "auto-success" };
}

export function pendingAskSidecarPath(sessionFile: string): string {
  return `${sessionFile}.ask`;
}

export function exitSidecarPath(sessionFile: string): string {
  return `${sessionFile}.exit`;
}

export interface RetentionCleanupTarget {

  sessionFile: string;

  activityFile?: string;

  contextFiles?: string[];
}

export interface RetentionCleanupResult {

  removed: string[];

  skipped: string[];

  errors: Array<{ path: string; error: string }>;
}

export function cleanupSubagentArtifacts(target: RetentionCleanupTarget): RetentionCleanupResult {
  const askPath = pendingAskSidecarPath(target.sessionFile);
  if (existsSync(askPath)) {
    debugLog(`Subagent artifact cleanup skipped (pending ask sidecar): ${askPath}`);
    return { removed: [], skipped: [askPath], errors: [] };
  }

  const removed: string[] = [];
  const errors: RetentionCleanupResult["errors"] = [];
  const candidates = [
    target.sessionFile,
    `${target.sessionFile}.loadout.json`,
    exitSidecarPath(target.sessionFile),
    ...(target.activityFile ? [target.activityFile] : []),
    ...(target.contextFiles ?? []),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      rmSync(path, { force: true });
      removed.push(path);
    } catch (error: any) {
      errors.push({ path, error: error?.message ?? String(error) });
    }
  }
  if (errors.length > 0) {
    debugLog(
      `Subagent artifact cleanup partially failed for ${target.sessionFile}`,
      errors.map((item) => `${item.path}: ${item.error}`).join("; "),
    );
  }
  return { removed, skipped: [], errors };
}
