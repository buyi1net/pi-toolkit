import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ROUTING_INHERITANCE_CAUSES,
  ROUTING_MODEL_ORIGINS,
} from "../subagents/routing-snapshot.ts";
import {
  deriveProvider,
  USAGE_ERROR_MESSAGE_MAX,
  USAGE_TASK_LABEL_MAX,
  type UsageInheritanceCause,
  type UsageModelSource,
  type UsageRecord,
  type UsageRunEvent,
  type UsageRunTokens,
} from "./api.ts";

export function usageJournalPath(agentDir: string): string {
  return join(agentDir, "cache", "pi-toolkit", "usage", "records.jsonl");
}

export function sanitizeTaskLabel(task: string, fallback = ""): string {
  const singleLine = task.replace(/\s+/g, " ").trim();
  const label = singleLine || fallback.trim();
  if (label.length <= USAGE_TASK_LABEL_MAX) return label;
  return `${label.slice(0, USAGE_TASK_LABEL_MAX - 1)}…`;
}

function sanitizeMessage(message: string | null | undefined): string | null {
  if (!message) return null;
  const singleLine = message.replace(/\s+/g, " ").trim();
  if (!singleLine) return null;
  return singleLine.length <= USAGE_ERROR_MESSAGE_MAX
    ? singleLine
    : `${singleLine.slice(0, USAGE_ERROR_MESSAGE_MAX - 1)}…`;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function sanitizeTokens(tokens: UsageRunTokens | null | undefined): UsageRunTokens | null {
  if (!tokens) return null;
  return {
    input: num(tokens.input),
    output: num(tokens.output),
    cacheRead: num(tokens.cacheRead),
    cacheWrite: num(tokens.cacheWrite),
    costUsd: num(tokens.costUsd),
  };
}

export function createUsageRecord(
  event: UsageRunEvent,
  context: { id: string; at: number; sessionId: string | null },
): UsageRecord {
  const model = event.model?.trim() || null;
  const preferredModel = event.preferredModel?.trim() || null;
  return {
    id: context.id,
    at: context.at,

    sessionId: event.sessionId?.trim() || context.sessionId,
    sessionFile: event.sessionFile?.trim() || null,
    name: event.name,
    taskLabel: sanitizeTaskLabel(event.task, event.name),
    cohortId: event.cohortId?.trim() || null,
    agent: event.agent?.trim() || null,
    provider: deriveProvider(model),
    model,
    thinking: event.thinking?.trim() || null,
    tier: event.tier?.trim() || null,
    preferredModel,
    downgraded: preferredModel && model ? preferredModel !== model : null,

    modelSource: event.modelSource != null && ROUTING_MODEL_ORIGINS.includes(event.modelSource)
      ? event.modelSource
      : null,
    inheritanceCause:
      event.inheritanceCause != null && ROUTING_INHERITANCE_CAUSES.includes(event.inheritanceCause)
        ? event.inheritanceCause
        : null,
    durationMs: Math.max(0, Math.round(num(event.elapsedSeconds) * 1000)),
    tokens: sanitizeTokens(event.tokens),
    toolCount: typeof event.toolCount === "number" && Number.isFinite(event.toolCount) ? event.toolCount : null,
    outcome: event.outcome,
    exitCode: num(event.exitCode),
    routeErrorKind: event.routeErrorKind?.trim() || null,
    routeErrorMessage: sanitizeMessage(event.routeErrorMessage),
  };
}

export function appendUsageRecord(path: string, record: UsageRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
}

function isUsageTokens(value: unknown): value is UsageRunTokens {
  if (typeof value !== "object" || value === null) return false;
  const tokens = value as Record<string, unknown>;
  return (
    typeof tokens.input === "number" &&
    typeof tokens.output === "number" &&
    typeof tokens.cacheRead === "number" &&
    typeof tokens.cacheWrite === "number" &&
    typeof tokens.costUsd === "number"
  );
}

export function isUsageRecord(value: unknown): value is UsageRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const nullableString = (item: unknown): boolean => item === null || typeof item === "string";
  if (typeof record.id !== "string" || typeof record.at !== "number" || !Number.isFinite(record.at)) return false;
  if (typeof record.name !== "string") return false;
  if (typeof record.taskLabel !== "string") return false;
  if (record.outcome !== "completed" && record.outcome !== "failed" && record.outcome !== "cancelled") return false;
  if (!nullableString(record.sessionId)) return false;
  if (!nullableString(record.sessionFile)) return false;
  if (!nullableString(record.cohortId)) return false;
  if (!nullableString(record.agent)) return false;
  if (!nullableString(record.provider)) return false;
  if (!nullableString(record.model)) return false;
  if (!nullableString(record.thinking)) return false;
  if (!nullableString(record.tier)) return false;
  if (!nullableString(record.preferredModel)) return false;
  if (!(record.downgraded === null || typeof record.downgraded === "boolean")) return false;

  if (
    !(record.modelSource === undefined || record.modelSource === null ||
      (typeof record.modelSource === "string" &&
        (ROUTING_MODEL_ORIGINS as readonly string[]).includes(record.modelSource)))
  ) return false;
  if (
    !(record.inheritanceCause === undefined || record.inheritanceCause === null ||
      (typeof record.inheritanceCause === "string" &&
        (ROUTING_INHERITANCE_CAUSES as readonly string[]).includes(record.inheritanceCause)))
  ) return false;
  if (typeof record.durationMs !== "number" || !Number.isFinite(record.durationMs)) return false;
  if (!(record.tokens === null || isUsageTokens(record.tokens))) return false;
  if (!(record.toolCount === null || (typeof record.toolCount === "number" && Number.isFinite(record.toolCount)))) return false;
  if (typeof record.exitCode !== "number" || !Number.isFinite(record.exitCode)) return false;
  if (!nullableString(record.routeErrorKind)) return false;
  if (!nullableString(record.routeErrorMessage)) return false;
  return true;
}

export function readUsageRecords(path: string): UsageRecord[] {
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const records: UsageRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (isUsageRecord(parsed)) {
      records.push({
        ...parsed,
        modelSource: parsed.modelSource ?? null,
        inheritanceCause: parsed.inheritanceCause ?? null,
      });
    }
  }
  return records;
}
