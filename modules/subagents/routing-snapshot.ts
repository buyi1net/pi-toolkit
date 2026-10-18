// 路由快照（工单 06）：spawn 计划 → loadout/运行态的完整路由结果单一数据源。
//
// 背景：路由事实此前拆在多个口径里——计划对象、loadout 的零散字段、运行态
// 的 tier/modelPool、结果 details 的 ModelRoutingDetails 各读各的，fallback
// 的父会话思考等级只存在于计划对象，进不了真实 argv。本模块把「本次路由
// 发生了什么」收口成一份快照：spawn 时随 loadout 落盘、随运行态登记，
// resume/recover 从 loadout 重放，展示面只消费不各自拼。
//
// 纯数据 + 纯函数：不读配置、不写盘。构造输入是 spawn 计划的结构子集
// （SpawnPlan 结构满足，测试可注入字面量），思考等级覆盖链与
// appliedLoadoutThinking / applySandboxToParts 共用同一实现，不另造一套。

import { modelOwnThinkingSuffix, type ModelTier } from "./routing.ts";
import {
  FAILOVER_EXCLUSION_REASON_PREFIX,
  STATUS_SKIP_REASON_PREFIX,
  UNSTABLE_SKIP_REASON_PREFIX,
  type ModelCandidateRejection,
} from "./model-selector.ts";

/** 继承原因（与 SpawnPlan.fallbackReason 同词汇表）。 */
export type RoutingFallbackReason = "pool-unconfigured" | "pool-status-unavailable";

/** 生效思考等级的来源（覆盖链同序：父会话继承 > 任务显式 > 代理 > 档位 > 模型自带后缀）。 */
export type RoutingThinkingSource = "parent" | "explicit" | "agent" | "tier" | "model-suffix";

/** loadout 里的路由快照：本次 spawn 完整路由结果的记录。 */
export interface LoadoutRoutingSnapshot {
  /** 请求的档位（归一化）；非 tier 路径为 null。 */
  readonly tier: ModelTier | null;
  /** tier 候选池（用户配置顺序，含 ":level" 后缀原样）；无池为 null。 */
  readonly pool: readonly string[] | null;
  /** 用户首选（候选池首个）；无池为 null。 */
  readonly preferred: string | null;
  /** 实际生效的模型（与 loadout.model 同值）。 */
  readonly model: string | null;
  /** 选择期被跳过的候选及原因（继承路径也保留全池阻断的逐候选原因）。 */
  readonly skipped: readonly ModelCandidateRejection[];
  /** 继承原因；非继承路径为 null。 */
  readonly fallbackReason: RoutingFallbackReason | null;
  /** 候选池生效层来源（配置链逐档合并后该档池的声明层路径）。 */
  readonly poolSource: string | null;
  /** 生效思考等级（拼进子进程参数的那一个；无等级为 null）。 */
  readonly effectiveThinking: string | null;
  /** 生效思考等级的来源。 */
  readonly effectiveThinkingSource: RoutingThinkingSource | null;
}

/** 快照构造输入：SpawnPlan 的结构子集（fresh 计划满足，测试可注入字面量）。 */
export interface RoutingSnapshotInput {
  readonly tier: ModelTier | null;
  readonly tierPool: readonly string[] | null;
  /**
   * 选择期被跳过的候选及原因：按池选中时来自 selection.skipped，全池
   * 状态/额度阻断触发继承时来自 failure.rejections（两条路径在计划里
   * 已收口到同一字段）；非 tier 路径为 null。
   */
  readonly tierSelectionSkips: readonly ModelCandidateRejection[] | null;
  readonly fallbackReason: RoutingFallbackReason | null;
  /** 候选池生效层来源。 */
  readonly poolSource: string | null;
  readonly effectiveModel: string | null;
  /** 计划期生效思考等级（fallback 时即父会话等级，否则为覆盖链上层值）。 */
  readonly effectiveThinking: string | null | undefined;
  readonly params: { thinking?: string };
  readonly agentDefs: { thinking?: string } | null;
  readonly tierThinking: string | null | undefined;
}

/**
 * loadout 思考等级覆盖链（工单 06 起含父会话继承）：fallback 继承的
 * parentThinking 最优先（ADR 0006 决策 7：继承路径把父会话等级作为显式
 * 参数传给子进程），其后是显式 thinkingOverride > 代理 frontmatter
 * thinking > 档位默认 tierThinking > 模型自带 ":level" 后缀；全部缺席为
 * null。appliedLoadoutThinking（session.ts）与 applySandboxToParts
 * （mod.ts 拼 argv）都走这一实现，三处不漂移。
 */
export function resolveAppliedThinking(input: {
  parentThinking?: string | null;
  thinkingOverride?: string | null;
  thinking?: string | null;
  tierThinking?: string | null;
  model?: string | null;
}): { level: string | null; source: RoutingThinkingSource | null } {
  if (input.parentThinking != null) return { level: input.parentThinking, source: "parent" };
  if (input.thinkingOverride != null) return { level: input.thinkingOverride, source: "explicit" };
  if (input.thinking != null) return { level: input.thinking, source: "agent" };
  if (input.tierThinking != null) return { level: input.tierThinking, source: "tier" };
  const own = modelOwnThinkingSuffix(input.model);
  return own != null ? { level: own, source: "model-suffix" } : { level: null, source: null };
}

