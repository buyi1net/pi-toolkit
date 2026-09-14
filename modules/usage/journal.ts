// 统计日志：模型与用量快照的持久层（工单 28）。
//
// 格式是 append-only JSONL：每条运行记录一行，只追加、不重写。
// - 并发安全：同一进程内同步 append 不互相覆盖；跨进程（多个 pi 会话共享
//   agentDir）靠 O_APPEND 的单行原子追加，各写各的行，绝不 read-modify-write
//   整文件；读侧容忍半行/坏行（跨进程中断留下的残行只是被跳过）。
// - reload 重建：/reload 后新模块实例直接读同一个文件，记录不依赖内存。
// - 隐私：任务正文先折叠成单行、截到 USAGE_TASK_LABEL_MAX（≤80 字符时就是
//   全量标识），不存在完整任务正文的第二份存储。

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  deriveProvider,
  USAGE_ERROR_MESSAGE_MAX,
  USAGE_TASK_LABEL_MAX,
  type UsageRecord,
  type UsageRunEvent,
  type UsageRunTokens,
} from "./api.ts";

/** 统计日志路径：<agentDir>/cache/pi-toolkit/usage/records.jsonl（运行时可重建） */
export function usageJournalPath(agentDir: string): string {
  return join(agentDir, "cache", "pi-toolkit", "usage", "records.jsonl");
}

/**
 * 任务标识：折叠空白成单行、去首尾、超长截断。
 * 只做标识，不做脱敏承诺——完整任务正文从不进入统计（ADR 0007 决策 7）。
 */
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

/** 终态事件 → 持久化记录（截断与归一的唯一出口）。 */
export function createUsageRecord(
  event: UsageRunEvent,
  context: { id: string; at: number; sessionId: string | null },
): UsageRecord {
  const model = event.model?.trim() || null;
  const preferredModel = event.preferredModel?.trim() || null;
  return {
    id: context.id,
    at: context.at,
    // 工单 32：按「发起本次运行的会话」归属，事件未携带时才退回写入时刻的当前会话
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
    durationMs: Math.max(0, Math.round(num(event.elapsedSeconds) * 1000)),
    tokens: sanitizeTokens(event.tokens),
    toolCount: typeof event.toolCount === "number" && Number.isFinite(event.toolCount) ? event.toolCount : null,
    outcome: event.outcome,
    exitCode: num(event.exitCode),
    routeErrorKind: event.routeErrorKind?.trim() || null,
    routeErrorMessage: sanitizeMessage(event.routeErrorMessage),
  };
}

/** 追加一条记录；目录按需创建。写失败由调用方决定是否吞掉（统计不阻断运行）。 */
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

/** 磁盘记录守卫：坏行/未知结构不进入快照，也不让面板崩溃。 */
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
  if (typeof record.durationMs !== "number" || !Number.isFinite(record.durationMs)) return false;
  if (!(record.tokens === null || isUsageTokens(record.tokens))) return false;
  if (!(record.toolCount === null || (typeof record.toolCount === "number" && Number.isFinite(record.toolCount)))) return false;
  if (typeof record.exitCode !== "number" || !Number.isFinite(record.exitCode)) return false;
  if (!nullableString(record.routeErrorKind)) return false;
  if (!nullableString(record.routeErrorMessage)) return false;
  return true;
}

/** 读取全部记录：文件不存在返回空；坏行跳过（跨进程追加中断的容忍口径）。 */
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
    if (isUsageRecord(parsed)) records.push(parsed);
  }
  return records;
}
