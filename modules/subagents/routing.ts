import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url));

export type ModelTier = "fast" | "balanced" | "flagship";

export const MODEL_TIERS: readonly ModelTier[] = ["fast", "balanced", "flagship"];

export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export function isThinkingLevel(value: string): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

export function normalizeThinkingLevel(input: string): ThinkingLevel | null {
  const value = input.trim().toLowerCase();
  return isThinkingLevel(value) ? value : null;
}

export function modelOwnThinkingSuffix(
  model: string | null | undefined,
): ThinkingLevel | null {
  if (!model) return null;
  const match = /^(.+):([a-z]+)$/.exec(model);
  return match && isThinkingLevel(match[2]) ? match[2] : null;
}

export function baseModelRef(ref: string): string {
  const own = modelOwnThinkingSuffix(ref);
  return own ? ref.slice(0, ref.length - own.length - 1) : ref;
}

export interface DuplicateBaseRef {

  readonly base: string;

  readonly first: string;

  readonly second: string;
}

export function findDuplicateBaseRef(pool: readonly string[]): DuplicateBaseRef | null {
  const seen = new Map<string, string>();
  for (const candidate of pool) {
    const base = baseModelRef(candidate);
    const previous = seen.get(base);
    if (previous !== undefined) return { base, first: previous, second: candidate };
    seen.set(base, candidate);
  }
  return null;
}

const TIER_ALIASES: Record<ModelTier, string[]> = {
  fast: ["fast", "quick"],
  balanced: ["balanced", "balance", "standard"],
  flagship: ["flagship", "deep", "strong"],
};

export function normalizeTier(input: string): ModelTier | null {
  const value = input.trim().toLowerCase();
  for (const tier of MODEL_TIERS) {
    if (TIER_ALIASES[tier].includes(value)) return tier;
  }
  return null;
}

export interface TierRouteConfig {

  models: Partial<Record<ModelTier, string[]>>;

  thinking: Partial<Record<ModelTier, ThinkingLevel>>;

  sourcePath: string;
}

export type TierConfigParseResult = { config: TierRouteConfig } | { error: string };

export interface EffectiveTierRoute {

  readonly pool: string[] | undefined;

  readonly poolSource: string | null;

  readonly thinking: ThinkingLevel | undefined;

  readonly thinkingSource: string | null;
}

export interface EffectiveTierRouteConfig {

  readonly tiers: Readonly<Record<ModelTier, EffectiveTierRoute>>;

  readonly problems: readonly string[];
}

export function effectiveTierMapping(effective: EffectiveTierRouteConfig): Partial<Record<ModelTier, string[]>> {
  const mapping: Partial<Record<ModelTier, string[]>> = {};
  for (const tier of MODEL_TIERS) {
    const pool = effective.tiers[tier].pool;
    if (pool) mapping[tier] = [...pool];
  }
  return mapping;
}

function resolveTierKey(
  kind: "models" | "thinking",
  key: string,
  source: string,
): { tier: ModelTier } | { error: string } {
  const tier = normalizeTier(key);
  if (!tier) {
    return {
      error: `${source}: ${kind} has unsupported tier key "${key}" (use ${MODEL_TIERS.join(", ")})`,
    };
  }
  return { tier };
}

function checkTierAlias(
  kind: "models" | "thinking",
  tier: ModelTier,
  key: string,
  aliasOwner: Map<ModelTier, string>,
  source: string,
): { ok: true } | { error: string } {
  const previousKey = aliasOwner.get(tier);
  if (previousKey !== undefined) {
    return {
      error: `${source}: ${kind} has conflicting entries for tier "${tier}" ("${previousKey}" and "${key}")`,
    };
  }
  aliasOwner.set(tier, key);
  return { ok: true };
}

function checkTierPool(
  key: string,
  value: unknown,
  source: string,
): { pool: string[] } | { error: string } {
  if (!Array.isArray(value)) {
    return {
      error: `${source}: models.${key} must be a non-empty array of model ids (ordered candidate pool)`,
    };
  }
  if (value.length === 0) {
    return { error: `${source}: models.${key} candidate pool must not be empty` };
  }
  const pool: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const candidate = value[index];
    if (typeof candidate !== "string" || candidate.trim() === "") {
      return { error: `${source}: models.${key}[${index}] must be a non-empty model id` };
    }
    if (/\s/.test(candidate)) {
      return { error: `${source}: models.${key}[${index}] must not contain whitespace` };
    }
    pool.push(candidate);
  }
  const duplicate = findDuplicateBaseRef(pool);
  if (duplicate) {
    return {
      error:
        `${source}: models.${key} has duplicate candidates for base model "${duplicate.base}" ` +
        `("${duplicate.first}" and "${duplicate.second}")`,
    };
  }
  return { pool };
}

