import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

// routing.ts → 模块目录(一层向上),与 status.ts 的 PACKAGE_ROOT 同规则。
const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url));

/** 规范档位;配置与 params 都归一化到这三个值。 */
export type ModelTier = "fast" | "balanced" | "deep";

export const MODEL_TIERS: readonly ModelTier[] = ["fast", "balanced", "deep"];

/**
 * tier 别名表:params 与配置键共用,归一化到 canonical。刻意保持最小集合,
 * 不再扩大别名——同一含义多个写法只增加配置歧义。
 */
const TIER_ALIASES: Record<ModelTier, string[]> = {
  fast: ["fast", "quick"],
  balanced: ["balanced", "balance", "standard"],
  deep: ["deep", "strong"],
};

/** 归一化 tier 输入;无法识别返回 null,调用方必须报清晰错误,不得静默换档。 */
export function normalizeTier(input: string): ModelTier | null {
  const value = input.trim().toLowerCase();
  for (const tier of MODEL_TIERS) {
    if (TIER_ALIASES[tier].includes(value)) return tier;
  }
  return null;
}

export interface TierRouteConfig {
  /** tier → 模型 id(可带 ":thinking" 后缀,由启动参数构造层统一处理)。 */
  models: Partial<Record<ModelTier, string>>;
  /** 配置来源文件路径,用于错误提示定位。 */
  sourcePath: string;
}

export type TierConfigParseResult = { config: TierRouteConfig } | { error: string };

/**
 * 严格校验 tier 配置。根对象允许携带其它键(包级 config.json 与 status 配置
 * 共用同一文件,这里只认 models);models 内部从严:未知 tier 键、非字符串、
 * 空串、含空白、同 tier 别名重复都报错。models 缺失视为合法但无映射。
 */
export function parseTierConfig(raw: unknown, source: string): TierConfigParseResult {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: `${source}: root must be a JSON object` };
  }
  const root = raw as Record<string, unknown>;
  const rawModels = root.models;
  if (rawModels === undefined) {
    return { config: { models: {}, sourcePath: source } };
  }
  if (rawModels == null || typeof rawModels !== "object" || Array.isArray(rawModels)) {
    return { error: `${source}: models must be an object` };
  }
  const models: Partial<Record<ModelTier, string>> = {};
  const aliasOwner = new Map<ModelTier, string>();
  for (const [key, value] of Object.entries(rawModels as Record<string, unknown>)) {
    const tier = normalizeTier(key);
    if (!tier) {
      return {
        error: `${source}: models has unsupported tier key "${key}" (use ${MODEL_TIERS.join(", ")})`,
      };
    }
    if (typeof value !== "string" || value.trim() === "") {
      return { error: `${source}: models.${key} must be a non-empty string` };
    }
    if (/\s/.test(value)) {
      return { error: `${source}: models.${key} must not contain whitespace` };
    }
    const previousKey = aliasOwner.get(tier);
    if (previousKey !== undefined) {
      return {
        error: `${source}: models has conflicting entries for tier "${tier}" ("${previousKey}" and "${key}")`,
      };
    }
    aliasOwner.set(tier, key);
    models[tier] = value;
  }
  return { config: { models, sourcePath: source } };
}

export interface TierConfigLoadResult {
  /** null 表示没有任何配置文件(合法;仅在使用 tier 时才需要报错)。 */
  config: TierRouteConfig | null;
  /** 实际读取(或读取失败)的配置路径;一个都没找到时为 null。 */
  sourcePath: string | null;
  /** 显式指定(PI_SUBAGENTS_CONFIG)的文件缺失/解析失败时的错误。 */
  error?: string;
}

/**
 * 宿主注入的配置层(pi-toolkit 迁入后新增):调用方已经把 `subagents` 节解析好,
 * 这里只负责把它按优先级插进候选链。`source` 仅用于错误提示定位。
 */
export interface TierRouteInjectedSource {
  readonly source: string;
  readonly raw: unknown;
}

/**
 * 配置读取链:PI_SUBAGENTS_CONFIG → <cwd>/.pi/agent/pi-subagents.json →
 * PI_CODING_AGENT_DIR(缺省 ~/.pi/agent)/pi-subagents.json → 宿主注入层
 * (pi-toolkit.json 的 `modules.subagents` 节) → 包 config.json →
 * 包 config.json.example。第一个存在的文件即最终答案;显式环境变量指向的
 * 文件缺失或非法视为配置错误,其余候选缺失只跳过。纯读取,不写盘,
 * 不触碰凭据/余额。
 */
