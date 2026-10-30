import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  buildModelDirectory,
  type CatalogModel,
  type ModelDirectory,
  type ModelDirectoryInput,
} from "./model-selector.ts";
import type { ModelHealthMap } from "./model-health.ts";
import type { ModelTier } from "./routing.ts";
import { detectDisplayModeAvailability, type DisplayModeAvailability } from "./surface.ts";

export interface SubagentModelsResult extends ModelDirectory {
  readonly display_modes: readonly DisplayModeAvailability[];
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
}): SubagentModelsResult {
  return {
    ...buildModelDirectory(input),
    display_modes: input.display_modes ? [...input.display_modes] : [...detectDisplayModeAvailability()],
  };
}

function currentModelFromContext(ctx: ExtensionContext): CatalogModel | null {
  const model = ctx.model;
  if (!model) return null;
  return model as unknown as CatalogModel;
}

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
      };
    },
  });
}
