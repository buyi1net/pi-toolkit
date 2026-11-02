import type {
  ModelDirectoryEntry,
  ModelDirectory,
  ModelDirectoryReferenceCandidate,
} from "./model-selector.ts";
import { resolveDirectoryModelReference } from "./model-selector.ts";

export const CODEX_V2_SUBAGENT_PROTOCOL = "codex-v2" as const;

export type SubagentProtocol = typeof CODEX_V2_SUBAGENT_PROTOCOL;
export type SubagentModelStrategy = "explicit-selection";
export type SubagentResultDelivery = "host-update";
export type SubagentToolAuthorization = "codex-v2-tools";

export interface SubagentLaunchPlanMetadata {
  protocol: SubagentProtocol;
  protocolVersion: 2;
  launchPlanId: string;
  waitMode: "parent-queue";
  modelStrategy: SubagentModelStrategy;
  resultDelivery: SubagentResultDelivery;
  toolAuthorization: SubagentToolAuthorization;
}

export function createCodexV2LaunchPlanMetadata(launchPlanId: string): SubagentLaunchPlanMetadata {
  return {
    protocol: CODEX_V2_SUBAGENT_PROTOCOL,
    protocolVersion: 2,
    launchPlanId,
    waitMode: "parent-queue",
    modelStrategy: "explicit-selection",
    resultDelivery: "host-update",
    toolAuthorization: "codex-v2-tools",
  };
}

export type ForkTurns = "all" | "none";

export const DEFAULT_FORK_TURNS: ForkTurns = "all";

/**
 * fork_turns is a preference, not a constraint: unknown forms fall back to the default
 * (all) instead of failing the spawn. Case and surrounding whitespace are tolerated, and
 * the caller reports the final value plus whether the request had to be replaced.
 */
export function normalizeForkTurns(raw: unknown): { fork_turns: ForkTurns; requested: string | null; unknown: boolean } {
  if (typeof raw !== "string") {
    const requested = raw === undefined || raw === null ? null : String(raw);
    return { fork_turns: DEFAULT_FORK_TURNS, requested, unknown: requested !== null };
  }
  const folded = raw.trim().toLowerCase();
  if (folded === "none") return { fork_turns: "none", requested: raw, unknown: false };
  if (folded === "all") return { fork_turns: "all", requested: raw, unknown: false };
  return { fork_turns: DEFAULT_FORK_TURNS, requested: raw, unknown: true };
}

export interface CodexV2SpawnParams {
  task_name?: string;
  message: string;
  model: string;
  reasoning_effort?: string;
  agent_type?: string;
  fork_turns?: string;
  display_mode?: string;
}

export interface ProtocolValidationError {
  code: "invalid_params" | "legacy_param";
  field: string;
  message: string;
}

export function validateCodexV2SpawnParams(
  value: unknown,
): { ok: true; value: CodexV2SpawnParams } | { ok: false; errors: ProtocolValidationError[] } {
  const errors: ProtocolValidationError[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: [{ code: "invalid_params", field: "params", message: "parameters must be an object" }] };
  }
  const input = value as Record<string, unknown>;
  for (const field of ["message", "model"] as const) {
    if (typeof input[field] !== "string" || input[field].trim() === "") {
      errors.push({ code: "invalid_params", field, message: `${field} is required` });
    }
  }
  if (input.reasoning_effort !== undefined && typeof input.reasoning_effort !== "string") {
    errors.push({ code: "invalid_params", field: "reasoning_effort", message: "reasoning_effort must be a string when provided" });
  }
  if (typeof input.task_name !== "string" && input.task_name !== undefined) {
    errors.push({ code: "invalid_params", field: "task_name", message: "task_name must be a string when provided" });
  }
  if (input.display_mode !== undefined && typeof input.display_mode !== "string") {
    errors.push({ code: "invalid_params", field: "display_mode", message: "display_mode must be a string when provided" });
  }
  for (const field of [
    "provider", "model_name", "model_id", "tier", "thinking", "surface", "member",
    "retention", "timeoutMs", "dependsOn", "cwd", "pane_id", "paneId",
  ] as const) {
    if (field in input) errors.push({ code: "legacy_param", field, message: `${field} is not accepted by the codex-v2 protocol` });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: {
    ...(typeof input.task_name === "string" ? { task_name: input.task_name } : {}),
    message: input.message as string,
    model: input.model as string,
    reasoning_effort: typeof input.reasoning_effort === "string" ? input.reasoning_effort : undefined,
    ...(typeof input.agent_type === "string" ? { agent_type: input.agent_type } : {}),
    ...(typeof input.fork_turns === "string" ? { fork_turns: input.fork_turns } : {}),
    ...(typeof input.display_mode === "string" ? { display_mode: input.display_mode } : {}),
  } };
}