export function loadTierRouteConfig(options?: {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  agentConfigDir?: string;
  /** 宿主注入的额外候选层,排在全局 pi-subagents.json 之后、包内文件之前 */
  injected?: readonly TierRouteInjectedSource[];
}): TierConfigLoadResult {
  const env = options?.env ?? process.env;
  const cwd = options?.cwd ?? process.cwd();
  // 与 index.ts getAgentConfigDir 同规则;以参数注入避免模块反向依赖。
  const agentConfigDir =
    options?.agentConfigDir ?? env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

  const candidates: Array<{ path: string; explicit: boolean; raw?: unknown }> = [];
  const explicit = env.PI_SUBAGENTS_CONFIG?.trim();
  if (explicit) candidates.push({ path: explicit, explicit: true });
  candidates.push(
    { path: join(cwd, ".pi", "agent", "pi-subagents.json"), explicit: false },
    { path: join(agentConfigDir, "pi-subagents.json"), explicit: false },
  );
  for (const source of options?.injected ?? []) {
    candidates.push({ path: source.source, explicit: false, raw: source.raw });
  }
  candidates.push(
    { path: join(PACKAGE_ROOT, "config.json"), explicit: false },
    { path: join(PACKAGE_ROOT, "config.json.example"), explicit: false },
  );

  for (const candidate of candidates) {
    let parsed: unknown;
    if (candidate.raw !== undefined) {
      // 宿主注入层:调用方已经读过一次(pi-toolkit.json 是宿主自己的文件),
      // 这里直接吃解析结果,不再重复读盘。
      parsed = candidate.raw;
    } else {
      let raw: string;
      try {
        raw = readFileSync(candidate.path, "utf8");
      } catch (error) {
        const errno = error as NodeJS.ErrnoException;
        if (errno.code === "ENOENT") {
          if (candidate.explicit) {
            return {
              config: null,
              sourcePath: candidate.path,
              error: `PI_SUBAGENTS_CONFIG points to a missing file: ${candidate.path}`,
            };
          }
          continue;
        }
        return {
          config: null,
          sourcePath: candidate.path,
          error: `Could not read ${candidate.path}: ${errno.message ?? String(error)}`,
        };
      }
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
          config: null,
          sourcePath: candidate.path,
          error: `Invalid JSON in ${candidate.path}: ${detail}`,
        };
      }
    }
    const parsedConfig = parseTierConfig(parsed, candidate.path);
    if ("error" in parsedConfig) {
      return { config: null, sourcePath: candidate.path, error: parsedConfig.error };
    }
    return { config: parsedConfig.config, sourcePath: candidate.path };
  }
  return { config: null, sourcePath: null };
}

/** tier → 具体模型;缺映射给清晰错误,绝不静默换模型。 */
export function resolveTierModel(
  tier: ModelTier,
  config: TierRouteConfig | null,
): { model: string } | { error: string } {
  const model = config?.models[tier];
  if (!model) {
    const hint = config
      ? ` Add models.${tier} to ${config.sourcePath}.`
      : " No pi-subagents config was found (looked at $PI_SUBAGENTS_CONFIG, " +
        "<cwd>/.pi/agent/pi-subagents.json, $PI_CODING_AGENT_DIR/pi-subagents.json, " +
        "and the package config).";
    return { error: `No model configured for tier "${tier}".${hint}` };
  }
  return { model };
}

export type TierLaunchResolution =
  | { tier: ModelTier | null; model?: string }
  | { error: string };

/**
 * launch 前的 tier 解析:显式 params.model 永远优先 tier(同时给出时不读
 * 配置,tier 仅作 loadout 记录);tier 无法归一化或缺映射时报错,不回退。
 */
export function resolveTierForParams(
  params: { tier?: string; model?: string },
  loadConfig: () => TierConfigLoadResult,
): TierLaunchResolution {
  const requested = params.tier?.trim();
  if (!requested) return { tier: null };
  const tier = normalizeTier(requested);
  if (!tier) {
    return {
      error:
        `Invalid tier "${params.tier}". Use one of: ${MODEL_TIERS.join(", ")} ` +
        "(aliases: quick, balance/standard, strong).",
    };
  }
  if (params.model) return { tier };
  const loaded = loadConfig();
  if (loaded.error) {
    return { error: `Tier "${tier}" could not be resolved: ${loaded.error}` };
  }
  const resolved = resolveTierModel(tier, loaded.config);
  if ("error" in resolved) return { error: resolved.error };
  return { tier, model: resolved.model };
}
