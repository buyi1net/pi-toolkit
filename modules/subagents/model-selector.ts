// 模型候选选择器（工单 24）：在不依赖实时供应商状态的前提下，按用户配置
// 顺序在档位候选池里选出实际模型。
//
// 选择管线（规格《模型编排》§5 的静态部分 + 工单 25 的运行状态边界 +
// 工单 26 的降级重试边界）：
//   档位候选池 → 排除本次 spawn 已失败候选（工单 26 降级重试）→ 能力
//   标签过滤 → 思考等级兼容性过滤 → 排除硬阻断（额度不足/模型下线）与
//   持续不稳定（工单 26 错误观测）→ 按用户配置顺序取首个存活候选
//
// 范围裁决（工单 24 vs 25-28）：运行时错误触发的降级重试（工单 26）、
// TUI 展示与用量面板（工单 27-28）不在本层。工单 25 起选择器接受可选的
// 运行状态表（ModelHealthMap，由 model-health.ts 推导）：只排除硬阻断
// 判定（quota-blocked / offline）；unstable / unknown / unconfigured 不
// 排除——状态未知绝不能让整个编排无条件停摆（ADR 0007 决策 4）。
//
// 诚实边界（与工单 23 的支持性核验同一条规则）：目录缺席、目录里查不到候选、
// 或裸 id 跨供应商歧义时，一律无法核验——不虚构“支持”，也不假设“不支持”，
// 候选原样保留交给子进程，实际生效值以子会话记录为准。只有目录里明确
// 查得到的模型，其能力/等级取值才参与过滤。运行状态同理：状态表里没有
// 的候选按未知处理，保留不排除。
//
// 依赖方向：本文件只依赖 routing.ts 的思考等级词汇表与 model-health.ts
// 的判定词汇表（单向；routing.ts 不反向依赖本文件，编排由 startup.ts 完成）。

import { createHash } from "node:crypto";

import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { modelOwnThinkingSuffix, type ThinkingLevel } from "./routing.ts";
import {
  baseModelRef,
  isHardBlockedVerdict,
  type ModelHealthMap,
} from "./model-health.ts";

/**
 * 模型目录条目形状：宿主 `ExtensionContext.modelRegistry`（pi-ai 的
 * `Model`）结构满足；测试注入 stub。`input`/`thinkingLevelMap` 在宿主
 * Model 上必有/可选，这里保持同一形状以便直接吃宿主目录。
 */
export interface CatalogModel {
  provider: string;
  id: string;
  /** 宿主执行 API；旧测试替身可省略。 */
  api?: string;
  /** 宿主执行地址；旧测试替身可省略。 */
  baseUrl?: string;
  /** 展示名称；缺省时使用模型 id。 */
  name?: string;
  /** reasoning 能力：是否支持思考等级（非 reasoning 只有 off）。 */
  reasoning: boolean;
  /** 思考等级映射；`null` 值表示该等级被显式排除。 */
  thinkingLevelMap?: Record<string, string | null>;
  /** 输入模态：含 "image" 即具备视觉能力。 */
  input?: readonly ("text" | "image")[];
}

/** 模型目录的最小子集（宿主 modelRegistry 满足；测试注入 stub）。 */
export type ModelCatalog = {
  getAll(): ReadonlyArray<CatalogModel>;
};

/**
 * 能力标签词汇表（工单 24）：只收录宿主目录可核验的能力。规格提到的
 * "代码、工具调用"宿主没有 per-model 数据，不虚构标签；上下文长度等
 * 数值维度留给后续工单。
 */
export const MODEL_CAPABILITIES = ["vision", "reasoning"] as const;

export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

/** 严格判定（校验入口用）：不做归一化。 */
export function isModelCapability(value: string): value is ModelCapability {
  return (MODEL_CAPABILITIES as readonly string[]).includes(value);
}

