import { baseModelRef } from "./routing.ts";
import {
  POOL_USAGE_READ_STALE_MS,
  poolUsageObservedAt,
  PROVIDERS_POOL_USAGE_SERVICE_NAME,
  type PoolUsageState,
  type ProvidersPoolUsageService,
  type UsageSnapshot,
} from "../providers/api.ts";

export const MODEL_RUNTIME_VERDICTS = [
  "available",
  "quota-blocked",
  "unstable",
  "offline",
  "unknown",
  "unconfigured",
] as const;

export type ModelRuntimeVerdict = (typeof MODEL_RUNTIME_VERDICTS)[number];

export interface ModelHealthSignals {

  readonly rateLimited?: boolean;

  readonly overloaded?: boolean;

  readonly persistentlyUnstable?: boolean;

  readonly errorRate?: number;

  readonly latencyMs?: number;
}

export interface ModelRuntimeStatus {
  readonly verdict: ModelRuntimeVerdict;

  readonly signals?: ModelHealthSignals;

  readonly lastCheckedAt: number | null;

  readonly detail?: string;

  readonly request_count?: number;
  readonly error_count?: number;
  readonly consecutive_error_count?: number;
  readonly last_error_at?: number | null;
  readonly last_error_type?: string | null;
}

export type ModelHealthMap = ReadonlyMap<string, ModelRuntimeStatus>;

export function isHardBlockedVerdict(verdict: ModelRuntimeVerdict): boolean {
  return verdict === "quota-blocked" || verdict === "offline";
}

export type ModelErrorObservationKind = "rate_limited" | "provider_error";

export interface ModelErrorObservation {
  readonly kind: ModelErrorObservationKind;
  readonly message: string;

  readonly observedAt: number;
}

export const MODEL_ERROR_TRANSIENT_WINDOW_MS = 2 * 60_000;

export const MODEL_ERROR_PERSISTENT_WINDOW_MS = 10 * 60_000;

export const MODEL_ERROR_PERSISTENT_THRESHOLD = 3;

export interface ModelErrorJournal {

  readonly now: () => number;

  record(modelRef: string, observation: { kind: ModelErrorObservationKind; message: string; observedAt?: number }): void;

  observations(modelRef: string): readonly ModelErrorObservation[];

  clear(): void;
}

export function createModelErrorJournal(now: () => number = Date.now): ModelErrorJournal {
  const byModel = new Map<string, ModelErrorObservation[]>();
  return {
    now,
    record(modelRef, observation) {

      if (observation.kind !== "rate_limited" && observation.kind !== "provider_error") return;
      const base = baseModelRef(modelRef);
      const at = observation.observedAt ?? now();
      const list = [...(byModel.get(base) ?? []), {
        kind: observation.kind,
        message: observation.message,
        observedAt: at,
      }];

      const cutoff = at - MODEL_ERROR_PERSISTENT_WINDOW_MS;
      byModel.set(base, list.filter((item) => item.observedAt >= cutoff));
    },
    observations(modelRef) {
      return [...(byModel.get(baseModelRef(modelRef)) ?? [])];
    },
    clear() {
      byModel.clear();
    },
  };
}

export function deriveErrorObservationStatus(
  observations: readonly ModelErrorObservation[],
  now: number,
): ModelRuntimeStatus | null {
  if (observations.length === 0) return null;
  const withinTransient = observations.filter((o) => now - o.observedAt <= MODEL_ERROR_TRANSIENT_WINDOW_MS);
  const withinPersistent = observations.filter((o) => now - o.observedAt <= MODEL_ERROR_PERSISTENT_WINDOW_MS);
  const persistentlyUnstable = withinPersistent.length >= MODEL_ERROR_PERSISTENT_THRESHOLD;
  if (withinTransient.length === 0 && !persistentlyUnstable) return null;
  const latest = observations.reduce((a, b) => (b.observedAt >= a.observedAt ? b : a));
  const rateLimited = withinTransient.some((o) => o.kind === "rate_limited");
  const overloaded = withinTransient.some((o) => /overload/i.test(o.message));
  const detail = persistentlyUnstable
    ? `${withinPersistent.length} transient failures within ` +
      `${Math.round(MODEL_ERROR_PERSISTENT_WINDOW_MS / 60_000)} min (latest: ${latest.message})`
    : `transient failure ${Math.round((now - latest.observedAt) / 1000)}s ago: ${latest.message}`;
  return {
    verdict: "unstable",
    signals: {
      ...(rateLimited ? { rateLimited: true } : {}),
      ...(overloaded ? { overloaded: true } : {}),
      ...(persistentlyUnstable ? { persistentlyUnstable: true } : {}),
    },
    lastCheckedAt: latest.observedAt,
    detail,

    request_count: 0,
    error_count: withinPersistent.length,
    consecutive_error_count: withinPersistent.length,
    last_error_at: latest.observedAt,
    last_error_type: latest.kind,
  };
}

