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

export interface CodexV2SpawnParams {
  task_name: string;
  message: string;
  model: string;
  reasoning_effort: string;
  agent_type?: string;
  fork_turns?: "all" | "none";
  display_mode?: "auto" | "herdr" | "tmux";
}

export interface ProtocolValidationError {
  code: "invalid_params" | "legacy_param";
  field: string;
  message: string;
}

/** New protocol validation entry point; legacy callers never pass through it. */
export function validateCodexV2SpawnParams(
  value: unknown,
): { ok: true; value: CodexV2SpawnParams } | { ok: false; errors: ProtocolValidationError[] } {
  const errors: ProtocolValidationError[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: [{ code: "invalid_params", field: "params", message: "parameters must be an object" }] };
  }
  const input = value as Record<string, unknown>;
  for (const field of ["task_name", "message", "model", "reasoning_effort"] as const) {
    if (typeof input[field] !== "string" || input[field].trim() === "") {
      errors.push({ code: "invalid_params", field, message: `${field} is required` });
    }
  }
  if (typeof input.task_name === "string" && !/^[a-z0-9_]{1,72}$/.test(input.task_name)) {
    errors.push({ code: "invalid_params", field: "task_name", message: "task_name must use lowercase letters, numbers, and underscores (max 72)" });
  }
  if (input.fork_turns !== undefined && input.fork_turns !== "all" && input.fork_turns !== "none") {
    errors.push({ code: "invalid_params", field: "fork_turns", message: "fork_turns must be all or none" });
  }
  if (input.display_mode !== undefined && !["auto", "herdr", "tmux"].includes(String(input.display_mode))) {
    errors.push({ code: "invalid_params", field: "display_mode", message: "display_mode must be auto, herdr, or tmux" });
  }
  for (const field of [
    "provider", "model_name", "model_id", "tier", "thinking", "surface", "member",
    "retention", "timeoutMs", "dependsOn", "cwd", "pane_id", "paneId",
  ] as const) {
    if (field in input) errors.push({ code: "legacy_param", field, message: `${field} is not accepted by the codex-v2 protocol` });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: {
    task_name: input.task_name as string,
    message: input.message as string,
    model: input.model as string,
    reasoning_effort: input.reasoning_effort as string,
    ...(typeof input.agent_type === "string" ? { agent_type: input.agent_type } : {}),
    ...(input.fork_turns ? { fork_turns: input.fork_turns as "all" | "none" } : {}),
    ...(input.display_mode ? { display_mode: input.display_mode as "auto" | "herdr" | "tmux" } : {}),
  } };
}

export interface CodexV2ModelSelectionDetails {
  selected_model: string;
  candidates: readonly ModelDirectoryReferenceCandidate[];
  reasoning_effort: string;
  supported_reasoning_effort: readonly string[];
}

/** 解析当前 /model 可用目录中的可读模型引用，并校验思考等级。 */
export function validateCodexV2ModelSelection(
  directory: ModelDirectory,
  modelReference: string,
  reasoning_effort: string,
):
  | { ok: true; modelReference: string; reasoning_effort: string; model: ModelDirectoryEntry }
  | {
      ok: false;
      code: "model_ambiguous" | "model_not_found" | "model_key_deprecated" | "reasoning_effort_unsupported";
      message: string;
      details: CodexV2ModelSelectionDetails;
    } {
  const selected_model = modelReference.trim();
  if (/^mk_[a-f0-9]{32}$/i.test(selected_model)) {
    return {
      ok: false,
      code: "model_key_deprecated",
      message: "modelKey is deprecated. Use a unique model name or an exact provider/model route.",
      details: { selected_model, candidates: [], reasoning_effort, supported_reasoning_effort: [] },
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
        reasoning_effort,
        supported_reasoning_effort: [],
      },
    };
  }
  const model = resolved.resolution.model;
  if (!model.reasoning_effort.includes(reasoning_effort)) {
    return {
      ok: false,
      code: "reasoning_effort_unsupported",
      message:
        `Model "${model.provider}/${model.id}" does not support reasoning_effort "${reasoning_effort}" ` +
        `(supported: ${model.reasoning_effort.join(", ")}).`,
      details: {
        selected_model,
        candidates: [],
        reasoning_effort,
        supported_reasoning_effort: [...model.reasoning_effort],
      },
    };
  }
  return { ok: true, modelReference: selected_model, reasoning_effort, model };
}

/**
 * 保留模型选择与底层摘要的错误形状。调用方可把 provider 摘要
 * 原样放入 `underlying_error`，不会被候选切换或重试逻辑覆盖。
 */
export function createCodexV2LaunchError(params: {
  code: string;
  message: string;
  selectedModel: string | null;
  reasoning_effort: string | null;
  display_mode?: "auto" | "herdr" | "tmux" | null;
  resolved_display_mode?: "auto" | "herdr" | "tmux" | null;
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
