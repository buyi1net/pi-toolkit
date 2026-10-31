import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type ModuleContext, type ModuleDefinition } from "../../kit/module.ts";
import { USAGE_RECORDER_SERVICE_NAME, type UsageRecorderService } from "../usage/api.ts";
import {
  loadEffectiveTierConfig,
  MODEL_TIERS,
  subagentsSectionPath,
  SUBAGENTS_MODULE_ID,
  type ModelTier,
} from "./config.ts";
import {
  createModelErrorJournal,
  createProvidersHealthGateway,
  poolBaseRefs,
  type ModelHealthMap,
} from "./model-health.ts";
import { buildSubagentsTopLevel, SUBAGENTS_ENABLED_FIELD } from "./menu.ts";
import subagentsExtension, {
  subagentsRunningView,
  type SubagentsHostSection,
} from "./mod.ts";
import type { RuntimeRecord } from "./registry.ts";

export { SUBAGENTS_MODULE_ID } from "./config.ts";
export type { ModelHealthMap, ModelRuntimeStatus } from "./model-health.ts";

export type {
  RoutingInheritanceCause,
  RoutingModelOrigin,
} from "./routing-snapshot.ts";

export const SUBAGENTS_SERVICE_NAME = "subagents.running";

export const SUBAGENTS_MODELS_SERVICE_NAME = "subagents.models";

export interface SubagentsService {
  readonly id: "subagents";

  runningCount(): number;

  runningNames(): readonly string[];

  runtimeRecords(sessionDir: string, sessionId: string): RuntimeRecord[];
}

export interface SubagentsModelPoolView {
  readonly tier: ModelTier;
  readonly models: readonly string[];
}

export interface SubagentsModelsService {
  readonly id: "subagents";

  pools(cwd?: string): readonly SubagentsModelPoolView[];

  health(pool: readonly string[]): ModelHealthMap;
}

function registerSubagents(context: ModuleContext): void {

  const modelErrorJournal = createModelErrorJournal();

  const modelHealth = createProvidersHealthGateway(context.services, modelErrorJournal);

  subagentsExtension(context.pi, {
    readHostSection: (): SubagentsHostSection => ({
      source: subagentsSectionPath(),
      section: context.getConfig(),
    }),
    modelHealth,
    modelErrorJournal,

    recordUsage: (event) => {
      context.services.get<UsageRecorderService>(USAGE_RECORDER_SERVICE_NAME)?.record(event);
    },

    t: context.t,
  });

  context.services.register(SUBAGENTS_SERVICE_NAME, {
    id: "subagents",

    ...subagentsRunningView,
  } satisfies SubagentsService);

  context.services.register(SUBAGENTS_MODELS_SERVICE_NAME, {
    id: "subagents",
    pools(cwd?: string): readonly SubagentsModelPoolView[] {
      const loaded = loadEffectiveTierConfig({ cwd: cwd ?? process.cwd() });
      if (loaded.error || !loaded.config) return [];
      const config = loaded.config;
      return MODEL_TIERS.flatMap((tier: ModelTier) => {
        const models = config.tiers[tier].pool;
        return models && models.length > 0 ? [{ tier, models: poolBaseRefs(models) }] : [];
      });
    },
    health(pool: readonly string[]): ModelHealthMap {
      return modelHealth.read(pool);
    },
  } satisfies SubagentsModelsService);
}

export function createSubagentsModule(): ModuleDefinition {
  return {
    id: SUBAGENTS_MODULE_ID,
    labelKey: "module.subagents.label",
    descriptionKey: "module.subagents.description",
    group: "subagents",

    configSchema: {
      enabled: SUBAGENTS_ENABLED_FIELD,
    },
    register(context): void {
      registerSubagents(context);
    },
    topLevel(context): ReturnType<typeof buildSubagentsTopLevel> {
      return buildSubagentsTopLevel(context);
    },
  };
}

export const subagentsModule: ModuleDefinition = createSubagentsModule();
