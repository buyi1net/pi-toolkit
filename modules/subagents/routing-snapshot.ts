import { modelOwnThinkingSuffix, type ModelTier } from "./routing.ts";
import {
  FAILOVER_EXCLUSION_REASON_PREFIX,
  STATUS_SKIP_REASON_PREFIX,
  UNSTABLE_SKIP_REASON_PREFIX,
  type ModelCandidateRejection,
} from "./model-selector.ts";

export type RoutingFallbackReason = "pool-unconfigured" | "pool-status-unavailable";

export type RoutingThinkingSource = "parent" | "explicit" | "agent" | "tier" | "model-suffix";

export interface LoadoutRoutingSnapshot {

  readonly tier: ModelTier | null;

  readonly pool: readonly string[] | null;

  readonly preferred: string | null;

  readonly model: string | null;

  readonly skipped: readonly ModelCandidateRejection[];

  readonly fallbackReason: RoutingFallbackReason | null;

  readonly poolSource: string | null;

  readonly effectiveThinking: string | null;

  readonly effectiveThinkingSource: RoutingThinkingSource | null;
}

export interface RoutingSnapshotInput {
  readonly tier: ModelTier | null;
  readonly tierPool: readonly string[] | null;

  readonly tierSelectionSkips: readonly ModelCandidateRejection[] | null;
  readonly fallbackReason: RoutingFallbackReason | null;

  readonly poolSource: string | null;
  readonly effectiveModel: string | null;

  readonly effectiveThinking: string | null | undefined;
  readonly params: { thinking?: string };
  readonly agentDefs: { thinking?: string } | null;
  readonly tierThinking: string | null | undefined;
}

export function resolveAppliedThinking(input: {
  parentThinking?: string | null;
  thinkingOverride?: string | null;
  thinking?: string | null;
  tierThinking?: string | null;
  model?: string | null;
}): { level: string | null; source: RoutingThinkingSource | null } {
  if (input.parentThinking != null) return { level: input.parentThinking, source: "parent" };
  if (input.thinkingOverride != null) return { level: input.thinkingOverride, source: "explicit" };
  if (input.thinking != null) return { level: input.thinking, source: "agent" };
  if (input.tierThinking != null) return { level: input.tierThinking, source: "tier" };
  const own = modelOwnThinkingSuffix(input.model);
  return own != null ? { level: own, source: "model-suffix" } : { level: null, source: null };
}

export function buildRoutingSnapshot(input: RoutingSnapshotInput): LoadoutRoutingSnapshot {

  const parentThinking = input.fallbackReason ? input.effectiveThinking ?? null : null;
  const applied = resolveAppliedThinking({
    parentThinking,
    thinkingOverride: input.params.thinking ?? null,
    thinking: input.agentDefs?.thinking ?? null,
    tierThinking: input.tierThinking ?? null,
    model: input.effectiveModel,
  });
  return {
    tier: input.tier,
    pool: input.tierPool,
    preferred: input.tierPool?.[0] ?? null,
    model: input.effectiveModel,
    skipped: [...(input.tierSelectionSkips ?? [])],
    fallbackReason: input.fallbackReason,
    poolSource: input.poolSource,
    effectiveThinking: applied.level,
    effectiveThinkingSource: applied.source,
  };
}

export type RoutingModelOrigin = "pool" | "parent" | "declared";

export const ROUTING_MODEL_ORIGINS: readonly RoutingModelOrigin[] = ["pool", "parent", "declared"];

export type RoutingInheritanceCause =
  | "pool-unconfigured"
  | "hard-blocked"
  | "persistently-unstable"
  | "mixed-blocks"
  | "unclassified";

export const ROUTING_INHERITANCE_CAUSES: readonly RoutingInheritanceCause[] = [
  "pool-unconfigured",
  "hard-blocked",
  "persistently-unstable",
  "mixed-blocks",
  "unclassified",
];

export function routingModelOrigin(
  snapshot: LoadoutRoutingSnapshot | null | undefined,
): RoutingModelOrigin | null {
  if (!snapshot) return null;
  if (snapshot.fallbackReason != null) return "parent";
  if (snapshot.pool != null && snapshot.pool.length > 0) return "pool";
  return "declared";
}

export function routingInheritanceCause(
  snapshot: LoadoutRoutingSnapshot | null | undefined,
): RoutingInheritanceCause | null {
  if (!snapshot || snapshot.fallbackReason == null) return null;
  if (snapshot.fallbackReason === "pool-unconfigured") return "pool-unconfigured";
  const relevant = snapshot.skipped.filter(
    (skip) =>
      skip.kind === "status" &&
      !skip.reason.startsWith(FAILOVER_EXCLUSION_REASON_PREFIX),
  );
  if (relevant.length === 0) return "unclassified";
  const unstable = relevant.filter((skip) => skip.reason.startsWith(UNSTABLE_SKIP_REASON_PREFIX)).length;
  const hard = relevant.filter((skip) => skip.reason.startsWith(STATUS_SKIP_REASON_PREFIX)).length;
  if (unstable > 0 && hard > 0) return "mixed-blocks";
  if (unstable > 0) return "persistently-unstable";
  if (hard === relevant.length) return "hard-blocked";
  return "unclassified";
}

export function describeInheritanceCause(cause: RoutingInheritanceCause | null | undefined): string {
  switch (cause) {
    case "pool-unconfigured":
      return "tier pool unconfigured";
    case "hard-blocked":
      return "all candidates hard-blocked (quota exhausted / offline)";
    case "persistently-unstable":
      return "all candidates persistently unstable";
    case "mixed-blocks":
      return "candidates blocked by mixed status blocks";
    default:
      return "reason unknown";
  }
}

export function inheritanceBadgeText(cause: RoutingInheritanceCause | null | undefined): string {
  return ` [inherits parent session: ${describeInheritanceCause(cause)}]`;
}