/** 宽容归一（trim + 小写）；无法识别返回 null，调用方负责报错。 */
export function normalizeModelCapability(input: string): ModelCapability | null {
  const value = input.trim().toLowerCase();
  return isModelCapability(value) ? value : null;
}

/**
 * 宿主 `@earendil-works/pi-ai` 是思考等级能力的唯一裁决方；非 reasoning 模型只有 off，
 * thinkingLevelMap[level] === null 显式排除，xhigh / max 仍由宿主映射决定。
 */
export function supportedThinkingLevels(
  model: { reasoning: boolean; thinkingLevelMap?: Record<string, string | null> },
): readonly string[] {
  return getSupportedThinkingLevels(model as Parameters<typeof getSupportedThinkingLevels>[0]);
}

export interface ModelReferenceResolution {
  readonly model: string;
  readonly entry: CatalogModel;
}

export interface ModelReferenceProblem {
  readonly model: string;
  readonly candidates: readonly string[];
  readonly reason: "ambiguous" | "wrong-provider" | "unknown-model";
  readonly message: string;
}

function catalogReference(entry: CatalogModel, thinking: string | null): string {
  return `${entry.provider}/${entry.id}${thinking ? `:${thinking}` : ""}`;
}

/**
 * 把模型调用方给出的引用对齐到宿主目录中的完整 provider/model 路由。
 *
 * 目录里能唯一确认时返回规范引用；裸 id 跨供应商歧义、已知 provider 下
 * 的错误模型名、或把模型品牌写成 provider 时返回可操作的问题。provider
 * 与 model id 都不在当前目录中的自定义路由保留原样，由子进程继续按宿主
 * 扩展解析；若自定义 provider 复用了目录中已有的 model id，则仍提示使用
 * 精确路由，避免把品牌名误当 provider。
 */
export function resolveKnownModelReference(
  modelRef: string,
  catalog: ModelCatalog,
): { resolution: ModelReferenceResolution } | { problem: ModelReferenceProblem } | null {
  const raw = modelRef.trim();
  const own = modelOwnThinkingSuffix(raw);
  const base = own ? raw.slice(0, raw.length - own.length - 1) : raw;
  const suffix = own ? own : null;
  const all = catalog.getAll();
  const exact = all.find((entry) => `${entry.provider}/${entry.id}` === base);
  if (exact) return { resolution: { model: catalogReference(exact, suffix), entry: exact } };

  const slash = base.indexOf("/");
  if (slash <= 0 || slash === base.length - 1) {
    const byId = all.filter((entry) => entry.id === base);
    if (byId.length === 1) {
      return { resolution: { model: catalogReference(byId[0], suffix), entry: byId[0] } };
    }
    if (byId.length > 1) {
      const candidates = byId.map((entry) => catalogReference(entry, suffix));
      return {
        problem: {
          model: raw,
          candidates,
          reason: "ambiguous",
          message:
            `Model reference "${raw}" is ambiguous across providers. Use one exact route: ` +
            `${candidates.join(", ")}. Do not infer a provider from the model brand name.`,
        },
      };
    }
    return null;
  }

  const provider = base.slice(0, slash);
  const id = base.slice(slash + 1);
  const sameId = all.filter((entry) => entry.id === id);
  if (sameId.length > 0) {
    const candidates = sameId.map((entry) => catalogReference(entry, suffix));
    return {
      problem: {
        model: raw,
        candidates,
        reason: "wrong-provider",
        message:
          `Model reference "${raw}" does not match the host model catalog. ` +
          `The model id "${id}" is available as: ${candidates.join(", ")}. ` +
          "Use the exact provider/model route; do not use a provider brand as a guess.",
      },
    };
  }

  const sameProvider = all.filter((entry) => entry.provider === provider);
  if (sameProvider.length > 0) {
    const candidates = sameProvider.map((entry) => catalogReference(entry, suffix));
    return {
      problem: {
        model: raw,
        candidates,
        reason: "unknown-model",
        message:
          `Model "${raw}" is not available in provider "${provider}". ` +
          `Available routes for that provider: ${candidates.join(", ")}.`,
      },
    };
  }

  // 目录没有这个 provider，可能是用户安装的自定义 provider；不要凭目录
  // 不完整就阻断它。
  return null;
}