/** 由 spawn 计划构造路由快照（纯函数：输入计划，输出快照）。 */
export function buildRoutingSnapshot(input: RoutingSnapshotInput): LoadoutRoutingSnapshot {
  // fallback 继承的父会话思考等级：计划在继承路径上把它放进
  // effectiveThinking（ADR 0006 决策 7），这里还原成覆盖链顶层的
  // parentThinking——loadout 写盘与快照来源判定共用这一个口径。
  const parentThinking = input.fallbackReason ? input.effectiveThinking ?? null : null;
  const applied = resolveAppliedThinking({
    parentThinking,
    thinkingOverride: input.params.thinking ?? null,
    thinking: input.agentDefs?.thinking ?? null,
    tierThinking: input.tierThinking ?? null,
    model: input.effectiveModel,
  });
  return {
    tier: input.tier,
    pool: input.tierPool,
    preferred: input.tierPool?.[0] ?? null,
    model: input.effectiveModel,
    skipped: [...(input.tierSelectionSkips ?? [])],
    fallbackReason: input.fallbackReason,
    poolSource: input.poolSource,
    effectiveThinking: applied.level,
    effectiveThinkingSource: applied.source,
  };
}

// ── 工单 08：展示面的统一读口 ──────────────────────────────────
//
// 子代理列表、检查工具、状态行与用量桥接从这一组纯函数读模型来源与继承
// 原因，不在各自入口重新拼路由：输入只有快照，旧快照缺字段按现状降级
// （返回 null，展示面维持既有「未知/无标签」口径）。

/** 实际模型来源的展示词汇（快照可判定的三档；旧快照/缺席为 null）。 */
export type RoutingModelOrigin = "pool" | "parent" | "declared";

/** RoutingModelOrigin 的全量词汇表（守卫校验与展示层共用）。 */
export const ROUTING_MODEL_ORIGINS: readonly RoutingModelOrigin[] = ["pool", "parent", "declared"];

/**
 * fallback 继承原因的展示细分：额度/下线硬阻断与持续不稳定可区分
 * （工单 06 快照已存逐候选原因，这里只做分类不重新拼路由）。
 */
export type RoutingInheritanceCause =
  | "pool-unconfigured"
  | "hard-blocked"
  | "persistently-unstable"
  | "mixed-blocks"
  | "unclassified";

/** RoutingInheritanceCause 的全量词汇表（守卫校验与展示层共用）。 */
export const ROUTING_INHERITANCE_CAUSES: readonly RoutingInheritanceCause[] = [
  "pool-unconfigured",
  "hard-blocked",
  "persistently-unstable",
  "mixed-blocks",
  "unclassified",
];

/**
 * 从快照读实际模型来源：继承路径（fallbackReason 在场）→ parent；
 * tier 候选池在场且未继承 → pool（首选或降级候选都算按池选中）；其余
 * （显式/档案声明 model，tier 缺席或仅作记录）→ declared。快照缺席为
 * null（旧 loadout/旧记录按现状降级）。
 */
export function routingModelOrigin(
  snapshot: LoadoutRoutingSnapshot | null | undefined,
): RoutingModelOrigin | null {
  if (!snapshot) return null;
  if (snapshot.fallbackReason != null) return "parent";
  if (snapshot.pool != null && snapshot.pool.length > 0) return "pool";
  return "declared";
}

/**
 * 细分继承原因（仅继承路径有值，其余为 null）：pool-unconfigured 直接
 * 取 fallbackReason；pool-status-unavailable 按快照 skipped 里状态类跳过
 * 的固定前缀分类（硬阻断 = 额度耗尽/下线，不稳定 = persistent 窗口），
 * 降级重试排除条目不参与分类；跳过清单缺失或无法归类时诚实给出
 * unclassified，不虚构原因。
 */
export function routingInheritanceCause(
  snapshot: LoadoutRoutingSnapshot | null | undefined,
): RoutingInheritanceCause | null {
  if (!snapshot || snapshot.fallbackReason == null) return null;
  if (snapshot.fallbackReason === "pool-unconfigured") return "pool-unconfigured";
  const relevant = snapshot.skipped.filter(
    (skip) =>
      skip.kind === "status" &&
      !skip.reason.startsWith(FAILOVER_EXCLUSION_REASON_PREFIX),
  );
  if (relevant.length === 0) return "unclassified";
  const unstable = relevant.filter((skip) => skip.reason.startsWith(UNSTABLE_SKIP_REASON_PREFIX)).length;
  const hard = relevant.filter((skip) => skip.reason.startsWith(STATUS_SKIP_REASON_PREFIX)).length;
  if (unstable > 0 && hard > 0) return "mixed-blocks";
  if (unstable > 0) return "persistently-unstable";
  if (hard === relevant.length) return "hard-blocked";
  return "unclassified";
}

/**
 * 继承原因的工具侧文案（模型面工具输出冻结英文，与列表/检查的既有口径
 * 一致；面板的本地化文案在 usage/messages 键表，不走这里）。
 */
export function describeInheritanceCause(cause: RoutingInheritanceCause | null | undefined): string {
  switch (cause) {
    case "pool-unconfigured":
      return "tier pool unconfigured";
    case "hard-blocked":
      return "all candidates hard-blocked (quota exhausted / offline)";
    case "persistently-unstable":
      return "all candidates persistently unstable";
    case "mixed-blocks":
      return "candidates blocked by mixed status blocks";
    default:
      return "reason unknown";
  }
}

/**
 * 继承运行的工具侧标签短语（含方括号）：列表与检查的正文共用同一拼法，
 * 不在各自入口重复模板；非继承路径没有标签。
 */
export function inheritanceBadgeText(cause: RoutingInheritanceCause | null | undefined): string {
  return ` [inherits parent session: ${describeInheritanceCause(cause)}]`;
}
