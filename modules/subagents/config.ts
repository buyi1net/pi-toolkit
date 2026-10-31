import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getToolkitConfigPath } from "../../kit/config.ts";
import type { ModuleConfigRecord } from "../../kit/module.ts";
import {
  MODEL_TIERS,
  THINKING_LEVELS,
  effectiveTierMapping,
  normalizeTier,
  parseTierConfig,
  parseTierConfigLenient,
  resolveTierForParams,
  loadTierRouteConfig,
  type EffectiveTierRouteConfig,
  type ModelTier,
  type ThinkingLevel,
  type TierConfigLoadResult,
} from "./routing.ts";
import { getAgentConfigDir, resolveHostTierSources } from "./mod.ts";
import type { DisplayContext, DisplayMode } from "./surface.ts";

export const SUBAGENTS_MODULE_ID = "subagents";

export type { DisplayContext, DisplayMode };

export interface DisplayModeConfig {
  readonly displayMode: DisplayMode;
  readonly displayModeByContext: Readonly<Partial<Record<DisplayContext, DisplayMode>>>;
}

const DISPLAY_MODES: readonly DisplayMode[] = ["auto", "herdr", "tmux"];
const DISPLAY_CONTEXTS: readonly DisplayContext[] = ["terminal", "nested", "herdr", "tmux"];

export function isDisplayMode(value: unknown): value is DisplayMode {
  return typeof value === "string" && DISPLAY_MODES.includes(value as DisplayMode);
}

export function isDisplayContext(value: unknown): value is DisplayContext {
  return typeof value === "string" && DISPLAY_CONTEXTS.includes(value as DisplayContext);
}

export function readDisplayModeConfig(section: Record<string, unknown>): DisplayModeConfig {
  const displayMode = isDisplayMode(section.displayMode) ? section.displayMode : "auto";
  const raw = section.displayModeByContext;
  const displayModeByContext: Partial<Record<DisplayContext, DisplayMode>> = {};
  if (isPlainObject(raw)) {
    for (const context of DISPLAY_CONTEXTS) {
      if (isDisplayMode(raw[context])) displayModeByContext[context] = raw[context];
    }
  }
  return { displayMode, displayModeByContext };
}

export function resolveDisplayMode(options: {
  readonly requested?: unknown;
  readonly context: DisplayContext;
  readonly config?: Record<string, unknown> | DisplayModeConfig;
}): DisplayMode {
  const config = options.config && "displayMode" in options.config
    ? options.config as DisplayModeConfig
    : readDisplayModeConfig((options.config ?? {}) as Record<string, unknown>);
  if (isDisplayMode(options.requested)) return options.requested;
  return config.displayModeByContext[options.context] ?? config.displayMode ?? "auto";
}

export function displayModePatch(mode: DisplayMode, context?: DisplayContext): ModuleConfigRecord {
  if (context === undefined) return { displayMode: mode };
  return { displayModeByContext: { [context]: mode } };
}

export const DISPLAY_MODE_VALUES = DISPLAY_MODES;
export const DISPLAY_CONTEXT_VALUES = DISPLAY_CONTEXTS;

export { MODEL_TIERS, THINKING_LEVELS, effectiveTierMapping, normalizeTier };
export type { EffectiveTierRouteConfig, ModelTier, ThinkingLevel, TierConfigLoadResult };

export type TierMapping = Partial<Record<ModelTier, string[]>>;

export type TierThinkingMapping = Partial<Record<ModelTier, ThinkingLevel>>;

export interface SubagentsSectionView {

  readonly tier: TierMapping;

  readonly tierThinking: TierThinkingMapping;

  readonly statusEnabled: boolean;
  readonly problems: readonly string[];

  readonly tierProblems: readonly string[];
}

const SECTION_LABEL = `modules.${SUBAGENTS_MODULE_ID}`;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readSubagentsSection(section: Record<string, unknown>): SubagentsSectionView {
  const lenient = parseTierConfigLenient({ models: section.models }, SECTION_LABEL);
  const tier: TierMapping = { ...lenient.models };

  const tierThinking: TierThinkingMapping = {};
  const tierProblems: readonly string[] = [...lenient.problems];
  const problems: string[] = [...tierProblems];

  return { tier, tierThinking, statusEnabled: true, problems, tierProblems };
}

export function subagentsSectionPath(agentDir?: string): string {
  return `${getToolkitConfigPath(agentDir ?? getAgentDir())} (${SECTION_LABEL})`;
}

export function loadEffectiveTierConfig(options?: {
  readonly cwd?: string;
  readonly agentDir?: string;
}): TierConfigLoadResult {
  return loadTierRouteConfig({
    cwd: options?.cwd ?? process.cwd(),
    agentConfigDir: options?.agentDir ?? getAgentConfigDir(),
    injected: resolveHostTierSources(),
  });
}

export function tierRouteError(tier: ModelTier, load: () => TierConfigLoadResult): string | undefined {
  const resolution = resolveTierForParams({ tier }, load);
  return "error" in resolution ? resolution.error : undefined;
}

function assertModelPool(tier: ModelTier, pool: readonly string[], source: string): void {
  if (pool.length === 0) return;
  const checked = parseTierConfig({ models: { [tier]: [...pool] } }, source);
  if ("error" in checked) throw new Error(checked.error);
}

export function tierThinkingPatch(
  tier: ModelTier,
  level: ThinkingLevel | null,
  source: string,
): ModuleConfigRecord {
  const checked = parseTierConfig({ thinking: { [tier]: level } }, source);
  if ("error" in checked) throw new Error(checked.error);
  return { thinking: { [tier]: level } };
}

export function tierPoolPatch(
  tier: ModelTier,
  pool: readonly string[],
  source: string,
): ModuleConfigRecord {
  assertModelPool(tier, pool, source);
  return { models: { [tier]: [...pool] } };
}

export function tierTakeoverPatch(
  tier: ModelTier,
  pool: readonly string[],
  thinking: ThinkingLevel | null | undefined,
  source: string,
): ModuleConfigRecord {
  assertModelPool(tier, pool, source);
  if (thinking === undefined) return { models: { [tier]: [...pool] } };
  const checked = parseTierConfig({ thinking: { [tier]: thinking } }, source);
  if ("error" in checked) throw new Error(checked.error);
  return { models: { [tier]: [...pool] }, thinking: { [tier]: thinking } };
}
