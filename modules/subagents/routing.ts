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
 * 候选引用的基础形态：剥掉合法的 ":thinking" 后缀（与目录查找同一口径）。
 * 健康查表、故障排除与池数据约束（工单 03 的基础引用判重）共用这一个
 * 口径；实现随 modelOwnThinkingSuffix 定义在 routing.ts，model-health.ts
 * 转发导出，不另设第二套。
 */
export function baseModelRef(ref: string): string {
  const own = modelOwnThinkingSuffix(ref);
  return own ? ref.slice(0, ref.length - own.length - 1) : ref;
}

/** 池内第一对同基础引用的重复候选；无重复为 null。 */
export interface DuplicateBaseRef {
  /** 冲突两条共用的基础引用 */
  readonly base: string;
  /** 先出现的候选（原样引用，可能带思考等级后缀） */
  readonly first: string;
  /** 后出现的候选（原样引用） */
  readonly second: string;
}

/**
 * 池内判重（工单 03）：剥掉思考等级后缀后基础引用相同即重复。健康查询与
 * 用量面板按基础引用去重，池里出现同基础引用的多条会让候选数、健康查询
 * 数与用量模型数对不上。解析校验（checkTierPool）与池编辑器共用这一个
 * 判重口径，不复制第二套规则。
 */
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

/**
 * 单层严格解析结果（工单 00 起只服务环境变量锁定文件与写前校验；生效链
 * 的跨层取舍看 EffectiveTierRouteConfig）。
 */
export interface TierRouteConfig {
  /**
   * tier → 有序候选池（工单 21）。首选在前,后续元素是备用候选;顺序就是
   * 用户配置的主备优先级。元素可带 ":thinking" 后缀,由启动参数构造层统一处理。
   */
  models: Partial<Record<ModelTier, string[]>>;
  /**
   * tier → 档位默认思考等级（工单 23）。覆盖链（规格 §4）：任务显式值 >
   * 代理 frontmatter > 档位默认 > 模型自带后缀。允许只配 thinking 不配
   * models。单层解析里 null 墓碑按未设置处理（单层既无跨层清除对象，
   * 兼容既有严格语义）；跨层的墓碑占档语义在 mergeTierLayers。
   */
  thinking: Partial<Record<ModelTier, ThinkingLevel>>;
  /** 配置来源文件路径,用于错误提示定位。 */
  sourcePath: string;
}

export type TierConfigParseResult = { config: TierRouteConfig } | { error: string };

/**
 * 单档的逐档合并生效值（工单 00 单一读口的档粒度）：候选池与思考等级
 * 各自独立取「最高优先级的合法声明层」；两者可以来自不同层。
 */
export interface EffectiveTierRoute {
  /** 该档生效候选池；undefined = 没有任何配置层给出该档的合法声明。 */
  readonly pool: string[] | undefined;
  /** 候选池生效来源（声明该池的最高优先级合法层）；未生效为 null。 */
  readonly poolSource: string | null;
  /** 该档生效思考等级；undefined = 未设置（null 墓碑显式清除，或从未声明）。 */
  readonly thinking: ThinkingLevel | undefined;
  /**
   * 思考等级的生效来源：显式值与 null 墓碑都记声明层（墓碑=在该层显式
   * 清除并占档）；任何层都未声明该档时为 null。thinking 为 undefined 而
   * thinkingSource 非 null 即「墓碑显式清除生效」。
   */
  readonly thinkingSource: string | null;
}

/**
 * 配置链逐档合并后的单一读口视图（工单 00）：spawn 与菜单共用这一份
 * 「每档生效值 + 生效层来源 + 配置问题清单」，不再各读各的。
 */
export interface EffectiveTierRouteConfig {
  /** 逐档生效值（fast/balanced/flagship 三键恒存在）。 */
  readonly tiers: Readonly<Record<ModelTier, EffectiveTierRoute>>;
  /** 逐层问题清单：某层某档声明非法、本层该档未生效落低层的记录。 */
  readonly problems: readonly string[];
}

