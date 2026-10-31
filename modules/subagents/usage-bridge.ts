import { routeExceptionFromResult } from "./route-error.ts";
import { baseModelRef } from "./model-health.ts";
import {
  routingInheritanceCause,
  routingModelOrigin,
} from "./routing-snapshot.ts";
import type { RunningSubagent, SubagentResult } from "./types.ts";
import type { UsageOutcome, UsageRunEvent } from "../usage/api.ts";

export function createUsageEvent(running: RunningSubagent, result: SubagentResult): UsageRunEvent {

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

      }
    }
    return result;
  });
}