/**
 * 按引用（"provider/id"、裸 id，可带 ":level" 思考等级后缀）在目录里查
 * 模型。找不到或裸 id 跨供应商歧义时返回 null（无法核验），调用方跳过
 * 过滤而不是虚构支持性。
 */
export function findCatalogModel(
  modelRef: string,
  catalog: ModelCatalog,
): CatalogModel | null {
  const own = modelOwnThinkingSuffix(modelRef);
  const base = own ? modelRef.slice(0, modelRef.length - own.length - 1) : modelRef;
  const all = catalog.getAll();
  const exact = all.find((entry) => `${entry.provider}/${entry.id}` === base);
  if (exact) return exact;
  const bare = all.filter((entry) => entry.id === base);
  return bare.length === 1 ? bare[0] : null;
}

/**
 * 按引用给出目录里该模型支持的思考等级；查不到/歧义返回 null（无法核验），
 * 调用方跳过校验而不是虚构支持性。
 */
export function resolveModelThinkingSupport(
  modelRef: string,
  catalog: ModelCatalog,
): readonly string[] | null {
  const model = findCatalogModel(modelRef, catalog);
  return model ? supportedThinkingLevels(model) : null;
}

/**
 * 按引用核验模型是否具备全部要求的能力，返回缺失清单（工单 02）：目录里
 * 查得到该模型而它缺少某能力标签时返回非空清单；空数组 = 查得到且全部
 * 满足。查不到/裸 id 跨供应商歧义返回 null（无法核验），调用方跳过校验
 * 而不是虚构支持性——与 resolveModelThinkingSupport 同一条诚实边界，
 * 供启动链对显式 model / 档案 model 做与思考等级同一位置的最终核验。
 */
export function modelMissingCapabilities(
  modelRef: string,
  required: readonly ModelCapability[],
  catalog: ModelCatalog,
): readonly ModelCapability[] | null {
  const entry = findCatalogModel(modelRef, catalog);
  if (!entry) return null;
  return required.filter((capability) => !entryHasCapability(entry, capability));
}

/** 单个候选被过滤掉的原因（结构化诊断信息的最小单位）。 */
export interface ModelCandidateRejection {
  /** 被过滤的候选引用（含 ":level" 后缀，原样）。 */
  readonly model: string;
  /** 过滤维度：能力标签 / 思考等级 / 运行状态（工单 25）。 */
  readonly kind: "capability" | "thinking" | "status";
  /** 人可读原因（错误文案直接拼这段）。 */
  readonly reason: string;
}

/**
 * 运行状态硬阻断类跳过原因的固定前缀（工单 08）：reason 文案里 verdict
 * 跟在其后（quota-blocked / offline）。展示层靠它从路由快照的 skipped
 * 里区分「额度/下线硬阻断」与其它跳过，不在各自入口复制字符串字面量。
 */
export const STATUS_SKIP_REASON_PREFIX = "runtime status ";
/** 持续不稳定跳过原因的固定前缀（工单 08，同上口径）。 */
export const UNSTABLE_SKIP_REASON_PREFIX = "persistent provider instability, skipped";
/** 降级重试排除原因的固定前缀（工单 08：细分继承原因时排除该类条目）。 */
export const FAILOVER_EXCLUSION_REASON_PREFIX = "excluded by failover policy";

/** 选择器输入：本次任务对候选的能力与思考等级要求。 */
export interface ModelSelectionRequirements {
  /** 要求候选具备的能力标签（通常来自 agent frontmatter 的 capabilities）。 */
  capabilities?: readonly ModelCapability[];
  /**
   * 思考等级要求：覆盖链上层已定值（任务显式 > 代理 frontmatter > 档位
   * 默认，由调用方按规格 §4 合并后传入）。null/undefined 表示无等级
   * 要求，此时仍按候选自带 ":level" 后缀核验（模型自身默认值）。
   */
  thinking?: ThinkingLevel | null;
}

