// 子代理终态 → 用量统计事件的桥接（工单 28；工单 08 起统一读路由快照）。
//
// 子代理模块是统计数据的生产者：每次 watcher 终态（成功/失败/取消）都构造
// 一条 UsageRunEvent 交给 `usage.recorder` 句柄；handed-off 不是终态（真实
// 结果稍后由恢复路径的 watcher 交付），不记录，避免重复计数。成员轮次不走
// 这里的终态口径（watchMemberRound 无 SubagentResult），第一版不记录。
//
// 实际模型、档位、思考等级、首选与模型来源以运行态的路由快照
// （running.modelRouting，工单 06）为准；旧运行态缺快照时退回零散字段，
// 与既有口径一致。首选随快照给（全池阻断的继承保留池首、降级口径如实；
// 池未配置的继承无首选 → 降级判定保持未知 null）。

import { routeExceptionFromResult } from "./route-error.ts";
import { baseModelRef } from "./model-health.ts";
import {
  routingInheritanceCause,
  routingModelOrigin,
} from "./routing-snapshot.ts";
import type { RunningSubagent, SubagentResult } from "./types.ts";
import type { UsageOutcome, UsageRunEvent } from "../usage/api.ts";

/** 终态结果 → 统计事件（纯函数）。 */
export function createUsageEvent(running: RunningSubagent, result: SubagentResult): UsageRunEvent {
  // 工单 08：路由事实从快照读（模型/档位/思考等级/首选/来源/继承原因）；
  // 快照在场时以它的值为准（包括合法的 null），缺快照的旧运行态/mock
  // 才退回零散字段（首选退回池首，工单 28 现状口径）。
  const routing = running.modelRouting ?? null;
  const source = routingModelOrigin(routing);
  const model = routing ? routing.model : running.model ?? null;
  const modelBase = model ? baseModelRef(model) : null;
  const preferredRef = routing ? routing.preferred : running.modelPool?.[0] ?? null;
  const preferred = preferredRef ? baseModelRef(preferredRef) : null;
  const exception = routeExceptionFromResult(result, model);
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
    model: modelBase,
    thinking: routing ? routing.effectiveThinking : running.thinking ?? null,
    tier: routing ? routing.tier : running.tier ?? null,
    preferredModel: preferred,
    modelSource: source,
    inheritanceCause: source === "parent" ? routingInheritanceCause(routing) : null,
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
