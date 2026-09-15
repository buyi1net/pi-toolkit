import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

// routing.ts → 模块目录(一层向上),与 status.ts 的 PACKAGE_ROOT 同规则。
const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url));

/** 规范档位;配置与 params 都归一化到这三个值。 */
export type ModelTier = "fast" | "balanced" | "flagship";

export const MODEL_TIERS: readonly ModelTier[] = ["fast", "balanced", "flagship"];

/**
 * 规范思考等级（工单 23）：与 Pi 宿主的 ThinkingLevel 全集逐字一致
 * （cli/args.js 的 VALID_THINKING_LEVELS）。宿主是最终执行方，这里只是
 * 配置层的同一词汇表；宿主集合变化时必须同步这里。
 */
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

/** 严格判定：不做归一化（大小写/空白不宽容），校验入口用它。 */
export function isThinkingLevel(value: string): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

/** 宽容归一化（trim + 小写）；无法识别返回 null，调用方负责报错。 */
export function normalizeThinkingLevel(input: string): ThinkingLevel | null {
  const value = input.trim().toLowerCase();
  return isThinkingLevel(value) ? value : null;
}

/**
 * 模型引用自带的 ":level" 思考等级后缀（"模型自身默认值"，覆盖链最低层）。
 * 仅当后缀是规范思考等级才算（ollama 的 "llama3:8b" 这类冒号 id 不算），
 * 与启动参数构造层、宿主 parseModelPattern 的识别口径一致。
 */
export function modelOwnThinkingSuffix(
  model: string | null | undefined,
): ThinkingLevel | null {
  if (!model) return null;
  const match = /^(.+):([a-z]+)$/.exec(model);
  return match && isThinkingLevel(match[2]) ? match[2] : null;
}

/**
 * tier 别名表:params 与配置键共用,归一化到 canonical。刻意保持最小集合,
 * 不再扩大别名——同一含义多个写法只增加配置歧义。
 */
const TIER_ALIASES: Record<ModelTier, string[]> = {
  fast: ["fast", "quick"],
  balanced: ["balanced", "balance", "standard"],
  flagship: ["flagship", "deep", "strong"],
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
  /**
   * tier → 有序候选池（工单 21）。首选在前,后续元素是备用候选;顺序就是
   * 用户配置的主备优先级。元素可带 ":thinking" 后缀,由启动参数构造层统一处理。
   */
  models: Partial<Record<ModelTier, string[]>>;
  /**
   * tier → 档位默认思考等级（工单 23）。覆盖链（规格 §4）：任务显式值 >
   * 代理 frontmatter > 档位默认 > 模型自带后缀。可与 models 分属不同配置层，
   * 也允许只配 thinking 不配 models（models 缺档仍按缺映射报错）。
   * 配置文件里的 null 值是「显式未设置」墓碑，解析时按未设置处理。
   */
  thinking: Partial<Record<ModelTier, ThinkingLevel>>;
  /** 配置来源文件路径,用于错误提示定位。 */
  sourcePath: string;
}

export type TierConfigParseResult = { config: TierRouteConfig } | { error: string };

/** 未知 tier 键检查（models / thinking 共用）：合法返回归一化档位，非法返回错误文案。 */
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

/** 同档别名重复检查（models / thinking 共用）：合法时登记键名，非法返回错误文案。 */
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

/** 单档候选池校验：合法返回有序池，非法返回错误文案（严格与宽容入口共用）。 */
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
  return { pool };
}

/** 单档思考等级校验：合法返回等级（null 墓碑返回 undefined），非法返回错误文案。 */
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

/**
 * 严格校验 tier 配置。根对象允许携带其它键(包级 config.json 与 status 配置
 * 共用同一文件,这里只认 models 与 thinking);models 内部从严:未知 tier 键、
 * 档位取值不是有序候选池数组、空候选池、候选元素非字符串/空串/含空白、同
 * tier 别名重复都报错。models 缺失视为合法但无映射。
 *
 * thinking（工单 23）同级从严:非对象、未知 tier 键、别名重复、取值不是规范
 * 思考等级（null 除外——null 是显式 unset 墓碑,按未设置处理）都报错。
 * thinking 允许独立存在（不要求该层同时声明 models）。
 *
 * 工单 21 裁决:档位取值直接采用候选池数组,不兼容旧的单模型字符串格式——
 * 字符串取值在这里被拒绝,没有旧格式读取或迁移分支。
 */
