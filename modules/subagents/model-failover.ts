// 工单 26：模型降级、重试与可观测性 —— 策略词汇表、重试判定与降级记录组装。
//
// 边界（ADR 0006 决策 7 / 规格《模型编排》§6）：
//   - 可切换候选：临时限流（rate_limited，含过载文案）与临时服务错误
//     （provider_error：5xx / 网络超时 / 连接中断 / 临时不可用）；
//   - 不盲目重试：参数、凭据/权限、额度、模型不存在、上下文超限与未知
//     错误 —— 与 route-error.ts 的 retryable 语义对齐（switchable ⇒
//     retryable，测试做防漂移互检），不另造错误分类器；quota_exhausted
//     虽是候选级事实，但按工单 25 既定语义（选择期硬阻断、运行期交还
//     编排者决策）不做自动切换；
//   - 上限：候选严格按用户配置顺序访问、每个候选至多尝试一次（排除集
//     单调增长，不回绕）——无 timeoutMs 时重试次数 = 候选池长度；有
//     timeoutMs 时全部尝试共享同一截止时间，预算不足不再启动新尝试；
//   - 零进度保护：只有 stats.toolCount === 0 的失败才重启——已执行过
//     工具调用的任务重启会重复副作用（bash 已跑过），降级决定交还编排者；
//   - 取消类终态（stopped / userClosed / handedOff）不是路由失败，不切换。
//
// 纯策略模块：不发进程、不读盘、不写状态。重试编排循环在 subagent-tool.ts
// （硬屏障路径）；错误观测写入 model-health.ts 的 ModelErrorJournal（供
// 后续选择与工单 27/28 展示复用同一状态）。

import { baseModelRef, type ModelErrorObservationKind } from "./model-health.ts";
import type { ModelCandidateRejection } from "./model-selector.ts";
import type { RouteException, RouteExceptionKind } from "./route-error.ts";
import type { ModelTier } from "./routing.ts";

/** 允许触发候选切换的错误类别（route-error 词汇表中 retryable 的两类）。 */
export const FAILOVER_SWITCHABLE_KINDS: readonly ModelErrorObservationKind[] = [
  "rate_limited",
  "provider_error",
];

/** switchable 类别（= ModelErrorObservationKind，供错误观测日志写入收窄）。 */
export type FailoverSwitchableKind = ModelErrorObservationKind;

export function isFailoverSwitchable(kind: RouteExceptionKind): kind is FailoverSwitchableKind {
  return (FAILOVER_SWITCHABLE_KINDS as readonly string[]).includes(kind);
}

/**
 * 启动新尝试所需的最小剩余等待预算（毫秒）：与 validateTimeoutMs 的下限
 * 一致。预算不足时不启动新尝试，直接把已有失败按终态返回。
 */
export const MIN_FAILOVER_BUDGET_MS = 1000;

/** 降级链里的单次尝试记录（结果可观测性的最小单位）。 */
export interface ModelFailoverAttempt {
  /** 尝试序号（1 起）。 */
  readonly index: number;
  /** 本次尝试实际启动的候选（原样引用，含 ":level" 后缀）。 */
  readonly model: string;
  /** 本次失败的错误分类（route-error kind）。 */
  readonly kind: RouteExceptionKind;
  /** 本次失败的错误文本。 */
  readonly message: string;
  /** 本次尝试耗时（秒，取自子代理结果 elapsed）。 */
  readonly elapsedSeconds: number;
}

/** 工具结果 details 里的模型路由记录（规格 §6：实际选择与降级原因可追踪）。 */
export interface ModelRoutingDetails {
  readonly tier: ModelTier;
  /** 用户首选（候选池首个）。 */
  readonly preferred: string;
  /** 实际启动的模型（最终尝试）。 */
  readonly actual: string;
  /** 实际 ≠ 首选（按基础引用比较）。 */
  readonly downgraded: boolean;
  /** 人可读降级原因链；无降级为 null。 */
  readonly reason: string | null;
  /** 运行期降级尝试链（选择期未启动、直接成功的路径为空数组）。 */
  readonly attempts: readonly ModelFailoverAttempt[];
  /** 首次计划阶段被跳过的候选及原因（选择期降级，如额度不足）。 */
  readonly selectionSkips: readonly ModelCandidateRejection[];
}

/** 截断错误文本，降级链只留可读摘要。 */
function truncate(text: string, limit = 160): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}

/** 组装模型路由记录（首选/实际/降级原因）。纯函数。 */
export function buildModelRouting(input: {
  tier: ModelTier;
  pool: readonly string[];
  actual: string | null;
  attempts: readonly ModelFailoverAttempt[];
  selectionSkips: readonly ModelCandidateRejection[];
}): ModelRoutingDetails {
  const preferred = input.pool[0] ?? input.actual ?? "";
  const actual = input.actual ?? preferred;
  const downgraded = baseModelRef(actual) !== baseModelRef(preferred);
  let reason: string | null = null;
  if (input.attempts.length > 0) {
    const chain = input.attempts
      .map((attempt) => `#${attempt.index} ${attempt.model} failed (${attempt.kind}): ${truncate(attempt.message)}`)
      .join("; ");
    reason = `${chain} — switched to ${actual}`;
  } else {
    const preferredSkips = input.selectionSkips.filter(
      (skip) => baseModelRef(skip.model) === baseModelRef(preferred),
    );
    if (preferredSkips.length > 0) {
      reason = `preferred ${preferred} was skipped at selection: ${preferredSkips
        .map((skip) => skip.reason)
        .join("; ")}`;
    }
  }
  return {
    tier: input.tier,
    preferred,
    actual,
    downgraded,
    reason,
    attempts: [...input.attempts],
    selectionSkips: [...input.selectionSkips],
  };
}

