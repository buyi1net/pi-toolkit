// 子代理终态 → 用量统计事件的桥接（工单 28）。
//
// 子代理模块是统计数据的生产者：每次 watcher 终态（成功/失败/取消）都构造
// 一条 UsageRunEvent 交给 `usage.recorder` 句柄；handed-off 不是终态（真实
// 结果稍后由恢复路径的 watcher 交付），不记录，避免重复计数。成员轮次不走
// 这里的终态口径（watchMemberRound 无 SubagentResult），第一版不记录。
//
// 实际模型与供应商以运行态为准（计划期选中的候选）；首选模型来自启动时快照
// 的候选池首个；降级判定只在两者都可判定时给出。

import { routeExceptionFromResult } from "./route-error.ts";
import { baseModelRef } from "./model-health.ts";
import type { RunningSubagent, SubagentResult } from "./types.ts";
import type { UsageOutcome, UsageRunEvent } from "../usage/api.ts";

/** 终态结果 → 统计事件（纯函数）。 */
export function createUsageEvent(running: RunningSubagent, result: SubagentResult): UsageRunEvent {
  const model = running.model ? baseModelRef(running.model) : null;
  const preferred = running.modelPool?.[0] ? baseModelRef(running.modelPool[0]) : null;
  const exception = routeExceptionFromResult(result, running.model);
  const failed = result.exitCode !== 0 || !!result.errorMessage;
  const outcome: UsageOutcome =
    result.stopped || result.userClosed ? "cancelled" : failed ? "failed" : "completed";
  const stats = result.stats;
  return {
    name: running.name,
    task: running.task,
    sessionFile: running.sessionFile,
    sessionId: running.hostSessionId ?? null,
    cohortId: running.cohortId ?? null,
    agent: running.agent ?? null,
    model,
    thinking: running.thinking ?? null,
    tier: running.tier ?? null,
    preferredModel: preferred,
    elapsedSeconds: result.elapsed,
    tokens: stats
      ? {
          input: stats.inputTokens,
          output: stats.outputTokens,
          cacheRead: stats.cacheReadTokens,
          cacheWrite: stats.cacheWriteTokens,
          costUsd: stats.cost,
        }
      : null,
    toolCount: stats?.toolCount ?? null,
    outcome,
    exitCode: result.exitCode,
    routeErrorKind: exception?.kind ?? null,
    routeErrorMessage: exception?.message ?? null,
  };
}

/**
 * 把 watcher 终态接到统计记录器：记录失败绝不影响结果投递（统计是旁路）。
 * handed-off 由恢复路径的真实终态记录，这里跳过。
 */
export function withUsageRecording(
  watch: Promise<SubagentResult>,
  running: RunningSubagent,
  record?: (event: UsageRunEvent) => void,
): Promise<SubagentResult> {
  if (!record) return watch;
  return watch.then((result) => {
    if (!result.handedOff) {
      try {
        record(createUsageEvent(running, result));
      } catch {
        // 统计失败不影响子代理终态与依赖回注。
      }
    }
    return result;
  });
}