function checkTierThinking(
  key: string,
  value: unknown,
  source: string,
): { level: ThinkingLevel | undefined } | { error: string } {
  if (value === null) return { level: undefined };
  if (typeof value !== "string" || !isThinkingLevel(value)) {
    return {
      error:
        `${source}: thinking.${key} must be one of: ${THINKING_LEVELS.join(", ")} ` +
        `(or null to unset); got ${String(value)}`,
    };
  }
  return { level: value };
}

export function parseTierConfig(raw: unknown, source: string): TierConfigParseResult {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: `${source}: root must be a JSON object` };
  }
  const root = raw as Record<string, unknown>;
  const thinking = parseTierThinking(root.thinking, source);
  if ("error" in thinking) return { error: thinking.error };
  const rawModels = root.models;
  if (rawModels === undefined) {

    return { config: { models: {}, thinking: thinking.thinking, sourcePath: source } };
  }
  if (rawModels == null || typeof rawModels !== "object" || Array.isArray(rawModels)) {
    return { error: `${source}: models must be an object` };
  }
  const models: Partial<Record<ModelTier, string[]>> = {};
  const aliasOwner = new Map<ModelTier, string>();
  for (const [key, value] of Object.entries(rawModels as Record<string, unknown>)) {
    const resolved = resolveTierKey("models", key, source);
    if ("error" in resolved) return { error: resolved.error };
    const pooled = checkTierPool(key, value, source);
    if ("error" in pooled) return { error: pooled.error };
    const alias = checkTierAlias("models", resolved.tier, key, aliasOwner, source);
    if ("error" in alias) return { error: alias.error };
    models[resolved.tier] = pooled.pool;
  }
  return { config: { models, thinking: thinking.thinking, sourcePath: source } };
}

function parseTierThinking(
  raw: unknown,
  source: string,
): { thinking: Partial<Record<ModelTier, ThinkingLevel>> } | { error: string } {
  if (raw === undefined) return { thinking: {} };
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: `${source}: thinking must be an object` };
  }
  const thinking: Partial<Record<ModelTier, ThinkingLevel>> = {};
  const aliasOwner = new Map<ModelTier, string>();
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const resolved = resolveTierKey("thinking", key, source);
    if ("error" in resolved) return { error: resolved.error };
    const alias = checkTierAlias("thinking", resolved.tier, key, aliasOwner, source);
    if ("error" in alias) return { error: alias.error };
    const checked = checkTierThinking(key, value, source);
    if ("error" in checked) return { error: checked.error };
    if (checked.level !== undefined) thinking[resolved.tier] = checked.level;
  }
  return { thinking };
}

interface TierLayerEntries {
  readonly models: Partial<Record<ModelTier, string[]>>;

  readonly thinking: Partial<Record<ModelTier, ThinkingLevel | null>>;
  readonly problems: readonly string[];
}

export interface LenientTierView {
  readonly models: Partial<Record<ModelTier, string[]>>;
  readonly thinking: Partial<Record<ModelTier, ThinkingLevel>>;
  readonly problems: readonly string[];
}

export function parseTierConfigLenient(raw: unknown, source: string): LenientTierView {
  const entries = parseTierLayerEntries(raw, source);
  const thinking: Partial<Record<ModelTier, ThinkingLevel>> = {};
  for (const tier of MODEL_TIERS) {
    const level = entries.thinking[tier];
    if (level != null) thinking[tier] = level;
  }
  return { models: entries.models, thinking, problems: entries.problems };
}