/** 选择成功：实际选中的候选与被跳过候选的诊断记录。 */
export interface ModelCandidateSelection {
  /** 实际选中的候选引用（含 ":level" 后缀，原样）。 */
  readonly model: string;
  /** 选中候选在候选池中的位置（0 起；0 = 用户首选）。 */
  readonly rank: number;
  /** 在它之前被过滤掉的候选及原因（顺序同候选池）。 */
  readonly skipped: readonly ModelCandidateRejection[];
}

/** 选择失败：全池候选都被过滤，附结构化诊断。 */
export interface ModelSelectionFailure {
  /** 完整候选池（用户配置顺序）。 */
  readonly pool: readonly string[];
  /** 本次选择的要求（回放诊断用）。 */
  readonly requirements: ModelSelectionRequirements;
  /** 每个候选被过滤的原因（顺序同候选池）。 */
  readonly rejections: readonly ModelCandidateRejection[];
}

/** 目录条目是否具备要求的能力（只对目录里查得到的条目调用）。 */
function entryHasCapability(entry: CatalogModel, capability: ModelCapability): boolean {
  if (capability === "reasoning") return entry.reasoning === true;
  // vision：宿主 Model 的 input 必含模态数组；条目缺 input 视为不可证
  // 具备视觉（要求在场就必须可证，不能默认满足）。
  return entry.input?.includes("image") === true;
}

/**
 * 在有序候选池上执行静态选择（工单 24）+ 运行状态硬阻断过滤（工单 25）
 * + 降级重试排除（工单 26）：
 *
 * 0. 提供排除集（工单 26）时，本次 spawn 已失败过的候选（按基础引用，
 *    剥 ":level" 后缀匹配）被跳过——每个候选至多尝试一次，顺序不回绕；
 * 1. 默认按用户配置顺序取首个候选（首选在前）；
 * 2. 目录可核验时，缺任一要求能力标签的候选被跳过；
 * 3. 目录可核验时，不支持生效思考等级（要求值 ?? 候选自带后缀）的候选
 *    被跳过——这是工单 24 对工单 23 行为的演进：tier 路径从“直接拒绝”
 *    变为“换下一个候选”，显式 model 路径仍是直接拒绝（由 startup.ts 的
 *    支持性核验承担）；
 * 4. 工单 25：提供运行状态表时，判定为硬阻断（额度不足/模型下线）的候选
 *    被跳过；状态表里没有的候选按未知处理，保留（查询失败不停摆）；
 * 5. 工单 26：状态携带 signals.persistentlyUnstable（persistent 窗口内
 *    反复临时故障）的候选被跳过（规格 §5「持续过载不得继续选择」）；
 *    单次 unstable 仍不排除；
 * 6. 目录缺席/候选查不到：无法核验，候选保留（不虚构支持性）；
 * 7. 全池被过滤时返回结构化 failure，调用方拼可诊断错误。
 *
 * 纯函数：不读配置、不查余额、不发网络请求——运行状态表由调用方
 * （startup.ts 经 model-health.ts 网关）提前取好传入。
 */
