import { baseModelRef, type ModelErrorObservationKind } from "./model-health.ts";
import type { ModelCandidateRejection } from "./model-selector.ts";
import type { LoadoutRoutingSnapshot, RoutingFallbackReason } from "./routing-snapshot.ts";
import type { RouteException, RouteExceptionKind } from "./route-error.ts";
import type { ModelTier } from "./routing.ts";

export const FAILOVER_SWITCHABLE_KINDS: readonly ModelErrorObservationKind[] = [
  "rate_limited",
  "provider_error",
];

export type FailoverSwitchableKind = ModelErrorObservationKind;

export function isFailoverSwitchable(kind: RouteExceptionKind): kind is FailoverSwitchableKind {
  return (FAILOVER_SWITCHABLE_KINDS as readonly string[]).includes(kind);
}

export const MIN_FAILOVER_BUDGET_MS = 1000;

export interface ModelFailoverAttempt {

  readonly index: number;

  readonly model: string;

  readonly kind: RouteExceptionKind;

  readonly message: string;

  readonly elapsedSeconds: number;
}

export interface ModelRoutingDetails {
  readonly tier: ModelTier;

  readonly preferred: string;

  readonly actual: string;

  readonly downgraded: boolean;

  readonly reason: string | null;

  readonly attempts: readonly ModelFailoverAttempt[];

  readonly selectionSkips: readonly ModelCandidateRejection[];

  readonly fallbackReason?: RoutingFallbackReason;
}

function truncate(text: string, limit = 160): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}

export function buildModelRouting(input: {
  tier: ModelTier;
  pool: readonly string[];
  actual: string | null;
  attempts: readonly ModelFailoverAttempt[];
  selectionSkips: readonly ModelCandidateRejection[];
  fallbackReason?: RoutingFallbackReason;
}): ModelRoutingDetails {
  const preferred = input.pool[0] ?? input.actual ?? "";
  const actual = input.actual ?? preferred;
  const downgraded = baseModelRef(actual) !== baseModelRef(preferred);
  let reason: string | null = null;
  if (input.attempts.length > 0) {
    const chain = input.attempts
      .map((attempt) => `#${attempt.index} ${attempt.model} failed (${attempt.kind}): ${truncate(attempt.message)}`)
      .join("; ");
    reason = `${chain} — switched to ${actual}`;
  } else if (input.fallbackReason) {

    const blocked = input.selectionSkips.length > 0
      ? ` — all candidates blocked: ${input.selectionSkips.map((skip) => `${skip.model}: ${skip.reason}`).join("; ")}`
      : "";
    reason = `tier pool ${input.fallbackReason}${blocked}`;
  } else {
    const preferredSkips = input.selectionSkips.filter(
      (skip) => baseModelRef(skip.model) === baseModelRef(preferred),
    );
    if (preferredSkips.length > 0) {
      reason = `preferred ${preferred} was skipped at selection: ${preferredSkips
        .map((skip) => skip.reason)
        .join("; ")}`;
    }
  }
  return {
    tier: input.tier,
    preferred,
    actual,
    downgraded,
    reason,
    attempts: [...input.attempts],
    selectionSkips: [...input.selectionSkips],
    ...(input.fallbackReason ? { fallbackReason: input.fallbackReason } : {}),
  };
}

export function describeModelRouting(routing: ModelRoutingDetails): string | null {
  if (routing.fallbackReason && routing.reason) {
    const inheritance = `inherited parent session model ${routing.actual}`;
    const head = routing.downgraded
      ? `preferred ${routing.preferred}, actual ${routing.actual} — ${inheritance}`
      : inheritance;
    return `[model routing] tier "${routing.tier}": ${head} (${routing.reason})`;
  }
  if (!routing.downgraded || !routing.reason) return null;
  return (
    `[model routing] tier "${routing.tier}": preferred ${routing.preferred}, ` +
    `actual ${routing.actual} — downgraded (${routing.reason})`
  );
}

export function buildModelRoutingFromSnapshot(
  snapshot: LoadoutRoutingSnapshot | null | undefined,
  runtime: { actualModel?: string | null; attempts?: readonly ModelFailoverAttempt[] } = {},
): ModelRoutingDetails | null {
  if (!snapshot || snapshot.tier == null) return null;
  const actual = runtime.actualModel ?? snapshot.model ?? snapshot.preferred ?? "";
  return buildModelRouting({
    tier: snapshot.tier,

    pool: snapshot.pool?.length ? snapshot.pool : [actual],
    actual,
    attempts: runtime.attempts ?? [],
    selectionSkips: snapshot.skipped,
    ...(snapshot.fallbackReason ? { fallbackReason: snapshot.fallbackReason } : {}),
  });
}

export interface FailoverDecision {
  readonly failover: boolean;
  readonly reason: string;
}

export function shouldFailoverAfterFailure(input: {
  result: { stopped?: boolean; userClosed?: boolean; handedOff?: boolean };
  routeException: RouteException | undefined;

  toolCount: number | null;

  waitBudgetMs: number | null;

  untriedCandidates: number;
}): FailoverDecision {
  if (input.result.stopped) return { failover: false, reason: "subagent was stopped explicitly" };
  if (input.result.userClosed) return { failover: false, reason: "subagent pane was closed by the user" };
  if (input.result.handedOff) return { failover: false, reason: "subagent was handed off (host reload / session detach)" };
  if (!input.routeException) {
    return { failover: false, reason: "no route exception classified (success or non-route failure)" };
  }
  if (!isFailoverSwitchable(input.routeException.kind)) {
    return {
      failover: false,
      reason: `error kind "${input.routeException.kind}" is not a transient route failure — not blindly retried`,
    };
  }
  if (input.toolCount == null || input.toolCount > 0) {
    return {
      failover: false,
      reason: "the failed attempt had already made progress (tool calls executed) — restarting would duplicate side effects",
    };
  }
  if (input.untriedCandidates <= 0) {
    return { failover: false, reason: "no untried candidates remain (each candidate is tried at most once)" };
  }
  if (input.waitBudgetMs != null && input.waitBudgetMs < MIN_FAILOVER_BUDGET_MS) {
    return { failover: false, reason: "remaining wait budget is too small for another attempt" };
  }
  return { failover: true, reason: "transient route failure with no progress" };
}

export function aggregateFailoverExhaustion(input: {
  tier: ModelTier;
  pool: readonly string[];
  attempts: readonly ModelFailoverAttempt[];

  remainingError?: string;
}): string {
  const lines = [
    `All model candidates for tier "${input.tier}" are unavailable.`,
    `Tried in configured order (pool: ${input.pool.join(", ")}):`,
    ...input.attempts.map(
      (attempt) => `  - attempt ${attempt.index} ${attempt.model}: ${attempt.kind}: ${truncate(attempt.message)}`,
    ),
  ];
  if (input.remainingError) {
    lines.push(`Remaining candidates were not selectable:\n${input.remainingError}`);
  } else {
    lines.push("No untried candidates remain — every candidate was tried at most once, in configured order.");
  }
  lines.push(
    "The failures above are transient route errors recorded per attempt; check the providers or adjust the tier candidate pool.",
  );
  return lines.join("\n");
}
