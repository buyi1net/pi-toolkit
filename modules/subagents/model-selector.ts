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

import { THINKING_LEVELS, modelOwnThinkingSuffix, type ThinkingLevel } from "./routing.ts";
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
 * 宿主对单个模型支持的思考等级（复刻 pi-coding-agent 的
 * getSupportedThinkingLevels，宿主是最终裁决方，规则变化时以宿主为准同步）：
 * 非 reasoning 模型只有 off；thinkingLevelMap[level] === null 显式排除；
 * xhigh / max 需要显式映射才算支持。
 */
export function supportedThinkingLevels(
  model: { reasoning: boolean; thinkingLevelMap?: Record<string, string | null> },
): readonly string[] {
  if (!model.reasoning) return ["off"];
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
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

/** 单个候选被过滤掉的原因（结构化诊断信息的最小单位）。 */
export interface ModelCandidateRejection {
  /** 被过滤的候选引用（含 ":level" 后缀，原样）。 */
  readonly model: string;
  /** 过滤维度：能力标签 / 思考等级 / 运行状态（工单 25）。 */
  readonly kind: "capability" | "thinking" | "status";
  /** 人可读原因（错误文案直接拼这段）。 */
  readonly reason: string;
}

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
        reason: "excluded by failover policy for this spawn (an earlier attempt on this candidate failed)",
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
        reason: `runtime status ${status.verdict}${status.detail ? ` (${status.detail})` : ""}`,
      });
      continue;
    }

    // 工单 26：持续不稳定（错误观测的 persistent 窗口内反复临时故障）按
    // 规格 §5「持续过载不得继续选择」跳过；单次 unstable 不排除。
    if (status?.signals?.persistentlyUnstable === true) {
      skipped.push({
        model: candidate,
        kind: "status",
        reason: `persistent provider instability, skipped (${status.detail ?? "repeated transient failures"})`,
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