function parseTierLayerEntries(raw: unknown, source: string): TierLayerEntries {
  const models: Partial<Record<ModelTier, string[]>> = {};
  const thinking: Partial<Record<ModelTier, ThinkingLevel | null>> = {};
  const problems: string[] = [];

  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { models, thinking, problems: [`${source}: root must be a JSON object`] };
  }
  const root = raw as Record<string, unknown>;

  const rawThinking = root.thinking;
  if (rawThinking !== undefined) {
    if (rawThinking == null || typeof rawThinking !== "object" || Array.isArray(rawThinking)) {
      problems.push(`${source}: thinking must be an object`);
    } else {
      const aliasOwner = new Map<ModelTier, string>();
      for (const [key, value] of Object.entries(rawThinking as Record<string, unknown>)) {
        const resolved = resolveTierKey("thinking", key, source);
        if ("error" in resolved) {
          problems.push(resolved.error);
          continue;
        }
        const alias = checkTierAlias("thinking", resolved.tier, key, aliasOwner, source);
        if ("error" in alias) {
          problems.push(alias.error);
          continue;
        }
        const checked = checkTierThinking(key, value, source);
        if ("error" in checked) {
          problems.push(checked.error);
          continue;
        }
        thinking[resolved.tier] = checked.level ?? null;
      }
    }
  }

  const rawModels = root.models;
  if (rawModels !== undefined) {
    if (rawModels == null || typeof rawModels !== "object" || Array.isArray(rawModels)) {
      problems.push(`${source}: models must be an object`);
    } else {
      const aliasOwner = new Map<ModelTier, string>();
      for (const [key, value] of Object.entries(rawModels as Record<string, unknown>)) {
        const resolved = resolveTierKey("models", key, source);
        if ("error" in resolved) {
          problems.push(resolved.error);
          continue;
        }
        const pooled = checkTierPool(key, value, source);
        if ("error" in pooled) {
          problems.push(pooled.error);
          continue;
        }
        const alias = checkTierAlias("models", resolved.tier, key, aliasOwner, source);
        if ("error" in alias) {
          problems.push(alias.error);
          continue;
        }
        models[resolved.tier] = pooled.pool;
      }
    }
  }

  return { models, thinking, problems };
}

function mergeTierLayers(
  layers: ReadonlyArray<{ readonly source: string } & TierLayerEntries>,
): EffectiveTierRouteConfig {
  const problems: string[] = [];
  type MutableTierRoute = {
    pool: string[] | undefined;
    poolSource: string | null;
    thinking: ThinkingLevel | undefined;
    thinkingSource: string | null;
  };
  const tiers = {} as Record<ModelTier, MutableTierRoute>;
  for (const tier of MODEL_TIERS) {
    tiers[tier] = { pool: undefined, poolSource: null, thinking: undefined, thinkingSource: null };
  }
  for (const layer of layers) {
    problems.push(...layer.problems);
    for (const tier of MODEL_TIERS) {
      const current = tiers[tier];
      if (current.pool === undefined) {
        const pool = layer.models[tier];
        if (pool !== undefined) {
          current.pool = pool;
          current.poolSource = layer.source;
        }
      }
      if (
        current.thinkingSource === null &&
        Object.prototype.hasOwnProperty.call(layer.thinking, tier)
      ) {
        const level = layer.thinking[tier];
        current.thinking = level ?? undefined;
        current.thinkingSource = layer.source;
      }
    }
  }
  return { tiers, problems };
}

export interface TierConfigLoadResult {

  config: EffectiveTierRouteConfig | null;

  sourcePath: string | null;

  error?: string;
}

export interface TierRouteInjectedSource {
  readonly source: string;
  readonly raw: unknown;
}

export function loadTierRouteConfig(options?: {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  agentConfigDir?: string;

  injected?: readonly TierRouteInjectedSource[];
}): TierConfigLoadResult {
  const env = options?.env ?? process.env;
  const cwd = options?.cwd ?? process.cwd();

  const agentConfigDir =
    options?.agentConfigDir ?? env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

  const explicit = env.PI_SUBAGENTS_CONFIG?.trim();
  if (explicit) {
    const locked = loadExplicitTierFile(explicit);
    if ("error" in locked) {
      return { config: null, sourcePath: explicit, error: locked.error };
    }
    return { config: mergeTierLayers([{ source: explicit, ...locked.entries }]), sourcePath: explicit };
  }

  const layers: Array<{ source: string } & TierLayerEntries> = [];
  const filePaths = [
    join(cwd, ".pi", "agent", "pi-subagents.json"),
    join(agentConfigDir, "pi-subagents.json"),
  ];
  for (const path of filePaths) {
    const loaded = loadTierFileLayer(path);
    if (typeof loaded === "string") return { config: null, sourcePath: path, error: loaded };
    if (loaded) layers.push(loaded);
  }
  for (const source of options?.injected ?? []) {
    layers.push({ source: source.source, ...parseTierLayerEntries(source.raw, source.source) });
  }
  for (const path of [join(PACKAGE_ROOT, "config.json"), join(PACKAGE_ROOT, "config.json.example")]) {
    const loaded = loadTierFileLayer(path);
    if (typeof loaded === "string") return { config: null, sourcePath: path, error: loaded };
    if (loaded) layers.push(loaded);
  }
  return { config: mergeTierLayers(layers), sourcePath: null };
}

