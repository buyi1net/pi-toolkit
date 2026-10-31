import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ComputerBackendTarget } from "./backend.ts";
import type { ComputerAction, ComputerErrorCode, ComputerStateId, RootRef } from "./contract.ts";

export interface ComputerActionLogEntry {

  readonly time: string;
  readonly stateId: ComputerStateId;

  readonly rootKey: string;
  readonly rootRef: RootRef;

  readonly command: ComputerAction;

  readonly target?: ComputerBackendTarget;

  readonly outcome: "ok" | ComputerErrorCode;
  readonly detail?: string;
}

export type ComputerActionLogSink = (entries: readonly ComputerActionLogEntry[]) => void | Promise<void>;

export function computerStateDir(agentDir: string): string {
  return join(agentDir, "pi-computer");
}

export function computerActionLogPath(agentDir: string): string {
  return join(computerStateDir(agentDir), "actions.jsonl");
}

export function createFileActionLog(path: string): ComputerActionLogSink {
  return (entries) => {
    if (entries.length === 0) return;
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  };
}