export interface CodexV2ModelSelectionDetails {
  selected_model: string;
  candidates: readonly ModelDirectoryReferenceCandidate[];
  reasoning_effort: string;
  supported_reasoning_effort: readonly string[];
}

export const REASONING_EFFORT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * Nearest supported level, preferring the lower one on a tie (a silent upgrade costs money).
 * Mirrors the host's clampThinkingLevel but differs on ties by design; the resulting level is
 * passed through as the final value, so no second clamp happens downstream.
 */
export function clampReasoningEffort(supported: readonly string[], requested: string): string {
  if (supported.length === 0) return requested;
  const value = requested.trim().toLowerCase();
  if (supported.includes(value)) return value;
  const index = (REASONING_EFFORT_LEVELS as readonly string[]).indexOf(value);
  if (index === -1) return supported[0]!;
  const indexOf = (level: string) => (REASONING_EFFORT_LEVELS as readonly string[]).indexOf(level);
  let best = supported[0]!;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const level of supported) {
    const levelIndex = indexOf(level);
    if (levelIndex === -1) continue;
    const distance = Math.abs(levelIndex - index);
    if (distance < bestDistance || (distance === bestDistance && levelIndex < indexOf(best))) {
      best = level;
      bestDistance = distance;
    }
  }
  return best;
}

export function validateCodexV2ModelSelection(
  directory: ModelDirectory,
  modelReference: string,
  reasoning_effort?: string,
):
  | { ok: true; modelReference: string; reasoning_effort: string; model: ModelDirectoryEntry; match_note?: "folded" | "near_match"; effort_note?: string }
  | {
      ok: false;
      code: "model_ambiguous" | "model_not_found" | "model_key_deprecated";
      message: string;
      details: CodexV2ModelSelectionDetails;
    } {
  const requested_effort = (reasoning_effort ?? "").trim();
  const selected_model = modelReference.trim();
  if (/^mk_[a-f0-9]{32}$/i.test(selected_model)) {
    return {
      ok: false,
      code: "model_key_deprecated",
      message: "modelKey is deprecated. Use a unique model name or an exact provider/model route.",
      details: { selected_model, candidates: [], reasoning_effort: requested_effort, supported_reasoning_effort: [] },
    };
  }
  const resolved = resolveDirectoryModelReference(directory, selected_model);
  if ("problem" in resolved) {
    return {
      ok: false,
      code: resolved.problem.code,
      message: resolved.problem.message,
      details: {
        selected_model: resolved.problem.selected_model,
        candidates: resolved.problem.candidates,
        reasoning_effort: requested_effort,
        supported_reasoning_effort: [],
      },
    };
  }
  const model = resolved.resolution.model;
  // An unsupported level is clamped to the nearest supported one instead of failing the spawn.
  const final_effort = clampReasoningEffort(model.reasoning_effort, requested_effort || "off");
  return {
    ok: true,
    modelReference: selected_model,
    reasoning_effort: final_effort,
    model,
    ...(resolved.resolution.match_note ? { match_note: resolved.resolution.match_note } : {}),
    ...(requested_effort !== "" && final_effort !== requested_effort ? { effort_note: `${requested_effort} -> ${final_effort}` } : {}),
  };
}

export function createCodexV2LaunchError(params: {
  code: string;
  message: string;
  selectedModel: string | null;
  reasoning_effort: string | null;
  display_mode?: "auto" | "herdr" | "tmux" | null;
  resolved_display_mode?: "background" | "herdr" | "tmux" | null;
  underlying_error?: unknown;
}): Record<string, unknown> {
  return {
    code: params.code,
    message: params.message,
    selected_model: params.selectedModel,
    reasoning_effort: params.reasoning_effort,
    requested_display_mode: params.display_mode ?? null,
    resolved_display_mode: params.resolved_display_mode ?? null,
    ...(params.underlying_error === undefined ? {} : { underlying_error: params.underlying_error }),
  };
}