/**
 * 降级说明文案（附在工具结果正文末尾，规格 §6：不能让用户误以为调用了
 * 首选模型）；未降级返回 null（不附加噪音）。
 */
export function describeModelRouting(routing: ModelRoutingDetails): string | null {
  if (!routing.downgraded || !routing.reason) return null;
  return (
    `[model routing] tier "${routing.tier}": preferred ${routing.preferred}, ` +
    `actual ${routing.actual} — downgraded (${routing.reason})`
  );
}

/** 重试判定结果：是否切换 + 不切换的结构化原因（诊断用）。 */
export interface FailoverDecision {
  readonly failover: boolean;
  readonly reason: string;
}

/**
 * 一次终态失败后是否切换下一个候选重试（纯函数，判定顺序即原因优先级）：
 * 1. 取消类终态（stopped / userClosed / handedOff）不是路由失败；
 * 2. 无分类（成功 / errorMessage 缺席 / 取消路径）不切换；
 * 3. 非临时性错误（凭据 / 参数 / 额度 / 模型不存在 / 上下文 / 未知）不盲目重试；
 * 4. 已有进度（toolCount > 0）或进度不可核实（stats 缺失 → null）不重启；
 * 5. 无未尝试候选不切换（每候选至多一次 = 重试次数上限）；
 * 6. 剩余等待预算不足（MIN_FAILOVER_BUDGET_MS）不启动新尝试；
 * 7. 其余：切换。
 */
export function shouldFailoverAfterFailure(input: {
  result: { stopped?: boolean; userClosed?: boolean; handedOff?: boolean };
  routeException: RouteException | undefined;
  /** 子代理已执行的工具调用数；stats 缺失传 null（不可核实，按有进度处理）。 */
  toolCount: number | null;
  /** 剩余等待预算（毫秒）；无 timeoutMs 传 null（不限）。 */
  waitBudgetMs: number | null;
  /** 候选池里尚未尝试的候选数。 */
  untriedCandidates: number;
}): FailoverDecision {
  if (input.result.stopped) return { failover: false, reason: "subagent was stopped explicitly" };
  if (input.result.userClosed) return { failover: false, reason: "subagent pane was closed by the user" };
  if (input.result.handedOff) return { failover: false, reason: "subagent was handed off (host reload / session detach)" };
  if (!input.routeException) {
    return { failover: false, reason: "no route exception classified (success or non-route failure)" };
  }
  if (!isFailoverSwitchable(input.routeException.kind)) {
    return {
      failover: false,
      reason: `error kind "${input.routeException.kind}" is not a transient route failure — not blindly retried`,
    };
  }
  if (input.toolCount == null || input.toolCount > 0) {
    return {
      failover: false,
      reason: "the failed attempt had already made progress (tool calls executed) — restarting would duplicate side effects",
    };
  }
  if (input.untriedCandidates <= 0) {
    return { failover: false, reason: "no untried candidates remain (each candidate is tried at most once)" };
  }
  if (input.waitBudgetMs != null && input.waitBudgetMs < MIN_FAILOVER_BUDGET_MS) {
    return { failover: false, reason: "remaining wait budget is too small for another attempt" };
  }
  return { failover: true, reason: "transient route failure with no progress" };
}

/**
 * 全候选不可用时的聚合错误文案：逐尝试列出候选与错误（按尝试顺序），
 * 附剩余候选不可选择的结构化原因（最后一轮 planSpawn 的错误）。
 */
export function aggregateFailoverExhaustion(input: {
  tier: ModelTier;
  pool: readonly string[];
  attempts: readonly ModelFailoverAttempt[];
  /** 剩余候选（未尝试但被计划阶段过滤）不可选的错误文本。 */
  remainingError?: string;
}): string {
  const lines = [
    `All model candidates for tier "${input.tier}" are unavailable.`,
    `Tried in configured order (pool: ${input.pool.join(", ")}):`,
    ...input.attempts.map(
      (attempt) => `  - attempt ${attempt.index} ${attempt.model}: ${attempt.kind}: ${truncate(attempt.message)}`,
    ),
  ];
  if (input.remainingError) {
    lines.push(`Remaining candidates were not selectable:\n${input.remainingError}`);
  } else {
    lines.push("No untried candidates remain — every candidate was tried at most once, in configured order.");
  }
  lines.push(
    "The failures above are transient route errors recorded per attempt; check the providers or adjust the tier candidate pool.",
  );
  return lines.join("\n");
}
