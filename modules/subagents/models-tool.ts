import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  buildModelDirectory,
  type CatalogModel,
  type ModelDirectory,
  type ModelDirectoryInput,
} from "./model-selector.ts";
import type { ModelHealthMap } from "./model-health.ts";
import type { ModelTier } from "./routing.ts";
import type { ListedAgentDefinition } from "./agents.ts";
import { detectDisplayModeAvailability, type DisplayModeAvailability } from "./surface.ts";

export interface AgentTypeSummary {
  readonly name: string;
  readonly display_name: string | null;
  readonly description: string;
  readonly capabilities: readonly string[];
}

// 角色定义层字段是 displayName（可缺席），线协议统一输出 display_name: string | null。
export function summarizeAgentTypes(agents: readonly (Pick<ListedAgentDefinition, "name" | "description" | "capabilities"> & { displayName?: string | null })[]): AgentTypeSummary[] {
  return agents.map((agent) => ({
    name: agent.name,
    display_name: agent.displayName ?? null,
    description: agent.description ?? "",
    capabilities: agent.capabilities ? [...agent.capabilities] : [],
  }));
}

export interface SubagentModelsResult extends ModelDirectory {
  readonly display_modes: readonly DisplayModeAvailability[];
  readonly agent_types: readonly AgentTypeSummary[];
}

export interface SubagentModelsToolDeps {
  readonly getPools: (cwd: string) => Partial<Record<ModelTier, readonly string[]>>;
  readonly getHealth?: (pool: readonly string[]) => ModelHealthMap;
  readonly getDisplayModes?: () => readonly DisplayModeAvailability[];
  /** 可选的宿主共享目录快照；spawn 与 models 必须复用同一接缝。 */
  readonly getModelDirectory?: (ctx: ExtensionContext) => SubagentModelsResult;
}

/** 组合模型目录、健康摘要和显示模式，保持三个来源读口独立。 */
export function buildSubagentModelsResult(input: ModelDirectoryInput & {
  readonly display_modes?: readonly DisplayModeAvailability[];
  readonly agent_types?: readonly AgentTypeSummary[];
}): SubagentModelsResult {
  return {
    ...buildModelDirectory(input),
    display_modes: input.display_modes ? [...input.display_modes] : [...detectDisplayModeAvailability()],
    agent_types: input.agent_types ? input.agent_types.map((agent) => ({
      name: agent.name,
      display_name: agent.display_name,
      description: agent.description,
      capabilities: [...agent.capabilities],
    })) : [],
  };
}

function currentModelFromContext(ctx: ExtensionContext): CatalogModel | null {
  const model = ctx.model;
  if (!model) return null;
  return model as unknown as CatalogModel;
}

// 与 SubagentModelsResult 镜像：改任一侧时同步另一侧；modelKey 刻意不设 pattern，
// 不透明键只能由目录发放，schema 不暗示脚本可自造。
const subagentModelsOutputSchema = Type.Object({
  catalog_version: Type.String(),
  generated_at: Type.String(),
  models: Type.Array(Type.Object({
    provider: Type.String(),
    id: Type.String(),
    api: Type.String(),
    baseUrl: Type.String(),
    name: Type.String(),
    modelKey: Type.Union([Type.String(), Type.Null()]),
    sources: Type.Array(Type.String()),
    reasoning_effort: Type.Array(Type.String()),
    resolvable: Type.Boolean(),
    resolution_reason: Type.Union([Type.String(), Type.Null()]),
    health: Type.Object({
      status: Type.String(),
      request_count: Type.Integer(),
      error_count: Type.Integer(),
      consecutive_error_count: Type.Integer(),
      last_error_at: Type.Union([Type.Number(), Type.Null()]),
      last_error_type: Type.Union([Type.String(), Type.Null()]),
      detail: Type.Union([Type.String(), Type.Null()]),
    }),
    availability: Type.Object({
      status: Type.Union([Type.Literal("available"), Type.Literal("credentials_unavailable"), Type.Literal("unknown")]),
      reason: Type.Union([Type.String(), Type.Null()]),
    }),
  })),
  display_modes: Type.Array(Type.Object({
    mode: Type.Union([Type.Literal("auto"), Type.Literal("herdr"), Type.Literal("tmux")]),
    available: Type.Boolean(),
    reason: Type.Union([Type.String(), Type.Null()]),
  })),
  agent_types: Type.Array(Type.Object({
    name: Type.String(),
    display_name: Type.Union([Type.String(), Type.Null()]),
    description: Type.String(),
    capabilities: Type.Array(Type.String()),
  })),
});

export function registerSubagentModelsTool(
  pi: ExtensionAPI,
  deps: SubagentModelsToolDeps,
): void {
  pi.registerTool({
    name: "subagent_models",
    label: "Subagent Models",
    description:
      "Read the current subagent model directory. Returns opaque modelKey values, " +
      "host-supported reasoning_effort values, health summaries, and display mode availability. " +
      "Read the directory again after a catalog refresh; model keys are versioned.",
    promptSnippet:
      "Read the complete current model directory and display mode availability before choosing a model for spawn_agent.",
    parameters: Type.Object({}),
    outputSchema: subagentModelsOutputSchema,
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd ?? process.cwd();
      const pools = deps.getPools(cwd);
      const poolModels = Object.values(pools).flatMap((pool) => pool ?? []);
      const health = deps.getHealth?.(poolModels);
      const directory = deps.getModelDirectory?.(ctx) ?? buildSubagentModelsResult({
        currentModel: currentModelFromContext(ctx),
        pools,
        modelRegistry: ctx.modelRegistry,
        health,
        display_modes: deps.getDisplayModes?.() ?? detectDisplayModeAvailability(),
      });
      return {
        content: [{ type: "text", text: JSON.stringify(directory) }],
        details: directory,
        structuredContent: directory as unknown as AgentToolResult["structuredContent"],
      };
    },
  });
}