export function selectModelCandidate(
  pool: readonly string[],
  requirements: ModelSelectionRequirements,
  catalog: ModelCatalog | null | undefined,
  health?: ModelHealthMap,
  exclude?: ReadonlySet<string>,
): { selection: ModelCandidateSelection } | { failure: ModelSelectionFailure } {
  const requiredCapabilities = requirements.capabilities?.filter(Boolean) ?? [];
  const skipped: ModelCandidateRejection[] = [];
  for (let rank = 0; rank < pool.length; rank += 1) {
    const candidate = pool[rank];

    // 工单 26：本次 spawn 的降级重试排除——已失败候选不再入选（按基础
    // 引用匹配，每个候选至多尝试一次，候选访问顺序不回绕）。
    if (exclude?.has(baseModelRef(candidate))) {
      skipped.push({
        model: candidate,
        kind: "status",
        reason: `${FAILOVER_EXCLUSION_REASON_PREFIX} for this spawn (an earlier attempt on this candidate failed)`,
      });
      continue;
    }

    const entry = catalog ? findCatalogModel(candidate, catalog) : null;

    if (entry && requiredCapabilities.length > 0) {
      const missing = requiredCapabilities.filter(
        (capability) => !entryHasCapability(entry, capability),
      );
      if (missing.length > 0) {
        skipped.push({
          model: candidate,
          kind: "capability",
          reason: `missing capabilities: ${missing.join(", ")}`,
        });
        continue;
      }
    }

    const appliedThinking = requirements.thinking ?? modelOwnThinkingSuffix(candidate);
    if (entry && appliedThinking != null) {
      const supported = supportedThinkingLevels(entry);
      if (!supported.includes(appliedThinking)) {
        skipped.push({
          model: candidate,
          kind: "thinking",
          reason:
            `does not support thinking level "${appliedThinking}" ` +
            `(supported: ${supported.join(", ")})`,
        });
        continue;
      }
    }

    // 工单 25：只排除硬阻断（额度不足/模型下线）。状态表按基础引用（剥
    // “:level” 后缀）查；查不到 = 状态未知 = 保留，绝不停摆。
    const status = health?.get(baseModelRef(candidate));
    if (status && isHardBlockedVerdict(status.verdict)) {
      skipped.push({
        model: candidate,
        kind: "status",
        reason: `${STATUS_SKIP_REASON_PREFIX}${status.verdict}${status.detail ? ` (${status.detail})` : ""}`,
      });
      continue;
    }

    // 工单 26：持续不稳定（错误观测的 persistent 窗口内反复临时故障）按
    // 规格 §5「持续过载不得继续选择」跳过；单次 unstable 不排除。
    if (status?.signals?.persistentlyUnstable === true) {
      skipped.push({
        model: candidate,
        kind: "status",
        reason: `${UNSTABLE_SKIP_REASON_PREFIX} (${status.detail ?? "repeated transient failures"})`,
      });
      continue;
    }

    return { selection: { model: candidate, rank, skipped } };
  }
  return {
    failure: {
      pool: [...pool],
      requirements: { ...requirements },
      rejections: skipped,
    },
  };
}

// ── 模型目录读口（工单 02）────────────────────────────────────────

