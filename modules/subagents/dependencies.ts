import { normalizeSubagentName } from "./names.ts";

export type DependencyOutcomeStatus = "completed" | "failed" | "cancelled" | "handed-off";

export interface DependencyOutcome {
  name: string;
  status: DependencyOutcomeStatus;

  summary?: string;
  exitCode?: number;
  sessionFile?: string;
  errorMessage?: string;

  source: "watcher" | "session-file" | "launch-failure" | "dependency-blocked";
}

export interface CompletionRecord {
  name: string;

  interactive: boolean;

  member?: boolean;
  promise: Promise<DependencyOutcome>;
  settle: (outcome: DependencyOutcome) => void;
  settled: boolean;
  outcome: DependencyOutcome | null;
  settledAt: number;

  waitingOn: Set<string>;
}

const SETTLED_TTL_MS = 10 * 60_000;

const COMPLETIONS_KEY = Symbol.for("pi-subagents/dependency-completions");
const completions: Map<string, CompletionRecord> =
  ((globalThis as any)[COMPLETIONS_KEY] ??= new Map<string, CompletionRecord>());

export function normalizeDependencyName(name: string): string {
  return normalizeSubagentName(name ?? "", "");
}

export function announceCompletion(
  name: string,
  opts?: { interactive?: boolean; member?: boolean },
): CompletionRecord {
  const key = normalizeDependencyName(name);
  const existing = completions.get(key);
  if (existing && !existing.settled) return existing;

  let resolveOutcome!: (outcome: DependencyOutcome) => void;
  const promise = new Promise<DependencyOutcome>((resolve) => {
    resolveOutcome = resolve;
  });
  const record: CompletionRecord = {
    name: key,
    interactive: opts?.interactive ?? false,
    ...(opts?.member ? { member: true } : {}),
    promise,
    settle: () => {},
    settled: false,
    outcome: null,
    settledAt: 0,
    waitingOn: new Set<string>(),
  };
  record.settle = (outcome) => {
    if (record.settled) return;
    record.settled = true;
    record.outcome = outcome;
    record.settledAt = Date.now();
    resolveOutcome(outcome);
  };
  completions.set(key, record);

  const now = Date.now();
  for (const [entryKey, entry] of completions) {
    if (entry.settled && now - entry.settledAt > SETTLED_TTL_MS) completions.delete(entryKey);
  }
  return record;
}

export function getCompletionRecord(name: string): CompletionRecord | null {
  return completions.get(normalizeDependencyName(name)) ?? null;
}

export function settleCompletion(name: string, outcome: DependencyOutcome): void {
  const record = completions.get(normalizeDependencyName(name));
  record?.settle(outcome);
}

export function settleCompletionFromResult(
  name: string,
  result: { exitCode: number; summary?: string; sessionFile?: string; errorMessage?: string; handedOff?: boolean },
  opts?: { status?: DependencyOutcomeStatus; source?: DependencyOutcome["source"] },
): void {
  const status: DependencyOutcomeStatus =
    opts?.status ??
    (result.handedOff
      ? "handed-off"
      : result.exitCode !== 0 || !!result.errorMessage
        ? "failed"
        : "completed");
  settleCompletion(name, {
    name,
    status,
    ...(result.summary ? { summary: result.summary } : {}),
    exitCode: result.exitCode,
    ...(result.sessionFile ? { sessionFile: result.sessionFile } : {}),
    ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
    source: opts?.source ?? "watcher",
  });
}

export async function waitForCompletion(
  name: string,
  signal?: AbortSignal,
): Promise<DependencyOutcome> {
  const record = getCompletionRecord(name);
  if (!record) throw new Error(`No completion record registered for "${name}"`);
  if (record.settled && record.outcome) return record.outcome;
  if (signal?.aborted) throw new Error(`Aborted before waiting for dependency "${record.name}"`);
  if (!signal) return record.promise;

  let onAbort: () => void;
  const abortPromise = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error(`Aborted while waiting for dependency "${record.name}"`));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([record.promise, abortPromise]);
  } finally {
    signal.removeEventListener("abort", onAbort!);
  }
}

export function resetCompletions(): void {
  completions.clear();
}

export function findDependencyCycle(ownName: string, firstDep: string): string[] | null {
  const visited = new Set<string>();
  const queue: Array<{ name: string; path: string[] }> = [
    { name: firstDep, path: [ownName, firstDep] },
  ];
  while (queue.length > 0) {
    const { name, path } = queue.shift()!;
    if (name === ownName) return path;
    if (visited.has(name)) continue;
    visited.add(name);
    const record = completions.get(name);
    if (!record || record.settled) continue;
    for (const next of record.waitingOn) {
      queue.push({ name: next, path: [...path, next] });
    }
  }
  return null;
}

export type DependencyExceptionKind =
  | "self_dependency"
  | "unknown_dependency"
  | "interactive_dependency"
  | "member_dependency"
  | "dependency_cycle"
  | "dependency_failed"
  | "dependency_cancelled"
  | "dependency_handed_off"
  | "running_without_waiter"
  | "aborted";

export interface DependencyException {
  kind: DependencyExceptionKind;

  dependency: string;
  message: string;

  upstream?: {
    exitCode?: number;
    errorMessage?: string;
    sessionFile?: string;
  };
}

export function exceptionKindForOutcome(status: DependencyOutcomeStatus): DependencyExceptionKind {
  if (status === "failed") return "dependency_failed";
  if (status === "cancelled") return "dependency_cancelled";
  return "dependency_handed_off";
}

export function dependencyExceptionResult(exception: DependencyException): {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
} {
  return {
    content: [{ type: "text", text: exception.message }],
    details: { error: "dependency_exception", dependencyException: exception },
  };
}