function mergeRuntimeStatuses(
  base: ModelRuntimeStatus | undefined,
  fromErrors: ModelRuntimeStatus | null,
): ModelRuntimeStatus | null {
  if (fromErrors == null) return base ?? null;
  if (base == null) return fromErrors;
  if (isHardBlockedVerdict(base.verdict)) {
    return { ...base, ...(fromErrors.signals ? { signals: fromErrors.signals } : {}) };
  }
  return fromErrors;
}

export { baseModelRef };

export function poolBaseRefs(pool: readonly string[]): string[] {
  const seen = new Set<string>();
  const refs: string[] = [];
  for (const ref of pool) {
    const base = baseModelRef(ref);
    if (!seen.has(base)) {
      seen.add(base);
      refs.push(base);
    }
  }
  return refs;
}

function verdictFromSnapshot(snapshot: UsageSnapshot): ModelRuntimeStatus {
  const balance = snapshot.balance;
  const exhaustedWindow = snapshot.windows.find((window) => window.remainingPercent <= 0);
  const balanceBlocked = balance != null && balance.amount <= 0;
  if (balanceBlocked || exhaustedWindow) {
    const reasons: string[] = [];
    if (balanceBlocked) {
      reasons.push(`balance exhausted (${balance.amount} ${balance.currency})`);
    }
    if (exhaustedWindow) {
      reasons.push(
        `quota window "${exhaustedWindow.label}" at ${exhaustedWindow.remainingPercent}%` +
          (exhaustedWindow.resetMs != null ? ` (resets at ${new Date(exhaustedWindow.resetMs).toISOString()})` : ""),
      );
    }
    return { verdict: "quota-blocked", lastCheckedAt: snapshot.fetchedAt, detail: reasons.join("; ") };
  }
  if (balance == null && snapshot.windows.length === 0) {
    return {
      verdict: "unknown",
      lastCheckedAt: snapshot.fetchedAt,
      detail: "provider query returned no balance or quota data",
    };
  }
  return { verdict: "available", lastCheckedAt: snapshot.fetchedAt };
}

export function deriveModelRuntimeStatus(state: PoolUsageState | undefined, now?: number): ModelRuntimeStatus {
  if (!state) {
    return { verdict: "unknown", lastCheckedAt: null, detail: "no status recorded" };
  }
  const observedAt = poolUsageObservedAt(state);
  if (now !== undefined && !Number.isFinite(observedAt)) {

    return { verdict: "unknown", lastCheckedAt: null, detail: "status entry has no fetch time; treated as unknown" };
  }
  if (now !== undefined && now - observedAt > POOL_USAGE_READ_STALE_MS) {
    return {
      verdict: "unknown",
      lastCheckedAt: observedAt,
      detail:
        `status expired: fetched ${Math.round((now - observedAt) / 1000)}s ago ` +
        `(stale after ${Math.round(POOL_USAGE_READ_STALE_MS / 1000)}s); treated as unknown until next refresh`,
    };
  }
  switch (state.kind) {
    case "ready":
      return verdictFromSnapshot(state.snapshot);
    case "unsupported":
      return { verdict: "unconfigured", lastCheckedAt: null, detail: "no query route for provider" };
    case "no-credential":
      return { verdict: "unconfigured", lastCheckedAt: null, detail: "no credentials resolved for provider" };
    case "failed":
      return { verdict: "unknown", lastCheckedAt: null, detail: "provider query failed" };
    case "pending":
      return { verdict: "unknown", lastCheckedAt: null, detail: "provider query in flight" };
    case "unresolved":
      return {
        verdict: "unknown",
        lastCheckedAt: null,
        detail: "model not in host catalog; provider status unobservable",
      };
  }
}

export interface ModelHealthGateway {

  read(pool: readonly string[]): ModelHealthMap;

  refresh(pool: readonly string[]): void;
}

export function createProvidersHealthGateway(
  services: { get<T>(name: string): T | undefined },
  journal?: ModelErrorJournal,
  now?: () => number,
): ModelHealthGateway {
  const resolve = () => services.get<ProvidersPoolUsageService>(PROVIDERS_POOL_USAGE_SERVICE_NAME);

  const clock = now ?? journal?.now ?? Date.now;
  return {
    read(pool) {
      const refs = poolBaseRefs(pool);
      const map = new Map<string, ModelRuntimeStatus>();
      const service = resolve();
      if (!service && !journal) return map;
      const readAt = clock();
      const known = new Map(
        (service ? service.snapshot(refs) : []).map((entry) => [entry.model, entry.state] as const),
      );
      for (const ref of refs) {

        const state = known.get(ref);
        const base = state !== undefined ? deriveModelRuntimeStatus(state, readAt) : undefined;
        const fromErrors = journal
          ? deriveErrorObservationStatus(journal.observations(ref), journal.now())
          : null;
        const merged = mergeRuntimeStatuses(base, fromErrors);
        if (merged) map.set(ref, merged);
      }
      return map;
    },
    refresh(pool) {
      const service = resolve();
      if (!service) return;
      void service.refresh(poolBaseRefs(pool)).catch(() => {});
    },
  };
}