/** 从生效视图提取档 → 候选池映射（菜单计数等 TierMapping 消费方用）。 */
export function effectiveTierMapping(effective: EffectiveTierRouteConfig): Partial<Record<ModelTier, string[]>> {
  const mapping: Partial<Record<ModelTier, string[]>> = {};
  for (const tier of MODEL_TIERS) {
    const pool = effective.tiers[tier].pool;
    if (pool) mapping[tier] = [...pool];
  }
  return mapping;
}

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

/**
 * 单档候选池校验：合法返回有序池，非法返回错误文案（严格与宽容入口共用）。
 * 同基础引用的重复候选（剥掉思考等级后缀后相同，含完全相同与后缀变体，
 * 工单 03）拒绝，报错指明冲突的两条。
 */
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
 * tier 别名重复、同基础引用的重复候选(含思考等级后缀变体,工单 03)都报
 * 错。models 缺失视为合法但无映射。
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

/**
 * 单层解析结果（合并内部用）：与 LenientTierView 同一套逐档宽容判定，但
 * thinking 保留 null 墓碑——跨层合并需要区分「该层显式清除」与「该层未声明」
 * （工单 00 裁决：高层墓碑占住该档，阻止低层同档取值继续下沉）。
 */
interface TierLayerEntries {
  readonly models: Partial<Record<ModelTier, string[]>>;
  /** null = 显式清除墓碑（占档）；键缺席 = 该层未声明该档。 */
  readonly thinking: Partial<Record<ModelTier, ThinkingLevel | null>>;
  readonly problems: readonly string[];
}

/** 宽容解析的结果：合法的档进映射，非法项进 problems（文案与严格入口逐字一致）。 */
export interface LenientTierView {
  readonly models: Partial<Record<ModelTier, string[]>>;
  readonly thinking: Partial<Record<ModelTier, ThinkingLevel>>;
  readonly problems: readonly string[];
}

/**
 * 逐档宽容解析（工单 47，工单 00 起兼作合并的层解析器）：某一档非法只丢该档
 * 并记一条 problem，不影响同节其它合法档——否则一档坏值会让整节显示为空，
 * 用户看到的是「全部未配置」，与实际配置和写入轨迹都对不上。
 *
 * spawn 的生效链（loadTierRouteConfig 逐档合并）同样按本入口的逐档判定
 * 取每层的合法声明；环境变量锁定文件额外走严格入口 parseTierConfig（配错
 * 就直接报错，不参与降级）。两边共用同一套单档校验与错误文案，判定标准
 * 不会分歧。
 */
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

// ── 逐档合并（工单 00）──────────────────────────────────────────────────

/**
 * 按优先级（高 → 低）把各层逐档声明合并成单一读口视图：
 * - 每档候选池独立取最高优先级的合法声明层；低层同档声明不再整份截胡。
 * - 每档思考等级同样独立取最高优先级的声明层；高层的 null 墓碑是显式清除，
 *   占住该档并阻止低层同档取值继续下沉（工单 00 裁决方案 A：最终未设置时
 *   由 spawn 侧的 thinking 覆盖链落到代理/任务/模型自带后缀等更低来源）。
 * - 某层某档声明非法（层解析进 problems）不占档，低层同档合法值照常生效。
 * - 跨层别名不判冲突：项目层写 quick、全局层写 fast 指同一档时高层胜出；
 *   同层内别名冲突仍由层解析记 problems。
 */
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
  /** 逐档合并后的生效配置（单一读口）；环境变量硬错误时为 null。 */
  config: EffectiveTierRouteConfig | null;
  /** 环境变量锁定层生效时的来源路径；逐档合并链为 null（逐档来源看 tiers）。 */
  sourcePath: string | null;
  /** 显式指定(PI_SUBAGENTS_CONFIG)的文件缺失/非法时的硬错误。 */
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
 * 配置读取链(工单 00 逐档合并):PI_SUBAGENTS_CONFIG → <cwd>/.pi/agent/
 * pi-subagents.json → PI_CODING_AGENT_DIR(缺省 ~/.pi/agent)/pi-subagents.json
 * → 宿主注入层(pi-toolkit.json 的 `modules.subagents` 节) → 包 config.json →
 * 包 config.json.example。不再是「第一个可读可解析的文件整份终局」，而是每
 * 一档的候选池与思考等级各自独立取最高优先级的合法声明层(mergeTierLayers)。
 *
 * 环境变量显式指定的文件保持硬错误语义:缺失、非法 JSON 或严格解析失败都
 * 直接报错，不参与与低层的合并——保住用环境变量锁定测试配置的用途。其余
 * 层缺失只跳过；某层声明非法时该档该层不生效、落低层，并记入问题清单
 * (对历史工单 47「严格生效侧整节拒绝」口径的有意反转)。纯读取,不写盘,
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

  // 环境变量锁定层:硬错误 + 整份生效(不与低层合并)。
  const explicit = env.PI_SUBAGENTS_CONFIG?.trim();
  if (explicit) {
    const locked = loadExplicitTierFile(explicit);
    if ("error" in locked) {
      return { config: null, sourcePath: explicit, error: locked.error };
    }
    return { config: mergeTierLayers([{ source: explicit, ...locked.entries }]), sourcePath: explicit };
  }

  // 逐档合并链：高 → 低收集各层合法声明，非法项记入问题清单。
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