export type ModelDirectorySource = "current" | "pool:fast" | "pool:balanced" | "pool:flagship" | "catalog";
export interface ModelIdentity { readonly provider: string; readonly id: string; readonly api: string; readonly baseUrl: string; }
export interface ModelHealthSummary {
  readonly status: string;
  readonly request_count: number;
  readonly error_count: number;
  readonly consecutive_error_count: number;
  readonly last_error_at: number | null;
  readonly last_error_type: string | null;
  readonly detail: string | null;
}
export interface ModelDirectoryEntry extends ModelIdentity {
  readonly name: string;
  readonly modelKey: string | null;
  readonly sources: readonly ModelDirectorySource[];
  readonly reasoning_effort: readonly string[];
  readonly resolvable: boolean;
  readonly resolution_reason: string | null;
  readonly health: ModelHealthSummary;
}
export interface ModelDirectory { readonly catalog_version: string; readonly generated_at: string; readonly models: readonly ModelDirectoryEntry[]; }
export interface ModelDirectoryInput {
  readonly currentModel?: CatalogModel | null;
  readonly pools?: Partial<Record<import("./routing.ts").ModelTier, readonly string[]>>;
  readonly modelRegistry: ModelCatalog;
  readonly health?: ModelHealthMap;
  readonly now?: () => number;
}
function directoryIdentity(model: Partial<ModelIdentity> & Pick<ModelIdentity, "provider" | "id">): ModelIdentity {
  return { provider: model.provider.trim(), id: model.id.trim(), api: (model.api ?? "").trim(), baseUrl: (model.baseUrl ?? "").trim() };
}
function directoryIdentityKey(identity: ModelIdentity): string { return JSON.stringify([identity.provider, identity.id, identity.api, identity.baseUrl]); }
function directoryDigest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function directoryPoolSource(tier: string): ModelDirectorySource { return `pool:${tier}` as ModelDirectorySource; }
function directoryHealth(identity: ModelIdentity, health?: ModelHealthMap): ModelHealthSummary {
  const observed = health?.get(`${identity.provider}/${identity.id}`);
  return {
    status: observed?.verdict ?? "unknown",
    request_count: observed?.request_count ?? 0,
    error_count: observed?.error_count ?? 0,
    consecutive_error_count: observed?.consecutive_error_count ?? 0,
    last_error_at: observed?.last_error_at ?? null,
    last_error_type: observed?.last_error_type ?? null,
    detail: observed?.detail ?? null,
  };
}
export function projectModelDirectoryHealth(directory: ModelDirectory, health?: ModelHealthMap): ModelDirectory {
  return {
    ...directory,
    models: directory.models.map((model) => ({
      ...model,
      health: directoryHealth({ provider: model.provider, id: model.id, api: model.api, baseUrl: model.baseUrl }, health),
    })),
  };
}

/** 生成完整模型目录：同一执行身份合并来源，池内不可解析项仅展示。 */
export function buildModelDirectory(input: ModelDirectoryInput): ModelDirectory {
  const registryModels = [...input.modelRegistry.getAll()];
  const byRoute = new Map<string, CatalogModel>();
  for (const model of registryModels) { const identity = directoryIdentity(model); byRoute.set(`${identity.provider}\0${identity.id}`, { ...model, ...identity }); }
  type Draft = { identity: ModelIdentity; name: string; sources: Set<ModelDirectorySource>; model: CatalogModel | null; resolvable: boolean; reason: string | null };
  const drafts = new Map<string, Draft>();
  const add = (identity: ModelIdentity, source: ModelDirectorySource, model: CatalogModel | null, reason: string | null) => {
    const key = directoryIdentityKey(identity); const existing = drafts.get(key);
    if (existing) { existing.sources.add(source); if (!existing.model && model) { existing.model = model; existing.resolvable = true; existing.reason = null; existing.name = model.name?.trim() || identity.id; } return; }
    drafts.set(key, { identity, name: model?.name?.trim() || identity.id, sources: new Set([source]), model, resolvable: !!model, reason });
  };
  if (input.currentModel) add(directoryIdentity(input.currentModel), "current", input.currentModel, null);
  for (const tier of ["fast", "balanced", "flagship"] as const) for (const raw of input.pools?.[tier] ?? []) {
    const reference = raw.trim(); const base = baseModelRef(reference); const slash = base.indexOf("/");
    const provider = slash > 0 ? base.slice(0, slash).trim() : ""; const id = (slash > 0 ? base.slice(slash + 1) : base).trim();
    const resolved = provider ? byRoute.get(`${provider}\0${id}`) : registryModels.filter((model) => model.id.trim() === id).length === 1 ? registryModels.find((model) => model.id.trim() === id) ?? null : null;
    if (resolved) add(directoryIdentity(resolved), directoryPoolSource(tier), resolved, null);
    else add({ provider, id, api: "", baseUrl: "" }, directoryPoolSource(tier), null, provider ? `model "${reference}" is not present in the Pi host model registry` : `model "${reference}" is not an exact provider/id route in the Pi host model registry`);
  }
  for (const model of registryModels) add(directoryIdentity(model), "catalog", model, null);
  const sorted = [...drafts.values()].sort((a, b) => directoryIdentityKey(a.identity).localeCompare(directoryIdentityKey(b.identity)));
  // 目录版本由完整执行身份和来源内容决定：同一父会话内 models/spawn
  // 重建时得到同一 modelKey；注册表、池或支持等级变化时版本自然失效。
  const catalogFingerprint = sorted.map((draft) => ({
    identity: draft.identity,
    resolvable: draft.resolvable,
    reason: draft.reason,
    sources: [...draft.sources].sort(),
    reasoning_effort: draft.model ? [...supportedThinkingLevels(draft.model)] : [],
  }));
  const catalog_version = `cat_${directoryDigest(JSON.stringify(catalogFingerprint)).slice(0, 32)}`;
  const models = sorted.map((draft): ModelDirectoryEntry => { const reasoning_effort = draft.model ? [...supportedThinkingLevels(draft.model)] : []; const modelKey = draft.resolvable ? `mk_${directoryDigest(`${catalog_version}\0${directoryIdentityKey(draft.identity)}`).slice(0, 32)}` : null; return { ...draft.identity, name: draft.name, modelKey, sources: [...draft.sources].sort() as ModelDirectorySource[], reasoning_effort, resolvable: draft.resolvable, resolution_reason: draft.reason, health: directoryHealth(draft.identity, input.health) }; });
  const now = input.now ?? Date.now; return { catalog_version, generated_at: new Date(now()).toISOString(), models };
}
/** 只接受当前目录发出的不透明键；原始路由、裸模型名和未知键都会失败。 */
export function resolveModelKey(directory: ModelDirectory, modelKey: string): ModelDirectoryEntry | null { if (typeof modelKey !== "string" || !/^mk_[a-f0-9]{32}$/.test(modelKey)) return null; return directory.models.find((entry) => entry.modelKey === modelKey) ?? null; }
export function isCurrentModelKey(directory: ModelDirectory, modelKey: string): boolean { return resolveModelKey(directory, modelKey) !== null; }
export const createModelDirectory = buildModelDirectory;
export const resolveCatalogModelKey = resolveModelKey;
export interface ExplicitModelSelection {
  readonly modelKey: string;
  readonly reasoning_effort: string;
  readonly model: ModelDirectoryEntry;
}