export function parseTierConfig(raw: unknown, source: string): TierConfigParseResult {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: `${source}: root must be a JSON object` };
  }
  const root = raw as Record<string, unknown>;
  const thinking = parseTierThinking(root.thinking, source);
  if ("error" in thinking) return { error: thinking.error };
  const rawModels = root.models;
  if (rawModels === undefined) {
    // models 缺失合法（thinking 可以独立存在）；无映射档在使用时才报错。
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

/** 宽容解析的结果：合法的档进映射，非法项进 problems（文案与严格入口逐字一致）。 */
export interface LenientTierView {
  readonly models: Partial<Record<ModelTier, string[]>>;
  readonly thinking: Partial<Record<ModelTier, ThinkingLevel>>;
  readonly problems: readonly string[];
}

/**
 * 逐档宽容解析（工单 47）：菜单读侧用。某一档非法只丢该档并记一条 problem，
 * 不影响同节其它合法档——否则一档坏值会让整节显示为空，用户看到的是「全部
 * 未配置」，与实际配置和写入轨迹都对不上。
 *
 * spawn 路径仍走严格入口 parseTierConfig（配错就直接报错，不静默降级）；
 * 两边共用同一套单档校验与错误文案，判定标准不会分歧。
 */
export function parseTierConfigLenient(raw: unknown, source: string): LenientTierView {
  const models: Partial<Record<ModelTier, string[]>> = {};
  const thinking: Partial<Record<ModelTier, ThinkingLevel>> = {};
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
        if (checked.level !== undefined) thinking[resolved.tier] = checked.level;
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

/**
 * tier → 候选池(工单 24:把池子暴露给选择器,不再只给首选)。缺候选池给
 * 清晰错误,绝不静默换模型;错误文案与 resolveTierModel 保持逐字一致
 * (菜单侧 tierRouteError 依赖同一文案)。
 */
export function tierModelPool(
  tier: ModelTier,
  config: TierRouteConfig | null,
): { pool: string[] } | { error: string } {
  const pool = config?.models[tier];
  if (!pool || pool.length === 0) {
    const hint = config
      ? ` Add models.${tier} to ${config.sourcePath}.`
      : " No pi-subagents config was found (looked at $PI_SUBAGENTS_CONFIG, " +
        "<cwd>/.pi/agent/pi-subagents.json, $PI_CODING_AGENT_DIR/pi-subagents.json, " +
        "and the package config).";
    return { error: `No model configured for tier "${tier}".${hint}` };
  }
  return { pool };
}

/**
 * tier → 实际模型:取候选池首个(用户配置的首选)。这是无目录、无要求时的
 * 退化选择(静态首选);带能力/思考等级要求的动态选择由工单 24 的
 * model-selector.ts 承担,编排发生在启动链(startup.ts)。
 */
export function resolveTierModel(
  tier: ModelTier,
  config: TierRouteConfig | null,
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

/**
 * launch 前的 tier 候选池解析（工单 24 抽出，供启动链接选择器）：显式
 * model 永远优先 tier（同时给出时不读配置，tier 仅作 loadout 记录，pool
 * 为 undefined）；显式 tier 优先 agentTier。tier 无法归一化或配置读失败时报错；
 * 缺映射交由启动层按父会话是否可用决定是否继承。
 *
 * tier 经配置解析出候选池时，同时带出该档的默认思考等级 thinking；显式
 * model 胜出时 tier 只是记录，不把档位思考等级带到另一个模型上。
 */
export function resolveTierPoolForParams(
  params: { tier?: string; model?: string; agentTier?: string },
  loadConfig: () => TierConfigLoadResult,
): TierPoolResolution {
  // 四级路由的前三级在此收口：显式 model 由调用方传入，显式 tier
  // 优先于档案 tier；无声明时返回 null，第四级由后续工单接入。
  const requested = params.tier?.trim() || params.agentTier?.trim();
  if (!requested) return { tier: null };
  const tier = normalizeTier(requested);
  if (!tier) {
    return {
      error:
        `Invalid tier "${params.tier}". Use one of: ${MODEL_TIERS.join(", ")} ` +
        "(aliases: quick, balance/standard, deep/strong).",
    };
  }
  if (params.model) return { tier };
  const loaded = loadConfig();
  if (loaded.error) {
    return { error: `Tier "${tier}" could not be resolved: ${loaded.error}` };
  }
  const pool = tierModelPool(tier, loaded.config);
  if ("error" in pool) return { tier, fallbackReason: "pool-unconfigured" };
  const tierThinking = loaded.config?.thinking?.[tier] ?? undefined;
  return { tier, pool: pool.pool, ...(tierThinking ? { thinking: tierThinking } : {}) };
}

/**
 * launch 前的 tier 解析：显式 model 永远优先 tier（同时给出时不读配置，tier
 * 仅作 loadout 记录）；显式 tier 优先 agentTier。tier 无法归一化时报错；
 * 缺映射交由启动层按父会话是否可用决定是否继承。
 *
 * 工单 23:tier 经配置解析出模型时,同时带出该档的默认思考等级 thinking;
 * 显式 model 胜出时 tier 只是记录,不把档位思考等级带到另一个模型上
 * (thinking 为 undefined,由 params/agent 默认与模型自带后缀决定)。
 *
 * 工单 24:本函数退化为「无要求的静态首选」（取候选池首个），供菜单侧
 * 错误文案对齐（config.ts tierRouteError）等不需要选择器的调用方；带
 * 能力标签与思考等级要求的候选选择走 resolveTierPoolForParams +
 * model-selector.ts 的 selectModelCandidate（启动链，startup.ts）。
 */
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
