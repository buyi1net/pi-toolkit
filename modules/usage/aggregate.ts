import type { ModelRuntimeStatus } from "../subagents/index.ts";
import type { PoolUsageEntry } from "../providers/api.ts";
import {
  deriveProvider,
  USAGE_RECENT_LIMIT,
  type UsageBreakdown,
  type UsageModelView,
  type UsageObservationKind,
  type UsageRecord,
  type UsageSnapshotView,
  type UsageTotals,
  type UsageWindowView,
} from "./api.ts";

export interface UsagePoolEntry {
  readonly tier: string;
  readonly models: readonly string[];
}

export interface UsagePoolModel {
  readonly model: string;
  readonly provider: string | null;
  readonly tiers: readonly string[];
}

export function flattenPoolModels(pools: readonly UsagePoolEntry[]): UsagePoolModel[] {
  const seen = new Map<string, { provider: string | null; tiers: string[] }>();
  for (const pool of pools) {
    for (const model of pool.models) {
      const provider = deriveProvider(model);
      const existing = seen.get(model);
      if (existing) {
        if (!existing.tiers.includes(pool.tier)) existing.tiers.push(pool.tier);
      } else {
        seen.set(model, { provider, tiers: [pool.tier] });
      }
    }
  }
  return [...seen.entries()].map(([model, entry]) => ({
    model,
    provider: entry.provider,
    tiers: entry.tiers,
  }));
}

export function dedupeRecordsBySession(records: readonly UsageRecord[]): UsageRecord[] {
  const latest = new Map<string, UsageRecord>();
  const standalone: UsageRecord[] = [];
  for (const record of records) {
    if (!record.sessionFile) {
      standalone.push(record);
      continue;
    }
    const existing = latest.get(record.sessionFile);
    if (!existing || record.at >= existing.at) latest.set(record.sessionFile, record);
  }
  return [...standalone, ...latest.values()];
}

export function emptyTotals(): UsageTotals {
  return {
    runs: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    durationMs: 0,
  };
}

export function totalsOf(records: readonly UsageRecord[]): UsageTotals {
  const totals = { ...emptyTotals() } as {
    -readonly [K in keyof UsageTotals]: UsageTotals[K];
  };
  for (const record of records) {
    totals.runs += 1;
    if (record.outcome === "completed") totals.completed += 1;
    else if (record.outcome === "failed") totals.failed += 1;
    else totals.cancelled += 1;
    totals.durationMs += record.durationMs;
    if (record.tokens) {
      totals.inputTokens += record.tokens.input;
      totals.outputTokens += record.tokens.output;
      totals.cacheReadTokens += record.tokens.cacheRead;
      totals.cacheWriteTokens += record.tokens.cacheWrite;
      totals.totalTokens +=
        record.tokens.input + record.tokens.output + record.tokens.cacheRead + record.tokens.cacheWrite;
      totals.costUsd += record.tokens.costUsd;
    }
  }
  return totals;
}

function breakdown(records: readonly UsageRecord[], keyOf: (record: UsageRecord) => string | null): UsageBreakdown[] {
  const grouped = new Map<string, UsageRecord[]>();
  for (const record of records) {
    const key = keyOf(record);
    if (!key) continue;
    const list = grouped.get(key);
    if (list) list.push(record);
    else grouped.set(key, [record]);
  }
  return [...grouped.entries()]
    .map(([key, list]) => ({ key, ...totalsOf(list) }))
    .sort((a, b) => b.totalTokens - a.totalTokens || b.runs - a.runs || a.key.localeCompare(b.key));
}

export function buildWindow(records: readonly UsageRecord[]): UsageWindowView {
  return {
    ...totalsOf(records),
    byModel: breakdown(records, (record) => record.model),
    byProvider: breakdown(records, (record) => record.provider),
    byAgent: breakdown(records, (record) => record.agent ?? record.name),
    byTask: breakdown(records, (record) => record.taskLabel),
  };
}

export function startOfLocalDay(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function startOfLocalWeek(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  const offset = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - offset);
  return date.getTime();
}

export interface UsageSnapshotInput {
  readonly records: readonly UsageRecord[];
  readonly pools: readonly UsagePoolEntry[];
  readonly health: ReadonlyMap<string, ModelRuntimeStatus>;
  readonly poolUsage: readonly PoolUsageEntry[];
  readonly sessionId: string | null;
  readonly now: number;
  readonly revision: number;
}

function observationFor(entry: PoolUsageEntry | undefined): UsageObservationKind {
  return entry ? entry.state.kind : "unrecorded";
}

function buildModelViews(
  poolModels: readonly UsagePoolModel[],
  scoped: readonly UsageRecord[],
  health: ReadonlyMap<string, ModelRuntimeStatus>,
  poolUsage: readonly PoolUsageEntry[],
): UsageModelView[] {
  const usageByModel = new Map(poolUsage.map((entry) => [entry.model, entry] as const));
  return poolModels.map(({ model, provider, tiers }) => {
    const entry = usageByModel.get(model);
    const ready = entry?.state.kind === "ready" ? entry.state.snapshot : null;
    const balance = ready?.balance
      ? { amount: ready.balance.amount, currency: ready.balance.currency }
      : null;
    const quota = ready
      ? ready.windows.map((window) => ({
          label: window.label,
          remainingPercent: window.remainingPercent,
          resetMs: window.resetMs ?? null,
        }))
      : null;
    const status: ModelRuntimeStatus = health.get(model) ?? {
      verdict: "unknown",
      lastCheckedAt: null,
      detail: "no status recorded",
    };
    const own = scoped.filter((record) => record.model === model);
    const fetchedAt = ready?.fetchedAt ?? null;
    const checkedAt = Math.max(status.lastCheckedAt ?? 0, fetchedAt ?? 0);
    return {
      model,
      provider,
      tiers,
      health: status,
      observation: observationFor(entry),
      balance,
      quota,
      fetchedAt,
      lastCheckedAt: checkedAt > 0 ? checkedAt : null,
      totals: totalsOf(own),
    };
  });
}

export function buildUsageSnapshot(input: UsageSnapshotInput): UsageSnapshotView {
  const poolModels = flattenPoolModels(input.pools);
  const poolSet = new Set(poolModels.map((model) => model.model));

  const scoped = dedupeRecordsBySession(
    input.records.filter((record) => record.model != null && poolSet.has(record.model)),
  );
  const dayStart = startOfLocalDay(input.now);
  const weekStart = startOfLocalWeek(input.now);
  const currentRecords =
    input.sessionId == null ? [] : scoped.filter((record) => record.sessionId === input.sessionId);
  const recent = [...scoped].sort((a, b) => b.at - a.at).slice(0, USAGE_RECENT_LIMIT);
  return {
    generatedAt: input.now,
    revision: input.revision,
    sessionId: input.sessionId,
    pool: poolModels.map((model) => model.model),
    models: buildModelViews(poolModels, scoped, input.health, input.poolUsage),
    recent,
    windows: {
      current: buildWindow(currentRecords),
      today: buildWindow(scoped.filter((record) => record.at >= dayStart)),
      week: buildWindow(scoped.filter((record) => record.at >= weekStart)),
      history: buildWindow(scoped),
    },
  };
}