/** 读取单个 JSON 文件：区分缺失/读错误/JSON 解析错误/成功四种结果。 */
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

/**
 * 环境变量锁定文件：缺失/读错误/非法 JSON/严格解析失败都是硬错误；合法时
 * 返回逐档声明(严格已过，problems 必为空，墓碑保留)。
 */
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

/**
 * 链上普通文件层：缺失跳过(null)；读错误仍是硬错误(文件在场却读不了，
 * 静默跳过会掩盖真实问题)；非法 JSON 记入问题清单后跳过该层(未生效、
 * 落低层)；合法则逐档宽容解析(非法声明不占档，记入该层 problems)。
 */
function loadTierFileLayer(path: string): ({ source: string } & TierLayerEntries) | null | string {
  const read = readTierFileRaw(path);
  if (read.kind === "missing") return null;
  if (read.kind === "read-error") return read.message;
  if (read.kind === "json-error") {
    return { source: path, models: {}, thinking: {}, problems: [read.message] };
  }
  return { source: path, ...parseTierLayerEntries(read.raw, path) };
}

/**
 * tier → 候选池(工单 24:把池子暴露给选择器,不再只给首选)。缺候选池给
 * 清晰错误,绝不静默换模型;错误文案与 resolveTierModel 保持逐字一致
 * (菜单侧 tierRouteError 依赖同一文案)。
 */
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

/**
 * tier → 实际模型:取候选池首个(用户配置的首选)。这是无目录、无要求时的
 * 退化选择(静态首选);带能力/思考等级要求的动态选择由工单 24 的
 * model-selector.ts 承担,编排发生在启动链(startup.ts)。
 */
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

/**
 * launch 前的 tier 候选池解析（工单 24 抽出，供启动链接选择器）：显式
 * model 永远优先 tier（同时给出时不读配置，tier 仅作 loadout 记录，pool
 * 为 undefined）；且 model 的接管先于 tier 校验（工单 02，与参数说明
 * 「model overrides tier」一致）——model 在场时拼错的 tier 不再报
 * Invalid tier，只是归一化不成功就记不成规范档位（tier 为 null）。显式
 * tier 优先 agentTier；无 model 时 tier 无法归一化或配置读失败才报错；
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
  // 工单 02：先判显式 model 再校验 tier——model 在场时 tier 只作记录，
  // 拼错的 tier 不报 Invalid tier（不阻断）；归一化不成功记不成规范档位，
  // 按未声明处理（tier: null）。
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

/**
 * launch 前的 tier 解析：显式 model 永远优先 tier（同时给出时不读配置，tier
 * 仅作 loadout 记录；且接管先于 tier 校验，model 在场时拼错的 tier 不报错，
 * 工单 02）；显式 tier 优先 agentTier。无 model 时 tier 无法归一化才报错；
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
