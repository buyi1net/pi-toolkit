import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { renderToolCardCall, renderToolCardResult } from "../../kit/tool-card.ts";
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
import type { SubagentsTranslate } from "./messages/index.ts";

export interface AgentTypeSummary {
  readonly name: string;
  readonly display_name: string | null;
  readonly description: string;
  readonly capabilities: readonly string[];
}

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

  readonly getModelDirectory?: (ctx: ExtensionContext) => SubagentModelsResult;
  readonly t?: SubagentsTranslate;
}

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

function modelRenderLine(model: SubagentModelsResult["models"][number]): string {
  const route = `${model.provider}/${model.id}`.replace(/\s+/g, " ");
  const reasoning = model.reasoning_effort.length > 0 ? model.reasoning_effort.join(", ") : "none";
  return `${route} — reasoning: ${reasoning}`;
}

const subagentModelsOutputSchema = Type.Object({
  generated_at: Type.String(),
  models: Type.Array(Type.Object({
    provider: Type.String(),
    id: Type.String(),
    api: Type.String(),
    baseUrl: Type.String(),
    name: Type.String(),
    sources: Type.Array(Type.String()),
    reasoning_effort: Type.Array(Type.String()),
    health: Type.Object({
      status: Type.String(),
      request_count: Type.Integer(),
      error_count: Type.Integer(),
      consecutive_error_count: Type.Integer(),
      last_error_at: Type.Union([Type.Number(), Type.Null()]),
      last_error_type: Type.Union([Type.String(), Type.Null()]),
      detail: Type.Union([Type.String(), Type.Null()]),
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
    renderShell: "self",
    description:
      "Read the current /model available subagent models. Each entry includes a provider, model id, display name, " +
      "host-supported reasoning_effort values, health facts, and display mode availability. " +
      "Use a unique id or name in spawn_agent; when several providers expose the same name, pass provider/model.",
    promptSnippet:
      "Read the current available model directory before choosing a model for spawn_agent.",
    parameters: Type.Object({}),
    outputSchema: subagentModelsOutputSchema,
    renderCall(_args, theme, context) {
      return renderToolCardCall({ title: deps.t?.("module.subagents.tool.subagent_models.display") ?? "Read available models" }, theme, context);
    },
    renderResult(result, options, theme, context) {
      const details = result.details as Partial<SubagentModelsResult> | undefined;
      const models = Array.isArray(details?.models) ? details.models : [];
      const summary = deps.t?.("module.subagents.tool.subagent_models.result.summary", { count: models.length })
        ?? `${models.length} available model${models.length === 1 ? "" : "s"}`;
      const rows = options.expanded ? models.map((model) => modelRenderLine(model)) : [];
      return renderToolCardResult(
        { title: deps.t?.("module.subagents.tool.subagent_models.display") ?? "Read available models", status: summary, details: rows },
        theme,
        options,
        context,
      );
    },
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
