import type {
  ModelRuntimeStatus,
  RoutingInheritanceCause,
  RoutingModelOrigin,
} from "../subagents/index.ts";

export const USAGE_SNAPSHOT_SERVICE_NAME = "usage.snapshot";

export const USAGE_RECORDER_SERVICE_NAME = "usage.recorder";

export const USAGE_TASK_LABEL_MAX = 80;

export const USAGE_ERROR_MESSAGE_MAX = 240;

export const USAGE_RECENT_LIMIT = 10;

export type UsageOutcome = "completed" | "failed" | "cancelled";

export type UsageModelSource = RoutingModelOrigin;

export type UsageInheritanceCause = RoutingInheritanceCause;

export interface UsageRunTokens {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly costUsd: number;
}

export interface UsageRunEvent {
  readonly name: string;
  readonly task: string;
  readonly sessionFile?: string | null;

  readonly sessionId?: string | null;
  readonly cohortId?: string | null;
  readonly agent?: string | null;

  readonly model?: string | null;
  readonly thinking?: string | null;

  readonly tier?: string | null;

  readonly preferredModel?: string | null;

  readonly modelSource?: UsageModelSource | null;

  readonly inheritanceCause?: UsageInheritanceCause | null;
  readonly elapsedSeconds: number;
  readonly tokens?: UsageRunTokens | null;
  readonly toolCount?: number | null;
  readonly outcome: UsageOutcome;
  readonly exitCode: number;
  readonly routeErrorKind?: string | null;
  readonly routeErrorMessage?: string | null;
}

export interface UsageRecord {
  readonly id: string;

  readonly at: number;

  readonly sessionId: string | null;
  readonly sessionFile: string | null;
  readonly name: string;

  readonly taskLabel: string;
  readonly cohortId: string | null;
  readonly agent: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly thinking: string | null;
  readonly tier: string | null;
  readonly preferredModel: string | null;

  readonly downgraded: boolean | null;

  readonly modelSource: UsageModelSource | null;

  readonly inheritanceCause: UsageInheritanceCause | null;
  readonly durationMs: number;
  readonly tokens: UsageRunTokens | null;
  readonly toolCount: number | null;
  readonly outcome: UsageOutcome;
  readonly exitCode: number;
  readonly routeErrorKind: string | null;
  readonly routeErrorMessage: string | null;
}

export interface UsageBalanceView {
  readonly amount: number;
  readonly currency: string;
}

export interface UsageQuotaWindowView {
  readonly label: string;
  readonly remainingPercent: number;
  readonly resetMs: number | null;
}

export type UsageObservationKind =
  | "ready"
  | "unsupported"
  | "no-credential"
  | "failed"
  | "pending"
  | "unresolved"
  | "unrecorded";

export interface UsageTotals {
  readonly runs: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalTokens: number;
  readonly costUsd: number;
  readonly durationMs: number;
}

export interface UsageBreakdown extends UsageTotals {
  readonly key: string;
}

export interface UsageWindowView extends UsageTotals {
  readonly byModel: readonly UsageBreakdown[];
  readonly byProvider: readonly UsageBreakdown[];
  readonly byAgent: readonly UsageBreakdown[];
  readonly byTask: readonly UsageBreakdown[];
}

export interface UsageModelView {
  readonly model: string;
  readonly provider: string | null;

  readonly tiers: readonly string[];

  readonly health: ModelRuntimeStatus;

  readonly observation: UsageObservationKind;

  readonly balance: UsageBalanceView | null;

  readonly quota: readonly UsageQuotaWindowView[] | null;

  readonly fetchedAt: number | null;

  readonly lastCheckedAt: number | null;

  readonly totals: UsageTotals;
}

export interface UsageWindowSet {
  readonly current: UsageWindowView;
  readonly today: UsageWindowView;
  readonly week: UsageWindowView;
  readonly history: UsageWindowView;
}

export interface UsageSnapshotView {
  readonly generatedAt: number;

  readonly revision: number;
  readonly sessionId: string | null;

  readonly pool: readonly string[];
  readonly models: readonly UsageModelView[];
  readonly windows: UsageWindowSet;

  readonly recent: readonly UsageRecord[];
}

export interface UsageSnapshotQuery {

  readonly cwd?: string;

  readonly now?: number;
}

export interface UsageSnapshotService {
  readonly id: "usage";
  snapshot(query?: UsageSnapshotQuery): UsageSnapshotView;

  refresh(query?: UsageSnapshotQuery): Promise<void>;
}

export interface UsageRecorderService {
  readonly id: "usage";

  record(event: UsageRunEvent): UsageRecord | null;
}

export function deriveProvider(model: string | null | undefined): string | null {
  if (!model) return null;
  const separator = model.indexOf("/");
  if (separator <= 0) return null;
  return model.slice(0, separator);
}
