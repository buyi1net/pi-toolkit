import type { ModelDirectoryEntry, ModelDirectory } from "./model-selector.ts";
import { resolveExplicitModelSelection } from "./model-selector.ts";

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

/** 新协议的模型选择校验；旧协议不会调用此接缝。 */
export function validateCodexV2ModelSelection(
  directory: ModelDirectory,
  modelKey: string,
  reasoning_effort: string,
):
  | { ok: true; modelKey: string; reasoning_effort: string; model: ModelDirectoryEntry }
  | {
      ok: false;
      code: "model_key_unknown" | "reasoning_effort_unsupported";
      message: string;
      details: {
        selected_model_key: string;
        reasoning_effort: string;
        supported_reasoning_effort: readonly string[];
      };
    } {
  const result = resolveExplicitModelSelection(directory, modelKey, reasoning_effort);
  if ("error" in result) {
    return {
      ok: false,
      code: result.error.code,
      message: result.error.message,
      details: {
        selected_model_key: result.error.selected_model_key,
        reasoning_effort: result.error.reasoning_effort,
        supported_reasoning_effort: result.error.supported_reasoning_effort,
      },
    };
  }
  return {
    ok: true,
    modelKey: result.selection.modelKey,
    reasoning_effort: result.selection.reasoning_effort,
    model: result.selection.model,
  };
}

/**
 * 保留新协议实际选择与底层摘要的错误形状。调用方可把 provider 摘要
 * 原样放入 `underlying_error`，不会被候选切换或重试逻辑覆盖。
 */
export function createCodexV2LaunchError(params: {
  code: string;
  message: string;
  modelKey: string | null;
  reasoning_effort: string | null;
  display_mode?: "auto" | "herdr" | "tmux" | null;
  resolved_display_mode?: "auto" | "herdr" | "tmux" | null;
  underlying_error?: unknown;
}): Record<string, unknown> {
  return {
    code: params.code,
    message: params.message,
    selected_model_key: params.modelKey,
    reasoning_effort: params.reasoning_effort,
    requested_display_mode: params.display_mode ?? null,
    resolved_display_mode: params.resolved_display_mode ?? null,
    ...(params.underlying_error === undefined ? {} : { underlying_error: params.underlying_error }),
  };
}