type TierFileRead =
  | { kind: "missing" }
  | { kind: "read-error"; message: string }
  | { kind: "json-error"; message: string }
  | { kind: "ok"; raw: unknown };

function readTierFileRaw(path: string): TierFileRead {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") return { kind: "missing" };
    return { kind: "read-error", message: `Could not read ${path}: ${errno.message ?? String(error)}` };
  }
  try {
    return { kind: "ok", raw: JSON.parse(raw) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { kind: "json-error", message: `Invalid JSON in ${path}: ${detail}` };
  }
}

function loadExplicitTierFile(path: string): { entries: TierLayerEntries } | { error: string } {
  const read = readTierFileRaw(path);
  if (read.kind === "missing") {
    return { error: `PI_SUBAGENTS_CONFIG points to a missing file: ${path}` };
  }
  if (read.kind === "read-error" || read.kind === "json-error") {
    return { error: read.message };
  }
  const strict = parseTierConfig(read.raw, path);
  if ("error" in strict) return { error: strict.error };
  return { entries: parseTierLayerEntries(read.raw, path) };
}

function loadTierFileLayer(path: string): ({ source: string } & TierLayerEntries) | null | string {
  const read = readTierFileRaw(path);
  if (read.kind === "missing") return null;
  if (read.kind === "read-error") return read.message;
  if (read.kind === "json-error") {
    return { source: path, models: {}, thinking: {}, problems: [read.message] };
  }
  return { source: path, ...parseTierLayerEntries(read.raw, path) };
}

export function tierModelPool(
  tier: ModelTier,
  config: EffectiveTierRouteConfig | null,
): { pool: string[] } | { error: string } {
  const pool = config?.tiers[tier].pool;
  if (!pool || pool.length === 0) {
    const hint = config
      ? ` Add models.${tier} to a pi-subagents config layer ` +
        "(project .pi/agent/pi-subagents.json, global pi-subagents.json, " +
        "or pi-toolkit.json modules.subagents)."
      : " No pi-subagents config was found (looked at $PI_SUBAGENTS_CONFIG, " +
        "<cwd>/.pi/agent/pi-subagents.json, $PI_CODING_AGENT_DIR/pi-subagents.json, " +
        "and the package config).";
    return { error: `No model configured for tier "${tier}".${hint}` };
  }
  return { pool };
}

export function resolveTierModel(
  tier: ModelTier,
  config: EffectiveTierRouteConfig | null,
): { model: string } | { error: string } {
  const pool = tierModelPool(tier, config);
  if ("error" in pool) return { error: pool.error };
  return { model: pool.pool[0] };
}

export type TierLaunchResolution =
  | { tier: ModelTier | null; model?: string; thinking?: ThinkingLevel }
  | { error: string };

export type TierPoolResolution =
  | { tier: ModelTier | null; pool?: string[]; thinking?: ThinkingLevel; fallbackReason?: "pool-unconfigured" }
  | { error: string };

export function resolveTierPoolForParams(
  params: { tier?: string; model?: string; agentTier?: string },
  loadConfig: () => TierConfigLoadResult,
): TierPoolResolution {

  const requested = params.tier?.trim() || params.agentTier?.trim();
  if (!requested) return { tier: null };

  if (params.model) return { tier: normalizeTier(requested) };
  const tier = normalizeTier(requested);
  if (!tier) {
    return {
      error:
        `Invalid tier "${params.tier}". Use one of: ${MODEL_TIERS.join(", ")} ` +
        "(aliases: quick, balance/standard, deep/strong).",
    };
  }
  const loaded = loadConfig();
  if (loaded.error) {
    return { error: `Tier "${tier}" could not be resolved: ${loaded.error}` };
  }
  const pool = tierModelPool(tier, loaded.config);
  if ("error" in pool) return { tier, fallbackReason: "pool-unconfigured" };
  const tierThinking = loaded.config?.tiers[tier].thinking ?? undefined;
  return { tier, pool: pool.pool, ...(tierThinking ? { thinking: tierThinking } : {}) };
}

export function resolveTierForParams(
  params: { tier?: string; model?: string; agentTier?: string },
  loadConfig: () => TierConfigLoadResult,
): TierLaunchResolution {
  const resolved = resolveTierPoolForParams(params, loadConfig);
  if ("error" in resolved) return { error: resolved.error };
  if (resolved.pool === undefined) return { tier: resolved.tier };
  return {
    tier: resolved.tier,
    model: resolved.pool[0],
    ...(resolved.thinking ? { thinking: resolved.thinking } : {}),
  };
}