export interface ExplicitModelSelectionError {
  readonly code: "model_key_unknown" | "reasoning_effort_unsupported";
  readonly message: string;
  readonly selected_model_key: string;
  readonly reasoning_effort: string;
  readonly supported_reasoning_effort: readonly string[];
}

/**
 * 新协议的模型选择接缝：只解析当前目录发出的不透明键，并要求调用方
 * 明确提交宿主目录声明的思考等级。这里不接收健康表、候选池或排除集，
 * 因而不会隐藏模型、自动换模或触发重试；旧协议继续使用上面的选择器。
 */
export function resolveExplicitModelSelection(
  directory: ModelDirectory,
  modelKey: string,
  reasoning_effort: string,
): { selection: ExplicitModelSelection } | { error: ExplicitModelSelectionError } {
  const entry = resolveModelKey(directory, modelKey);
  if (!entry || !entry.resolvable || entry.modelKey === null) {
    return {
      error: {
        code: "model_key_unknown",
        message: `Model selection key "${modelKey}" is not present in the current model directory. Read subagent_models again and choose a current modelKey.`,
        selected_model_key: modelKey,
        reasoning_effort,
        supported_reasoning_effort: [],
      },
    };
  }
  const supported = entry.reasoning_effort;
  if (!supported.includes(reasoning_effort)) {
    return {
      error: {
        code: "reasoning_effort_unsupported",
        message:
          `Model selection "${modelKey}" does not support reasoning_effort "${reasoning_effort}" ` +
          `(supported: ${supported.join(", ")}).`,
        selected_model_key: modelKey,
        reasoning_effort,
        supported_reasoning_effort: [...supported],
      },
    };
  }
  return { selection: { modelKey, reasoning_effort, model: entry } };
}

export const validateExplicitModelSelection = resolveExplicitModelSelection;
