import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import {
  findLastAssistantOutcome,
  getNewEntries,
  getSessionId,
  readNameRegistry,
  readSubagentLoadout,
  registerName,
  resolveNameInRegistry,
} from "./session.ts";
import { normalizeSubagentName } from "./names.ts";
import { resolveSurfaceChoice, type SubagentSurfaceChoice } from "./launch-config.ts";
import { peekExitSidecar } from "./surface.ts";
import { debugLog } from "./diagnostics.ts";
import { routeExceptionFromResult } from "./route-error.ts";
import {
  announceCompletion,
  dependencyExceptionResult,
  exceptionKindForOutcome,
  findDependencyCycle,
  getCompletionRecord,
  normalizeDependencyName,
  settleCompletionFromResult,
  waitForCompletion,
  type CompletionRecord,
  type DependencyException,
  type DependencyOutcome,
} from "./dependencies.ts";
import { normalizeCohortId, SubagentParams, validateCohortId } from "./params.ts";
import { cleanupSubagentArtifacts, resolveRetentionDecision } from "./retention.ts";
import { markRuntimeWaitReleased } from "./runtime-registry.ts";
import type { RunningSubagent, SubagentResult } from "./types.ts";

/** 等待解除原因:Escape 中止或 timeoutMs 超时——都是“只解除工具等待,
 *  不动子代理”的非终态(超时即程序触发的 detach)。 */
export type WaitRelease = { kind: "escape" } | { kind: "timeout" };

/**
 * 硬屏障等待的三向竞速:watcher 终态 / 宿主 signal 中止(Escape)/ 可选
 * timeoutMs 超时。竞速落定即清理定时器与监听器,不留悬挂的定时器;
 * watcher reject 兑底为失败结果(不丢错误)。signal 与 timeout 同时存在
 * 时先到者胜。未传 signal 且未传 timeout 时直接等待(现有无限等待)。
 */
export async function waitForSubagentTerminal(params: {
  watchPromise: Promise<SubagentResult>;
  running: RunningSubagent;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<SubagentResult | WaitRelease> {
  const { watchPromise, running, signal, timeoutMs } = params;
  const guarded = watchPromise.then(
    (value) => value,
    (error) => syntheticWatcherError(running, error),
  );
  if (!signal && timeoutMs == null) return guarded;
  return new Promise<SubagentResult | WaitRelease>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let onAbort: (() => void) | null = null;
    const settle = (value: SubagentResult | WaitRelease) => {
      if (timer != null) clearTimeout(timer);
      if (onAbort && signal) signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    if (signal) {
      onAbort = () => settle({ kind: "escape" });
      if (signal.aborted) {
        settle({ kind: "escape" });
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    if (timeoutMs != null) {
      timer = setTimeout(() => settle({ kind: "timeout" }), timeoutMs);
    }
    guarded.then((value) => settle(value));
  });
}

/** timeoutMs 参数校验(信任边界:模型传参);返回错误文案或 null。 */
export function validateTimeoutMs(timeoutMs: unknown): string | null {
  if (timeoutMs == null) return null;
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 1000) {
    return `Invalid timeoutMs: must be an integer >= 1000 (milliseconds); got ${String(timeoutMs)}.`;
  }
  return null;
}

interface SpawnContext {
  sessionManager: {
    getSessionFile(): string | null | undefined;
    getSessionId(): string;
    getSessionDir(): string;
  };
  cwd: string;
}

export interface SubagentToolDeps {
  allowlist: Set<string> | null;
  discoverAgents: () => Array<{ name: string }>;
  isMuxAvailable: () => boolean;
  muxUnavailableResult: () => any;
  /** 表面选择(auto/background/pane):pane 需要 mux,headless 不需要。 */
  resolveSurfaceChoice: (params: { surface?: string; agent?: string }) =>
    { choice: SubagentSurfaceChoice } | { error: string };
  getArtifactDir: (sessionDir: string, sessionId: string) => string;
  runningSubagents: Map<string, RunningSubagent>;
  reservedNames: Set<string>;
  /** 该 spawn 是否交互式(演示 pane);完成注册表用它拒绝交互式依赖提供者。
   *  可选:旧测试夹具缺省时按非交互式处理。 */
  resolveInteractive?: (params: { agent?: string }) => boolean;
  uniqueRunningName: (base: string, registryNames?: Set<string>) => string;
  launchSubagent: (params: typeof SubagentParams.static, ctx: SpawnContext) => Promise<RunningSubagent>;
  startWidgetRefresh: () => void;
  startStatusRefresh: (pi: ExtensionAPI) => void;
  watchSubagent: (running: RunningSubagent, signal: AbortSignal) => Promise<SubagentResult>;
  /** 持久成员的轮次 watcher(fire-and-forget:.round 消费/回注、offline 检测、mailbox 注入)。 */
  watchMemberRound: (running: RunningSubagent, signal: AbortSignal) => void | Promise<void>;
  /** 同名重建判定:member spawn 复用 offline 成员名字(roster 状态为准)。可选:
   *  旧测试夹具缺省时按不可复用处理。 */
  canReuseMemberName?: (name: string, artifactDir: string) => boolean;
  updateWidget: () => void;
  resolveResultPresentation: (
    result: SubagentResult,
    name: string,
    options?: { sessionPreserved?: boolean },
  ) => string;
}

/** watcher 异常 reject 时的合成失败结果(正常不 reject,兑底保护不丢错误)。 */
function syntheticWatcherError(running: RunningSubagent, error: unknown): SubagentResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    name: running.name,
    task: running.task,
    summary: `Subagent error: ${message}`,
    exitCode: 1,
    elapsed: Math.floor((Date.now() - running.startTime) / 1000),
    errorMessage: message,
    sessionFile: running.sessionFile,
    ...(running.cohortId ? { cohortId: running.cohortId } : {}),
  };
}

/**
 * retention 决策 + 清理执行:正常硬屏障返回路径与 detached 迟到回注共用,
 * 保证两条路径的保留语义不漂移。删除发生在结果定型之后,失败只 debug。
 */
function applyRetentionToRunning(
  running: RunningSubagent,
  policy: "auto" | "preserve" | "discard",
  outcome: { cancelled: boolean; failed: boolean; handedOff: boolean },
): Record<string, unknown> {
  const decision = resolveRetentionDecision({
    policy,
    interactive: running.interactive,
    kind: running.kind,
    ...outcome,
  });
  if (decision.action === "delete") {
    const cleanup = cleanupSubagentArtifacts({
      sessionFile: running.sessionFile,
      ...(running.activityFile ? { activityFile: running.activityFile } : {}),
      ...(running.contextFiles?.length ? { contextFiles: running.contextFiles } : {}),
    });
    return cleanup.skipped.length > 0
      ? { policy, outcome: "preserved", reason: "pending-ask" }
      : {
          policy,
          outcome: "cleaned",
          reason: decision.reason,
          ...(cleanup.removed.length ? { removed: cleanup.removed } : {}),
          ...(cleanup.errors.length ? { errors: cleanup.errors } : {}),
        };
  }
  return { policy, outcome: "preserved", reason: decision.reason };
}

/**
 * detached(Escape 中止等待)后的迟到回注:watcher 到达真实终态时 settle
 * 依赖记录并经 steer 消息把真实结果回注恰好一次。
 *
 * 幂等保证:watcher promise 单次 resolve → 回调至多触发一次;本注册仅在
 * detached 分支发生(正常路径的结果由工具调用直接返回,不再注册);
 * handedOff(再次 /reload 或宿主会话关闭移交)跳过回注,由恢复路径接管,
 * 不伪造、不重复。依赖 completion 不提前 settle——detached 时上游仍在
 * 运行,dependsOn 消费者继续等待真实终态。
 */
function registerDetachedLateDelivery(
  pi: ExtensionAPI,
  deps: SubagentToolDeps,
  running: RunningSubagent,
  watchPromise: Promise<SubagentResult>,
  retentionPolicy: "auto" | "preserve" | "discard",
): void {
  watchPromise
    .then((late) => {
      deps.updateWidget();
      // 真实终态才 settle:user_closed/显式停止按取消语义,不误报 failed。
      settleCompletionFromResult(running.name, late, {
        ...(late.userClosed || late.stopped ? { status: "cancelled" as const } : {}),
      });
      // 移交(再次 /reload 或宿主会话关闭):恢复路径接管,不在此回注。
      if (late.handedOff) return;
      const failed = late.exitCode !== 0 || !!late.errorMessage;
      const retentionDetails = applyRetentionToRunning(running, retentionPolicy, {
        cancelled: !!late.userClosed || !!late.stopped,
        failed,
        handedOff: false,
      });
      const presentation = late.stopped
        ? `Sub-agent "${running.name}" was stopped explicitly (subagent_stop) after the wait had been detached — ` +
          `no result was produced. Its session is preserved; resume it with subagent_message if the task still matters.`
        : deps.resolveResultPresentation(late, running.name, {
            sessionPreserved: retentionDetails.outcome !== "cleaned",
          });
      const routeException = late.userClosed || late.stopped
        ? undefined
        : routeExceptionFromResult(late, running.model);
      pi.sendMessage(
        {
          customType: "subagent_result",
          content: presentation,
          display: true,
          details: {
            name: running.name,
            task: running.task,
            agent: running.agent,
            ...(running.cohortId ? { cohortId: running.cohortId } : {}),
            exitCode: late.exitCode,
            elapsed: late.elapsed,
            sessionFile: late.sessionFile,
            status: late.userClosed ? "user_closed" : late.stopped ? "cancelled" : failed ? "failed" : "completed",
            lateDelivery: "detached",
            retention: retentionDetails,
            ...(late.userClosed ? { userClosed: true } : {}),
            ...(late.sessionId ? { sessionId: late.sessionId } : {}),
            ...(late.errorMessage ? { errorMessage: late.errorMessage } : {}),
            ...(late.stats ? { stats: late.stats } : {}),
            ...(routeException ? { routeException } : {}),
          },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    })
    .catch((error: any) => {
      deps.updateWidget();
      // watcher reject(正常不发生):兑底为失败终态,唤醒所有等待者并回注一次。
      settleCompletionFromResult(running.name, {
        exitCode: 1,
        errorMessage: error?.message ?? String(error),
        sessionFile: running.sessionFile,
      });
      pi.sendMessage(
        {
          customType: "subagent_result",
          content: `Sub-agent "${running.name}" error after detached wait: ${error?.message ?? String(error)}`,
          display: true,
          details: {
            name: running.name,
            task: running.task,
            ...(running.cohortId ? { cohortId: running.cohortId } : {}),
            error: error?.message,
            lateDelivery: "detached",
          },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    });
}

// ── dependsOn v1:launch 前的依赖解析与等待 ─────────────────────────────
// 上游结果摘要拼进下游 task 时的单条截断上限:够模型获知结论,不把 task
// 撑成上下文炸弹。
const UPSTREAM_SUMMARY_LIMIT = 1600;

function buildUpstreamAppendix(outcomes: DependencyOutcome[]): string {
  const blocks = outcomes.map((outcome) => {
    const raw = (outcome.summary ?? "").trim();
    const summary =
      raw.length > UPSTREAM_SUMMARY_LIMIT
        ? raw.slice(0, UPSTREAM_SUMMARY_LIMIT) + "…(truncated)"
        : raw || "(no summary text captured)";
    return `Upstream subagent "${outcome.name}" completed:\n${summary}`;
  });
  return `[Upstream dependency results — context only, not your task]\n${blocks.join("\n\n")}`;
}

export type DependsOnResolution =
  | { ok: true; appendix: string }
  | { ok: false; appendix: ""; exception: DependencyException };

function blockedResolution(exception: DependencyException): DependsOnResolution {
  return { ok: false, appendix: "", exception };
}

/** 把从会话文件解析出的终态缓存进注册表:同一消息的后续消费者直接命中,
 *  不重读磁盘(.exit sidecar 首读即被消费,缓存也避免二次读取结果漂移)。 */
function cacheDiskOutcome(dep: string, outcome: DependencyOutcome): void {
  if (!getCompletionRecord(dep)) announceCompletion(dep).settle(outcome);
}

/**
 * 在真正 launch 前解析并等待 dependsOn(逐条串行,短路返回第一个异常):
 * 1. pending/settled 完成记录(同会话,含同一 assistant message 的 sibling)
 *    → 等待其 completion promise(支持 AbortSignal);等待前登记 waitingOn
 *    边并做环检测——同消息 sibling 互相 dependsOn 会永久互等,必须结构化失败;
 * 2. 本进程运行中但无完成记录(reload 恢复边界)→ 明确 fail-fast,不无限挂;
 * 3. 跨 turn 已完成 → 从会话名字注册表 + 会话文件判定终态(.exit sidecar
 *    只读不消费:失败结果同时缓存进注册表,后续判定不依赖文件存活);
 * 4. 找不到 → unknown_dependency。
 * 自身依赖、空名、交互式提供者一律拒绝,避免死锁。不猜测批次分母。
 */
export async function resolveDependsOn(params: {
  ownName: string;
  dependsOn: string[];
  artifactDir: string;
  runningSubagents: Map<string, RunningSubagent>;
  signal?: AbortSignal;
  ownRecord?: CompletionRecord;
}): Promise<DependsOnResolution> {
  const { ownName, dependsOn, artifactDir, runningSubagents, signal } = params;
  const completed: DependencyOutcome[] = [];
  const seen = new Set<string>();

  for (const rawEntry of dependsOn) {
    const dep = normalizeDependencyName(rawEntry ?? "");
    if (!dep) {
      return blockedResolution({
        kind: "unknown_dependency",
        dependency: "",
        message: "Invalid dependsOn entry: dependency names must be non-empty.",
      });
    }
    if (dep === ownName) {
      return blockedResolution({
        kind: "self_dependency",
        dependency: dep,
        message: `Subagent "${ownName}" cannot depend on itself — that would deadlock the launch. Remove it from dependsOn.`,
      });
    }
    if (seen.has(dep)) continue;
    seen.add(dep);

    const record = getCompletionRecord(dep);
    if (record) {
      // 交互式(演示 pane)子代理与持久团队成员都没有可等待的硬屏障终态:
      // pending 时直接拒绝,不排队等一个语义不成立的结果。
      if (record.member) {
        return blockedResolution({
          kind: "member_dependency",
          dependency: dep,
          message:
            `"${dep}" is a persistent team member (member: true) — members stay alive between rounds and have no process-level ` +
            `terminal state, so they cannot be a dependsOn target. Consume each round's steer-delivered result instead, or drop the dependency.`,
        });
      }
      if (!record.settled && record.interactive) {
        return blockedResolution({
          kind: "interactive_dependency",
          dependency: dep,
          message:
            `"${dep}" is an interactive (demo) subagent without a waitable terminal state, so it cannot be a dependsOn target. ` +
            `Consume its steer-delivered result instead, or drop the dependency.`,
        });
      }
      // 环检测:登记本 spawn 的等待边后,从目标沿 pending 记录的 waitingOn
      // 边回溯;能回到自己即同消息 sibling 互等——结构化失败,不进入等待。
      params.ownRecord?.waitingOn.add(dep);
      const cycle = findDependencyCycle(ownName, dep);
      if (cycle) {
        return blockedResolution({
          kind: "dependency_cycle",
          dependency: dep,
          message:
            `Dependency cycle detected: ${cycle.join(" → ")}. Sibling subagent calls in the same message cannot wait on ` +
            `each other — nothing was launched for "${ownName}". Break the cycle by removing one dependsOn edge.`,
        });
      }
      let outcome: DependencyOutcome;
      try {
        outcome = await waitForCompletion(dep, signal);
      } catch (error: any) {
        return blockedResolution({
          kind: "aborted",
          dependency: dep,
          message: `${error?.message ?? String(error)}. Nothing was launched for "${ownName}".`,
        });
      } finally {
        params.ownRecord?.waitingOn.delete(dep);
      }
      if (outcome.status !== "completed") {
        const reason: Record<string, string> = {
          dependency_failed: `Upstream subagent "${dep}" failed, so this call was NOT launched. Decide whether to respawn the upstream subagent or continue without it — do not treat this task as started.`,
          dependency_cancelled: `Upstream subagent "${dep}" was cancelled, so this call was NOT launched. Respawn or resume it first if this task still matters.`,
          dependency_handed_off: `Upstream subagent "${dep}" was handed off to recovery after a host reload and has no waitable result, so this call was NOT launched.`,
        };
        return blockedResolution({
          kind: exceptionKindForOutcome(outcome.status),
          dependency: dep,
          message: reason[exceptionKindForOutcome(outcome.status)],
          ...(outcome.exitCode !== undefined || outcome.errorMessage || outcome.sessionFile
            ? {
                upstream: {
                  ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
                  ...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
                  ...(outcome.sessionFile ? { sessionFile: outcome.sessionFile } : {}),
                },
              }
            : {}),
        });
      }
      completed.push(outcome);
      continue;
    }

    // 本进程运行中但无完成记录:典型是 /reload 恢复的子代理(watcher 早已
    // 启动,注册表里没有它的完成 promise)。明确 fail-fast,绝不无限等。
    const running = Array.from(runningSubagents.values()).find((candidate) => candidate.name === dep);
    if (running) {
      return blockedResolution({
        kind: "running_without_waiter",
        dependency: dep,
        message:
          `"${dep}" is running in this session but has no waitable completion record ` +
          `(its watcher started outside this session's dependency registry, e.g. after a host reload). ` +
          `Failing fast instead of waiting forever — wait for its result message or resume it explicitly, then retry this call.`,
      });
    }

    // 跨 turn 已完成:从会话名字注册表 + 会话文件判定终态。
    const entry = resolveNameInRegistry(artifactDir, dep);
    if (!entry) {
      return blockedResolution({
        kind: "unknown_dependency",
        dependency: dep,
        message:
          `No subagent named "${dep}" in this session — it is not running, not announced by a sibling call in this message, ` +
          `and not in the session name registry. Check the spelling, spawn it first, or drop the dependency.`,
      });
    }
    if (!entry.sessionFile || !existsSync(entry.sessionFile)) {
      return blockedResolution({
        kind: "unknown_dependency",
        dependency: dep,
        message: `"${dep}" is registered but its session file is missing (${entry.sessionFile ?? "none"}); its outcome cannot be determined.`,
      });
    }
    const loadout = readSubagentLoadout(entry.sessionFile);
    if (loadout?.member) {
      return blockedResolution({
        kind: "member_dependency",
        dependency: dep,
        message:
          `"${dep}" is a persistent team member — members stay alive between rounds and have no process-level ` +
          `terminal state, so they cannot be a dependsOn target. Consume each round's steer-delivered result instead.`,
      });
    }
    if (loadout && loadout.autoExit === false) {
      return blockedResolution({
        kind: "interactive_dependency",
        dependency: dep,
        message:
            `"${dep}" is an interactive (demo) subagent (auto-exit disabled) without a waitable terminal result, ` +
            `so it cannot be a dependsOn target.`,
      });
    }
    const exit = peekExitSidecar(entry.sessionFile);
    if (exit && (exit.exitCode !== 0 || exit.errorMessage)) {
      const outcome: DependencyOutcome = {
        name: dep,
        status: "failed",
        exitCode: exit.exitCode,
        ...(exit.errorMessage ? { errorMessage: exit.errorMessage } : {}),
        sessionFile: entry.sessionFile,
        source: "session-file",
      };
      cacheDiskOutcome(dep, outcome);
      return blockedResolution({
        kind: "dependency_failed",
        dependency: dep,
        message: `Upstream subagent "${dep}" failed in an earlier turn, so this call was NOT launched.`,
        upstream: {
          exitCode: exit.exitCode,
          ...(exit.errorMessage ? { errorMessage: exit.errorMessage } : {}),
          sessionFile: entry.sessionFile,
        },
      });
    }
    let assistantOutcome: ReturnType<typeof findLastAssistantOutcome>;
    try {
      assistantOutcome = findLastAssistantOutcome(getNewEntries(entry.sessionFile, 0));
    } catch {
      assistantOutcome = { summary: null, errorMessage: null };
    }
    if (assistantOutcome.errorMessage) {
      const outcome: DependencyOutcome = {
        name: dep,
        status: "failed",
        ...(assistantOutcome.summary ? { summary: assistantOutcome.summary } : {}),
        exitCode: 1,
        errorMessage: assistantOutcome.errorMessage,
        sessionFile: entry.sessionFile,
        source: "session-file",
      };
      cacheDiskOutcome(dep, outcome);
      return blockedResolution({
        kind: "dependency_failed",
        dependency: dep,
        message:
          `Upstream subagent "${dep}" failed in an earlier turn (${assistantOutcome.errorMessage}), ` +
          `so this call was NOT launched.`,
        upstream: {
          exitCode: 1,
          errorMessage: assistantOutcome.errorMessage,
          sessionFile: entry.sessionFile,
        },
      });
    }
    if (assistantOutcome.summary == null) {
      return blockedResolution({
        kind: "unknown_dependency",
        dependency: dep,
        message:
          `"${dep}" is registered but no final result could be read from its session file, so its outcome cannot be determined. ` +
          `It may still be running under another host; do not depend on it.`,
      });
    }
    const outcome: DependencyOutcome = {
      name: dep,
      status: "completed",
      summary: assistantOutcome.summary,
      sessionFile: entry.sessionFile,
      source: "session-file",
    };
    cacheDiskOutcome(dep, outcome);
    completed.push(outcome);
  }

  return { ok: true, appendix: completed.length > 0 ? buildUpstreamAppendix(completed) : "" };
}

export function registerSubagentTool(pi: ExtensionAPI, deps: SubagentToolDeps): void {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Spawn a sub-agent as an independent process. " +
      "AUTONOMOUS SUBAGENTS (agents defined with auto-exit, the default for workers): by default they run HEADLESS — an independent background pi process with NO pane/tab — and the call BLOCKS until the sub-agent reaches a terminal state; its real result is returned directly as this tool's result, never a placeholder. " +
      "Multiple subagent calls in the SAME assistant message run in PARALLEL, and the turn continues only after all of them have settled, so batch them freely and end your turn after spawning. " +
      "VISIBLE DEMO SUBAGENTS (agents defined without auto-exit / interactive: true): the call returns immediately with only an acknowledgement; the sub-agent runs in a visible pane that belongs to the user, and the result is delivered later as a steer message that starts a new turn. Never block on a demo subagent. " +
      "ESCAPE / ABORT SEMANTICS: aborting this tool call (e.g. the user presses Escape) does NOT cancel the sub-agent — the wait is only DETACHED. The call returns a `detached` non-terminal result; the sub-agent keeps running (its session, runtime registration and dependency record are all preserved), and its real result is delivered later as a steer message, exactly once. Do not respawn a detached sub-agent. The ONLY way to actually terminate a running sub-agent early is the subagent_stop tool. " +
      "TIMEOUT (timeoutMs): optional wait bound in milliseconds (>= 1000) for the autonomous hard barrier. When it fires the call returns a structured non-terminal `timed-out` result — the sub-agent is NOT killed or cancelled, nothing is cleaned up and no summary is fabricated; it behaves exactly like an Escape-detach, and the real result arrives later as a single steer message. DependsOn consumers keep waiting for the real terminal state (the timeout covers the post-launch run wait only). Omit timeoutMs to wait indefinitely (existing behavior); refused for interactive agents. Siblings in the same message each return their own tool result — a timed-out call is not a batch summary. " +
      "PERSISTENT TEAM MEMBERS (member: true): spawns a long-lived headless team member instead of a one-shot sub-agent. The call returns an immediate ack (no hard barrier); the member stays alive between rounds, receives follow-up rounds via team_dispatch, and each round's result is delivered once as a steer message. Members may fire-and-forget message each other via team_send along the profile's peer-send ACL. Refused combinations: surface 'pane', interactive agents, retention 'discard', timeoutMs, dependsOn. Members cannot be dependsOn targets. Terminate a member explicitly with subagent_stop; host shutdown or /reload terminates members and marks them offline (session preserved for explicit resume). " +
      "surface parameter: 'auto' (default — headless for autonomous, visible pane for interactive), 'background' (force headless; refused for interactive agents), 'pane' (force a visible pane). " +
      "RETENTION parameter: 'auto' (default) | 'preserve' | 'discard' — controls what happens to a headless autonomous sub-agent's session artifacts (session JSONL, .loadout.json, context task/system-prompt files, activity/runtime registration) AFTER this call has settled with the real result. 'auto': successful runs are cleaned up; failed/cancelled/handed-off runs are preserved so you can resume them with subagent_message. 'preserve': always keep everything. 'discard': always clean up after a terminal state, including failures — use when you know you will never resume. Visible pane / demo sub-agents are ALWAYS preserved regardless. Cleanup never affects the tool result." +
      "tier parameter: 'fast' | 'balanced' | 'deep' preset resolved from the pi-subagents config (models.fast/balanced/deep; aliases quick/balance/standard/strong accepted). An explicit `model` always wins over `tier`; a tier without a configured model fails with a clear error — models are never silently swapped. " +
      "DEPENDENCIES (dependsOn): pass `dependsOn: [names]` to make this call WAIT for those same-session subagents to reach a terminal state BEFORE launching — including siblings issued in the SAME assistant message (the dependent call waits on the upstream completion promise; independent siblings still run in parallel). " +
      "When all dependencies completed, a short real-results context block is appended to `task`. If any dependency failed or was cancelled, this call does NOT launch and the tool result details carry a structured `dependencyException` (kind, dependency, upstream error) — no pane/process is created. " +
      "Rejected without launching: this call's own name, unknown names (not running, not announced by a sibling, not in the session registry), running-without-waiter (e.g. after a host reload), and interactive demo subagents (no waitable terminal state). Dependencies finished in an earlier turn are resolved from the session registry. " +
      "ROUTE FAILURES: when a sub-agent dies on quota/auth/rate-limit/model/context errors, the tool result details carry a structured `route_exception` (kind, retryable, provider/model, suggestedActions) for YOU to decide on — there is no automatic fallback, sibling subagents keep running, and you choose whether to respawn (same or different model) or report to the user. " +
      "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. If you need a deliberate one-time diagnostic snapshot, use subagent_inspect; do not call it repeatedly just to wait. " +
      "DO NOT fabricate, assume, or summarize results you do not yet have. " +
      "PANE SAFETY: you may freely create panes and read from or send keys to panes when the task requires it; but NEVER close or kill a pane you did not create yourself — before terminating any pane, verify it is yours (spawned by you in this session) or ask the user. Panes you did not create may belong to the user or other agents and may hold running work. " +
      "After spawning, either end your turn immediately, or work on other independent tasks (including spawning more subagents in parallel). The harness handles delivery for you.",
    promptSnippet:
      "Spawn a sub-agent. Autonomous subagents (auto-exit, the default) run headless in the background (no pane) and block this call until terminal state, returning their real result as the tool result; sibling calls in one message run in parallel and all settle before the turn continues. Demo subagents (interactive) run in a visible pane, return immediately, and deliver their result later as a steer message. Do not poll; do not fabricate results.",
    parameters: SubagentParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cohortError = validateCohortId(params.cohortId);
      if (cohortError) {
        return { content: [{ type: "text", text: cohortError }], details: { error: cohortError } };
      }
      const cohortId = normalizeCohortId(params.cohortId);
      if (cohortId) params.cohortId = cohortId;
      else delete params.cohortId;

      const currentAgent = process.env.PI_SUBAGENT_AGENT;
      if (params.agent && currentAgent && params.agent === currentAgent) {
        return {
          content: [{
            type: "text",
            text: `You are the ${currentAgent} agent — do not start another ${currentAgent}. You were spawned to do this work yourself. Complete the task directly.`,
          }],
          details: { error: "self-spawn blocked" },
        };
      }

      const permittedAgents = deps.allowlist
        ? [...deps.allowlist]
        : deps.discoverAgents().map((agent) => agent.name);
      const permittedSet = new Set(permittedAgents);
      const permittedList = permittedAgents.join(", ") || "(none)";

      if (!params.agent) {
        return {
          content: [{
            type: "text",
            text: `You must specify which agent to spawn via the "agent" field. Available agents: ${permittedList}.`,
          }],
          details: { error: "agent required" },
        };
      }
      if (!permittedSet.has(params.agent)) {
        return {
          content: [{
            type: "text",
            text:
              `You may not spawn the "${params.agent}" agent — it is not ` +
              `${deps.allowlist ? "in your allowlist" : "a known agent"}. ` +
              `Available agents: ${permittedList}.`,
          }],
          details: { error: deps.allowlist ? "agent not in allowlist" : "unknown agent" },
        };
      }

      // 表面选择:auto → headless(自动)/ pane(交互);background 强制 headless
      // (交互拒绝);pane 强制可见 pane。仅 pane 需要复用器;headless 在无
      // herdr/tmux 的环境也能运行。
      const surfaceChoice = deps.resolveSurfaceChoice(params);
      if ("error" in surfaceChoice) {
        return {
          content: [{ type: "text", text: surfaceChoice.error }],
          details: { error: surfaceChoice.error },
        };
      }
      // timeoutMs 校验与适用性检查(在创建任何 pane/进程之前):非法值直接
      // 拒绝;交互式(演示)spawn 立即返回、没有可设上限的等待,显式拒绝
      // 而不是静默忽略——避免调用方误以为有超时保护。
      const timeoutError = validateTimeoutMs(params.timeoutMs);
      if (timeoutError) {
        return {
          content: [{ type: "text", text: timeoutError }],
          details: { error: timeoutError },
        };
      }
      const timeoutMs = params.timeoutMs ?? null;
      if (timeoutMs != null && (deps.resolveInteractive?.(params) ?? false)) {
        const error =
          `timeoutMs does not apply to interactive (demo) sub-agents: their spawn returns immediately and ` +
          `there is no blocking wait to bound. Drop timeoutMs for this spawn.`;
        return { content: [{ type: "text", text: error }], details: { error } };
      }
      // ── 持久团队成员(member)约束(全部在创建任何进程之前拒绝)──
      // member 是独立生命周期,与硬屏障/依赖/保留策略/超时/pane 语义互斥;
      // 显式拒绝而非静默降级,不偷偷改变现有自动任务与演示 pane 的默认行为。
      if (params.member) {
        const interactiveAgent = deps.resolveInteractive?.(params) ?? false;
        const violations: string[] = [];
        if (params.surface === "pane") violations.push('surface "pane" (members are headless-only)');
        if (interactiveAgent) violations.push("interactive (demo) agents cannot be members");
        if (params.retention === "discard") violations.push('retention "discard" (member sessions are always preserved)');
        if (params.timeoutMs != null) violations.push("timeoutMs (members are non-blocking; there is no wait to bound)");
        if (params.dependsOn?.length) violations.push("dependsOn (members have no process-level terminal state to wait for)");
        if (violations.length > 0) {
          const error =
            `member: true cannot be combined with: ${violations.join("; ")}. ` +
            `Drop the conflicting options or spawn a regular one-shot sub-agent instead.`;
          return { content: [{ type: "text", text: error }], details: { error, violations } };
        }
      }
      if (surfaceChoice.choice === "pane" && !deps.isMuxAvailable()) return deps.muxUnavailableResult();
      if (!ctx.sessionManager.getSessionFile()) {
        return {
          content: [{
            type: "text",
            text: "Error: no session file. Start pi with a persistent session to use subagents.",
          }],
          details: { error: "no session file" },
        };
      }

      const parentArtifactDir = deps.getArtifactDir(
        ctx.sessionManager.getSessionDir(),
        ctx.sessionManager.getSessionId(),
      );
      let reservedName: string | null = null;
      const suppliedName = params.name?.trim();
      if (!suppliedName) {
        const registryNames = new Set(Object.keys(readNameRegistry(parentArtifactDir)));
        params.name = deps.uniqueRunningName(normalizeSubagentName(params.agent), registryNames);
        reservedName = params.name;
        deps.reservedNames.add(reservedName);
      } else {
        params.name = normalizeSubagentName(suppliedName);
        const registeredEntry = resolveNameInRegistry(parentArtifactDir, params.name);
        // offline 成员同名重建:member spawn 允许安全复用 roster 中 offline
        // 成员的名字(覆盖 registry 登记);与 team_dispatch/subagent_stop 的
        // 重启指引一致。其余场景(运行中/非 offline/非 member)照旧拒绝。
        const memberNameReuse =
          params.member === true &&
          !!registeredEntry &&
          (deps.canReuseMemberName?.(params.name, parentArtifactDir) ?? false);
        const clash =
          deps.reservedNames.has(params.name) ||
          Array.from(deps.runningSubagents.values()).some((running) => running.name === params.name) ||
          (Boolean(registeredEntry) && !memberNameReuse);
        if (clash) {
          const reuseHint = registeredEntry && !memberNameReuse
            ? params.member === true
              ? ` ("${params.name}" is not an offline team member in this session's roster; pick another name.)`
              : ` (to restart the offline team member "${params.name}", spawn it with member: true.)`
            : "";
          const error = `Subagent name "${params.name}" is already in use in this session.${reuseHint} Pick another name.`;
          return { content: [{ type: "text", text: error }], details: { error } };
        }
        reservedName = params.name;
        deps.reservedNames.add(reservedName);
      }

      let running: RunningSubagent;
      try {
        // 名字已确定:启动前登记完成记录,让同一消息里后执行的 dependsOn
        // 消费者能找到并等待本次 spawn 的终态。与保留名字同段同步执行,
        // 不给“找不到依赖”留窗口。
        const ownRecord = announceCompletion(params.name, {
          interactive: deps.resolveInteractive?.(params) ?? false,
          ...(params.member ? { member: true } : {}),
        });
        // 真正 launch 之前解析并等待 dependsOn:依赖未到终态就不启动;失败/
        // 取消/无法解析直接返回结构化异常,不创建 pane/进程。没有 dependsOn
        // 时此步直通,旧行为不变。
        if (params.dependsOn?.length) {
          const resolution = await resolveDependsOn({
            ownName: params.name,
            dependsOn: params.dependsOn,
            artifactDir: parentArtifactDir,
            runningSubagents: deps.runningSubagents,
            signal,
            ownRecord,
          });
          if (!resolution.ok) {
            // 本次 spawn 永不启动:完成记录必须落定,依赖本 spawn 的下游
            // (如有)才能拿到明确失败而不是永久等待。
            ownRecord.settle({
              name: params.name,
              status: "failed",
              errorMessage: resolution.exception.message,
              source: "dependency-blocked",
            });
            return dependencyExceptionResult(resolution.exception);
          }
          if (resolution.appendix) {
            params.task = `${params.task}\n\n${resolution.appendix}`;
          }
        }
        running = await deps.launchSubagent(params, ctx);
        // 工具层负责规范化入参;这里再写回运行态,兼容测试/宿主注入的
        // launchSubagent 实现,确保后续 registry、inspect 和结果详情同源。
        if (cohortId) running.cohortId = cohortId;
      } catch (error: any) {
        // launch 失败必须释放/拒绝:完成记录兑成失败终态,等待者不挂死;
        // 名字保留照旧在 finally 释放,异常按原语义向宿主上抛。
        settleCompletionFromResult(params.name, {
          exitCode: 1,
          errorMessage: error?.message ?? String(error),
        }, { source: "launch-failure" });
        throw error;
      } finally {
        if (reservedName) deps.reservedNames.delete(reservedName);
      }

      registerName(parentArtifactDir, running.name, {
        sessionFile: running.sessionFile,
        sessionId: getSessionId(running.sessionFile),
        ...(running.cohortId ? { cohortId: running.cohortId } : {}),
        ...(running.anchoredLoadout ? { anchored: true } : {}),
      });

      const watcherAbort = new AbortController();
      running.abortController = watcherAbort;
      deps.startWidgetRefresh();
      deps.startStatusRefresh(pi);

      // ── 持久团队成员(member):立即 ack,不走硬屏障。──
      // 成员是常驻 headless 进程:首轮任务照常经 stdin 投递,轮次结束时
      // 成员侧写 .round sidecar;父侧 round watcher 消费并恰好回注一次。
      // 后续轮次经 team_dispatch;显式终止只能 subagent_stop。
      if (running.member) {
        running.dispatchedRound = true;
        running.roundEntryBaseline = 0;
        // fire-and-forget watcher:成员常驻,轮询循环永不到终态;异常必须
        // 就地兑底(debug 日志),不能变成 unhandled rejection 杀掉宿主。
        Promise.resolve(deps.watchMemberRound(running, watcherAbort.signal)).catch((error) => {
          debugLog(`Team member round watcher failed for ${running.name}`, error);
        });
        return {
          content: [{
            type: "text",
            text:
              `Team member "${params.name}" launched and is now running its FIRST round in the background. ` +
              `Do NOT generate or assume results — each round's real result is delivered as a steer message exactly once when it ends. ` +
              `Dispatch follow-up rounds with team_dispatch({ name: "${params.name}", task: "…" }); ` +
              `members can message each other via team_send when the profile's peer-send ACL allows it; ` +
              `stop the member explicitly with subagent_stop.`,
          }],
          details: {
            id: running.id,
            name: params.name,
            task: params.task,
            agent: params.agent,
            ...(running.cohortId ? { cohortId: running.cohortId } : {}),
            sessionFile: running.sessionFile,
            status: "member-started",
            member: true,
          },
        };
      }

      // ── 可见演示子代理(interactive):保持异步立即返回,pane 归用户操作。──
      // watcher 到达终态后经 steer 消息回注,不阻塞主 turn。
      if (running.interactive) {
        const interactiveWatch = deps.watchSubagent(running, watcherAbort.signal);
        running.watchPromise = interactiveWatch;
        interactiveWatch
          .then((result) => {
            deps.updateWidget();
            // 终态(含 handed-off)落定完成记录:依赖本子代理的下游 spawn 才有
            // 明确的等待结果。/reload 移交(handedOff)不是可用结果,但等待者
            // 仍要被唤醒并拿到 handed-off 语义;用户直接关闭 pane(userClosed)
            // 按取消语义 settle,不误报 failed。
            settleCompletionFromResult(running.name, result, {
              ...(result.userClosed ? { status: "cancelled" as const } : {}),
            });
            // /reload 移交(handedOff):不是终态,恢复路径会回注真实结果;
            // 这里回注会伪造/重复结果,直接跳过。
            if (result.handedOff) return;
            const presentation = deps.resolveResultPresentation(result, running.name);
            const routeException = result.userClosed
              ? undefined
              : routeExceptionFromResult(result, running.model);
            pi.sendMessage(
              {
                customType: "subagent_result",
                content: presentation,
                display: true,
                details: {
                  name: running.name,
                  task: running.task,
                  agent: running.agent,
                  ...(running.cohortId ? { cohortId: running.cohortId } : {}),
                  exitCode: result.exitCode,
                  elapsed: result.elapsed,
                  sessionFile: result.sessionFile,
                  status: result.userClosed ? "user_closed" : result.exitCode !== 0 || result.errorMessage ? "failed" : "completed",
                  ...(result.userClosed ? { userClosed: true } : {}),
                  ...(result.sessionId ? { sessionId: result.sessionId } : {}),
                  ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
                  ...(result.stats ? { stats: result.stats } : {}),
                  ...(routeException ? { routeException } : {}),
                },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          })
          .catch((error) => {
            deps.updateWidget();
            settleCompletionFromResult(running.name, { exitCode: 1, errorMessage: error?.message ?? String(error) });
            // watcher 正常不会 reject(内部已兑底为失败结果);万一 reject,
            // 真实上报错误,不伪造成功结果。
            pi.sendMessage(
              {
                customType: "subagent_result",
                content: `Sub-agent "${running.name}" error: ${error?.message ?? String(error)}`,
                display: true,
                details: {
                  name: running.name,
                  task: running.task,
                  ...(running.cohortId ? { cohortId: running.cohortId } : {}),
                  error: error?.message,
                },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          });

        return {
          content: [{
            type: "text",
            text:
              `Sub-agent "${params.name}" launched and is now running in the background. ` +
              `Do NOT generate or assume any results — you have no idea what the sub-agent will do or produce. ` +
              `The results will be delivered to you automatically as a steer message when the sub-agent finishes. ` +
              `Until then, move on to other work or tell the user you're waiting.`,
          }],
          details: {
            id: running.id,
            name: params.name,
            task: params.task,
            agent: params.agent,
            ...(running.cohortId ? { cohortId: running.cohortId } : {}),
            sessionFile: running.sessionFile,
            status: "started",
          },
        };
      }

      // ── 自动子代理(非 interactive):硬屏障。──
      // 在本工具调用内等待子代理终态,把真实结果作为 tool result 返回。
      // pi 对同一条 assistant 消息中的 sibling tool calls 默认并行执行
      // (agent-core executeToolCallsParallel → Promise.all),且 turn_end 在
      // 全部工具调用完成后才发出;因此本调用不 resolve,turn 就不结束——
      // 同一 turn 内并行 spawn 的全部自动子代理都结束后,编排者才会带着
      // 全部 tool results 继续下一步。无需批次聚合,也不产生额外唤醒。
      //
      // 中止语义(与子代理取消严格分离):宿主中止工具等待(Escape)或
      // timeoutMs 超时都不转发到 watcher——子代理继续运行,进程/pane、
      // runtime record、依赖 completion 全部保留,本调用立即返回非终态
      // (detached/timed-out);真实结果由 watcher 终态时经迟到回注
      // (registerDetachedLateDelivery)送达一次。watcher 自身 signal 的
      // abort 只来自显式停止(subagent_stop),此时 watcher 兑 cancelled
      // 终态并终止进程/关闭 pane,走正常返回路径。
      const watchPromise = deps.watchSubagent(running, watcherAbort.signal);
      running.watchPromise = watchPromise;

      const raced = await waitForSubagentTerminal({
        watchPromise,
        running,
        signal,
        timeoutMs: timeoutMs ?? undefined,
      });
      if (typeof raced === "object" && "kind" in raced) {
        running.waitReleased = raced.kind;
        markRuntimeWaitReleased(running.runtimeFile, running.id, raced.kind);
        // 主工具等待被解除(Escape 或超时):子代理仍在运行,返回非终态。
        // 不 settle completion(上游仍在跑,dependsOn 等真实终态)、不清理
        // retention、不伪造摘要。迟到回注与 handed-off 移交由同一机制幂等处理。
        registerDetachedLateDelivery(pi, deps, running, watchPromise, params.retention ?? "auto");
        if (raced.kind === "timeout") {
          return {
            content: [{
              type: "text",
              text:
                `Sub-agent "${running.name}" wait timed out after ${Math.round(timeoutMs! / 1000)}s (timeoutMs) — this is NOT a result. ` +
                `The sub-agent itself is STILL RUNNING and was NOT cancelled, and no summary exists yet — do not assume or fabricate one. ` +
                `Its real result will be delivered as a steer message when it finishes, exactly once. ` +
                `Do not respawn it. You can steer it meanwhile (subagent_message), stop it (subagent_stop), or simply wait. ` +
                `Sibling calls in this message each return their own tool result; this is not a batch summary.`,
            }],
            details: {
              id: running.id,
              name: running.name,
              task: running.task,
              agent: running.agent,
              ...(running.cohortId ? { cohortId: running.cohortId } : {}),
              sessionFile: running.sessionFile,
              elapsed: Math.floor((Date.now() - running.startTime) / 1000),
              timeoutMs,
              status: "timed-out",
            },
          };
        }
        return {
          content: [{
            type: "text",
            text:
              `Sub-agent "${running.name}" was DETACHED: your tool-call wait was aborted (Escape), but the sub-agent ` +
              `itself is STILL RUNNING and was NOT cancelled — no result exists yet, so do not assume or fabricate one. ` +
              `Its real result will be delivered as a steer message when it finishes, exactly once. ` +
              `Do not respawn it. You can still steer it meanwhile (subagent_message) or stop it explicitly (subagent_stop).`,
          }],
          details: {
            id: running.id,
            name: running.name,
            task: running.task,
            agent: running.agent,
            ...(running.cohortId ? { cohortId: running.cohortId } : {}),
            sessionFile: running.sessionFile,
            elapsed: Math.floor((Date.now() - running.startTime) / 1000),
            status: "detached",
          },
        };
      }
      const result: SubagentResult = raced;

      // watcherAbort 到此只可能被 sibling subagent_stop 触发(工具 Escape 不
      // 再转发);此时 watcher 已兑出真实取消终态,走本返回路径。stopped
      // 标志覆盖 mock watcher 直接 resolve 取消终态的场景。
      const userClosed = !!result.userClosed;
      const cancelled = watcherAbort.signal.aborted || userClosed || !!result.stopped;
      const failed = result.exitCode !== 0 || !!result.errorMessage;
      const routeException = cancelled ? undefined : routeExceptionFromResult(result, running.model);
      // 硬屏障终态(成功/失败/取消/handed-off)落定完成记录:同一消息或后续
      // turn 的 dependsOn 消费者都以此为等待源头;用户关闭 pane 按取消 settle。
      settleCompletionFromResult(running.name, result, {
        ...(cancelled ? { status: "cancelled" as const } : {}),
      });
      // ── 会话保留(retention)──在结果提取(watcher 内)、依赖 settle(上段)、
      // runtime record 清理(watcher 内)全部完成之后才删除工件;删除失败只
      // debug,绝不覆盖已取得的子代理结果。pane/演示与 handed-off 恒保留。
      const retentionPolicy = params.retention ?? "auto";
      const retentionDetails = applyRetentionToRunning(running, retentionPolicy, {
        cancelled,
        failed,
        handedOff: !!result.handedOff,
      });
      if (result.handedOff) {
        // /reload 移交:显式 handed-off 语义,不报 cancelled/failed;
        // 真实结果由恢复路径在子代理结束后经 steer 消息回注。
        return {
          content: [{
            type: "text",
            text:
              `Sub-agent "${running.name}" was handed off to recovery because the host was reloaded (/reload). ` +
              `It is still running; its real result will be delivered as a steer message when it finishes. ` +
              `Do not treat this as a failure and do not spawn a replacement.`,
          }],
          details: {
            id: running.id,
            name: running.name,
            task: running.task,
            agent: running.agent,
            ...(running.cohortId ? { cohortId: running.cohortId } : {}),
            sessionFile: result.sessionFile,
            elapsed: result.elapsed,
            status: "handed-off",
            retention: retentionDetails,
          },
        };
      }
      return {
        content: [{
          type: "text",
          text: userClosed
            ? `Sub-agent "${running.name}" was closed by the user: its pane is gone and no result was produced. ` +
              `This is not a provider or agent error. Its session is preserved; resume it with ` +
              `subagent_message({ name: "${running.name}", message: "…" }) if the task still matters.`
            : cancelled
            ? retentionDetails.outcome === "cleaned"
              ? `Sub-agent "${running.name}" was stopped before finishing — no result was produced. ` +
                `Its session artifacts were cleaned up (retention: ${retentionPolicy}).`
              : `Sub-agent "${running.name}" was stopped before finishing — no result was produced. ` +
                `Its session is preserved; resume it with subagent_message({ name: "${running.name}", message: "…" }) if needed.`
            : deps.resolveResultPresentation(result, running.name, {
              sessionPreserved: retentionDetails.outcome !== "cleaned",
            }),
        }],
        details: {
          id: running.id,
          name: running.name,
          task: running.task,
          agent: running.agent,
          ...(running.cohortId ? { cohortId: running.cohortId } : {}),
          sessionFile: result.sessionFile,
          exitCode: result.exitCode,
          elapsed: result.elapsed,
          status: userClosed ? "user_closed" : cancelled ? "cancelled" : failed ? "failed" : "completed",
          retention: retentionDetails,
          ...(userClosed ? { userClosed: true } : {}),
          ...(result.sessionId ? { sessionId: result.sessionId } : {}),
          ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
          ...(result.stats ? { stats: result.stats } : {}),
          ...(routeException ? { routeException } : {}),
        },
      };
    },

    renderCall(args, theme) {
      const partialArgs = args as Record<string, unknown>;
      const agentName = typeof partialArgs.agent === "string" && partialArgs.agent ? partialArgs.agent : "";
      const name = typeof partialArgs.name === "string" && partialArgs.name ? partialArgs.name : agentName || "(unnamed)";
      const task = typeof partialArgs.task === "string" ? partialArgs.task : "";
      const agent = agentName && name !== agentName ? theme.fg("dim", ` (${agentName})`) : "";
      const cwdHint = typeof partialArgs.cwd === "string" && partialArgs.cwd ? theme.fg("dim", ` in ${partialArgs.cwd}`) : "";
      let text = "○ " + theme.fg("toolTitle", theme.bold(name)) + agent + cwdHint;
      if (task) {
        const firstLine = task.split("\n").find((line: string) => line.trim()) ?? "";
        const preview = firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
        if (preview) text += "\n" + theme.fg("toolOutput", preview);
        const totalLines = task.split("\n").length;
        if (totalLines > 1) text += theme.fg("muted", ` (${totalLines} lines)`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, _opts, theme) {
      const details = result.details as any;
      const name = details?.name ?? "(unnamed)";
      if (details?.status === "started") {
        return new Text(
          theme.fg("accent", "⟳") + " " + theme.fg("toolTitle", theme.bold(name)) + theme.fg("dim", " — started"),
          0,
          0,
        );
      }
      // 持久成员启动:立即 ack,首轮结果稍后经轮次回注送达。
      if (details?.status === "member-started") {
        return new Text(
          theme.fg("accent", "◆") + " " + theme.fg("toolTitle", theme.bold(name)) +
            theme.fg("accent", " — team member · round 1 running"),
          0,
          0,
        );
      }
      // /reload 移交:非终态,真实结果稍后由恢复路径回注。
      if (details?.status === "handed-off") {
        return new Text(
          theme.fg("accent", "⏳") + " " +
            theme.fg("toolTitle", theme.bold(name)) +
            theme.fg("dim", " — handed off after reload"),
          0,
          0,
        );
      }
      // Escape 中止等待:非终态,子代理仍在运行,真实结果稍后迟到回注。
      if (details?.status === "detached") {
        return new Text(
          theme.fg("accent", "⇄") + " " +
            theme.fg("toolTitle", theme.bold(name)) +
            theme.fg("dim", " — detached (still running; late result to follow)"),
          0,
          0,
        );
      }
      // 用户直接关闭 pane:稳定分类,不是 provider/agent 错误。
      if (details?.status === "user_closed") {
        return new Text(
          theme.fg("warning", "✕") + " " +
            theme.fg("toolTitle", theme.bold(name)) +
            theme.fg("warning", " — closed by user"),
          0,
          0,
        );
      }
      // 等待超时:非终态,子代理仍在运行,真实结果稍后迟到回注。
      if (details?.status === "timed-out") {
        const bound = typeof details.timeoutMs === "number" ? ` after ${Math.round(details.timeoutMs / 1000)}s` : "";
        return new Text(
          theme.fg("warning", "⏱") + " " +
            theme.fg("toolTitle", theme.bold(name)) +
            theme.fg("warning", ` — timed out${bound} (still running; late result to follow)`),
          0,
          0,
        );
      }
      // 硬屏障终态:自动子代理的结果直接作为 tool result 返回,按状态渲染。
      if (details?.status === "completed" || details?.status === "failed" || details?.status === "cancelled") {
        const elapsed = typeof details.elapsed === "number" ? ` · ${details.elapsed}s` : "";
        const reason =
          details.status === "completed"
            ? theme.fg("dim", `completed${elapsed}`)
            : details.status === "cancelled"
              ? theme.fg("warning", `cancelled${elapsed}`)
              : theme.fg("error", `failed${elapsed}`);
        const icon = details.status === "completed" ? theme.fg("success", "✓") : theme.fg("error", "✗");
        return new Text(icon + " " + theme.fg("toolTitle", theme.bold(name)) + " " + reason, 0, 0);
      }
      const content = result.content[0];
      const text = content && content.type === "text" ? content.text : "";
      return new Text(theme.fg("dim", text), 0, 0);
    },
  });
}
