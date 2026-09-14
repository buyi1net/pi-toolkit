import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { debugLog } from "./diagnostics.ts";

export type SubagentActivityPhase = "starting" | "active" | "waiting" | "done";
export type SubagentActivityScope = "agent" | "turn" | "provider" | "streaming" | "tool";

export type SubagentActivityEvent =
  | "session_start"
  | "input"
  | "before_agent_start"
  | "agent_start"
  | "agent_end"
  | "turn_start"
  | "turn_end"
  | "before_provider_request"
  | "after_provider_response"
  | "message_update"
  | "tool_execution_start"
  | "tool_call"
  | "tool_execution_update"
  | "tool_result"
  | "tool_execution_end"
  | "ask_question"
  | "session_shutdown";

export interface SubagentActivityState {
  version: 1;
  runningChildId: string;
  createdAt: number;
  updatedAt: number;
  sequence: number;
  latestEvent: SubagentActivityEvent;
  phase: SubagentActivityPhase;
  agentActive: boolean;
  turnActive: boolean;
  providerActive: boolean;
  toolActive: boolean;
  activeScope?: SubagentActivityScope;
  activeSince?: number;
  waitingSince?: number;
  turnIndex?: number;
  messageEventType?: string;
  toolCallId?: string;
  toolName?: string;
  toolStartedAt?: number;
  toolEndedAt?: number;
  /**
   * 工单 45：写侧停写原因标记（可见性）——写侧放弃写盘时尽力写入的原因码
   * （如 write-failed-ENOSPC），父侧读快照即可看见「停写」这件事；正常路径缺省。
   */
  writerStoppedReason?: string;
}

export type ActivityReadResult =
  | { ok: true; activity: SubagentActivityState }
  | { ok: false; reason: "missing" | "invalid" | "wrong-id"; error?: string };

export type SubagentShutdownReason = "quit" | "reload" | "new" | "resume" | "fork";

export interface SubagentActivityRecorder {
  sessionStart(): void;
  input(): void;
  beforeAgentStart(): void;
  agentStart(): void;
  agentEndWaiting(): void;
  agentEndDone(): void;
  turnStart(turnIndex?: number): void;
  turnEnd(turnIndex?: number): void;
  beforeProviderRequest(): void;
  afterProviderResponse(): void;
  messageUpdate(messageEventType?: string): void;
  toolExecutionStart(toolCallId?: string, toolName?: string): void;
  toolCall(toolCallId?: string, toolName?: string): void;
  toolExecutionUpdate(toolCallId?: string, toolName?: string): void;
  toolResult(toolCallId?: string, toolName?: string): void;
  toolExecutionEnd(toolCallId?: string, toolName?: string): void;
  askQuestion(): void;
  sessionShutdown(reason: SubagentShutdownReason): void;
  /** 工单 45：满掉待写定时器并停写（测试夹具与宿主关停用；终态保底仍可再写一次）。 */
  dispose(): void;
}

const ACTIVITY_UPDATE_THROTTLE_MS = 500;
// ── 写失败处理（工单 45：实验 A/B 结论）──────────────────────────
// 旧口径「连续 3 次写失败即永久自禁用」有两个买案：实验 B1 实测外部持锁
// （杀软/索引/同步）毫秒内就能耗尽 3 次上限，瞬发永久停写；实验 A/B3 实测
// 自禁用后连终态都写不进，且全程零日志零标记。新口径：
//   - 失败后退避降频（500ms 起倍增，封顶 30s），只有非持锁类错误持续失败
//     满 ACTIVITY_WRITE_GIVEUP_AFTER_MS 才停写；
//   - EPERM/EBUSY/EACCES（外部持锁/共享冲突/AV 扫描）退避重试，永不计入停写；
//   - ENOSPC/EROFS（磁盘满/只读）走时间窗放弃，但停写必须可见；
//   - ENOTDIR/ENOENT（目录被破坏）重建目录后立即重试；
//   - 终态事件（agent_end done / session_shutdown quit）绕过停写与退避再试一次。
const WRITE_BACKOFF_INITIAL_MS = 500;
const WRITE_BACKOFF_MAX_MS = 30_000;
/** 非外部持锁类错误持续失败多久才允许停写（时间维度：瞬发失败不允许永久自禁用）。 */
export const ACTIVITY_WRITE_GIVEUP_AFTER_MS = 10 * 60_000;
/** 外部持锁类错误码：退避重试但不计入停写（实验 B1/B2 实测错误码）。 */
const LOCK_RETRYABLE_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
/** 目录被破坏类错误码：重建目录后立即重试（实验 B5）。 */
const REBUILD_DIR_CODES = new Set(["ENOTDIR", "ENOENT"]);
const KNOWN_PHASES = new Set<SubagentActivityPhase>(["starting", "active", "waiting", "done"]);
const KNOWN_SCOPES = new Set<SubagentActivityScope>(["agent", "turn", "provider", "streaming", "tool"]);
const KNOWN_EVENTS = new Set<SubagentActivityEvent>([
  "session_start",
  "input",
  "before_agent_start",
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "before_provider_request",
  "after_provider_response",
  "message_update",
  "tool_execution_start",
  "tool_call",
  "tool_execution_update",
  "tool_result",
  "tool_execution_end",
  "ask_question",
  "session_shutdown",
]);
const MAX_ACTIVITY_STRING_LENGTH = 200;

export function getSubagentActivityFile(artifactDir: string, runningChildId: string): string {
  return join(artifactDir, "subagent-activity", `${runningChildId}.json`);
}

/**
 * 活动快照声明终态（phase=done）后，给进程刷盘与正常退出留的兜底窗口。
 * 超过窗口仍观察到该状态（尤其记录里的 PID 仍存活时），即可作为控制面
 * 自己的完成声明消费（状态回收，工单 30）。
 */
export const TERMINAL_ACTIVITY_GRACE_MS = 15_000;

/**
 * 活动快照是否已声明终态且超出兜底窗口。done 由子代理 agent_end 自动
 * 退出路径（或 session_shutdown quit）写入并随即冻结——recorder 停写，
 * 快照不会再变。窗口只防「刚写 done 还在刷盘/退出中」的竞态，不用于
 * 判活；缺失/未终态的快照一律返回 false（保守，不推测）。
 */
export function isTerminalDoneActivity(
  activity: SubagentActivityState | undefined,
  now: number = Date.now(),
): boolean {
  return activity?.phase === "done" && now - activity.updatedAt >= TERMINAL_ACTIVITY_GRACE_MS;
}

function requireObject(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function validateFiniteNumber(object: Record<string, unknown>, fieldName: string): string | null {
  return Number.isFinite(object[fieldName]) ? null : `${fieldName} must be finite`;
}

function validateOptionalFiniteNumber(object: Record<string, unknown>, fieldName: string): string | null {
  const value = object[fieldName];
  return value == null || Number.isFinite(value) ? null : `${fieldName} must be finite when present`;
}

function validateInteger(object: Record<string, unknown>, fieldName: string): string | null {
  return Number.isInteger(object[fieldName]) ? null : `${fieldName} must be an integer`;
}

function validateOptionalInteger(object: Record<string, unknown>, fieldName: string): string | null {
  const value = object[fieldName];
  return value == null || Number.isInteger(value) ? null : `${fieldName} must be an integer when present`;
}

function validateBoolean(object: Record<string, unknown>, fieldName: string): string | null {
  return typeof object[fieldName] === "boolean" ? null : `${fieldName} must be a boolean`;
}

function validateOptionalActivityString(object: Record<string, unknown>, fieldName: string): string | null {
  const value = object[fieldName];
  if (value == null) return null;
  if (typeof value !== "string") return `${fieldName} must be a string when present`;
  if (/\r|\n/.test(value)) return `${fieldName} must not contain newlines`;
  return value.length <= MAX_ACTIVITY_STRING_LENGTH ? null : `${fieldName} is too long`;
}

function invalidActivity(error: string): ActivityReadResult {
  return { ok: false, reason: "invalid", error };
}

function validateActivity(value: unknown, expectedRunningChildId: string): ActivityReadResult {
  const object = requireObject(value);
  if (!object) return invalidActivity("activity must be an object");
  if (object.version !== 1) return invalidActivity("unsupported activity version");
  if (typeof object.runningChildId !== "string") return invalidActivity("runningChildId must be a string");
  if (object.runningChildId !== expectedRunningChildId) return { ok: false, reason: "wrong-id" };
  if (typeof object.latestEvent !== "string" || !KNOWN_EVENTS.has(object.latestEvent as SubagentActivityEvent)) {
    return invalidActivity("unknown latestEvent");
  }
  if (typeof object.phase !== "string" || !KNOWN_PHASES.has(object.phase as SubagentActivityPhase)) {
    return invalidActivity("unknown activity phase");
  }
  if (
    object.activeScope != null &&
    (typeof object.activeScope !== "string" || !KNOWN_SCOPES.has(object.activeScope as SubagentActivityScope))
  ) {
    return invalidActivity("unknown activeScope");
  }

  const validationError = [
    validateFiniteNumber(object, "createdAt"),
    validateFiniteNumber(object, "updatedAt"),
    validateInteger(object, "sequence"),
    validateBoolean(object, "agentActive"),
    validateBoolean(object, "turnActive"),
    validateBoolean(object, "providerActive"),
    validateBoolean(object, "toolActive"),
    validateOptionalFiniteNumber(object, "activeSince"),
    validateOptionalFiniteNumber(object, "waitingSince"),
    validateOptionalInteger(object, "turnIndex"),
    validateOptionalFiniteNumber(object, "toolStartedAt"),
    validateOptionalFiniteNumber(object, "toolEndedAt"),
    validateOptionalActivityString(object, "messageEventType"),
    validateOptionalActivityString(object, "toolCallId"),
    validateOptionalActivityString(object, "toolName"),
    validateOptionalActivityString(object, "writerStoppedReason"),
  ].find((error) => error != null);
  if (validationError) return invalidActivity(validationError);

  return { ok: true, activity: object as unknown as SubagentActivityState };
}

/**
 * 活动快照 → 状态行 activityLabel（observeStatus 的展示口径，供 widget 与
 * 后代快照共用）：活跃期的展示名按最内层 scope 取，工具调用显示工具名。
 */
export function activityDisplayLabel(activity: SubagentActivityState): string | undefined {
  if (activity.phase !== "active") return undefined;
  if (activity.activeScope === "tool") return activity.toolName ?? "tool";
  if (activity.activeScope === "provider") return "provider";
  if (activity.activeScope === "streaming") return "streaming";
  return activity.activeScope;
}

export function readSubagentActivityFile(
  activityFile: string,
  expectedRunningChildId: string,
): ActivityReadResult {
  if (!existsSync(activityFile)) return { ok: false, reason: "missing" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(activityFile, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: "invalid", error: message };
  }

  return validateActivity(parsed, expectedRunningChildId);
}

/** 测试注入用的底层写原语（默认 node:fs 同名函数）。 */
export interface ActivityFileIo {
  writeFileSync: typeof writeFileSync;
  renameSync: typeof renameSync;
  unlinkSync: typeof unlinkSync;
}

const NODE_ACTIVITY_IO: ActivityFileIo = { writeFileSync, renameSync, unlinkSync };

export function writeSubagentActivityFile(
  activityFile: string,
  activity: SubagentActivityState,
  io: ActivityFileIo = NODE_ACTIVITY_IO,
): void {
  const dir = dirname(activityFile);
  mkdirSync(dir, { recursive: true });
  // rename 失败兑底（工单 45 实验 B4）：Windows 紧循环读下 rename 偶发 EPERM
  // （4/4528），不许一路失败到停写——先换一个 tmp 名重试，仍失败则就地写
  // （读侧对半行 JSON 有 invalid 容错，下一次成功写会覆盖）。
  const tempNames = [
    `${activity.runningChildId}.json.${process.pid}.${activity.sequence}.tmp`,
    `${activity.runningChildId}.json.${process.pid}.${activity.sequence}.retry.tmp`,
  ];
  let lastError: unknown;
  for (const tempName of tempNames) {
    const tempFile = join(dir, tempName);
    try {
      io.writeFileSync(tempFile, `${JSON.stringify(activity)}\n`, "utf8");
      io.renameSync(tempFile, activityFile);
      return;
    } catch (error) {
      lastError = error;
      try {
        io.unlinkSync(tempFile);
      } catch {
        // Temp cleanup is best effort; preserve the original write/rename failure
      }
    }
  }
  try {
    io.writeFileSync(activityFile, `${JSON.stringify(activity)}\n`, "utf8");
    return;
  } catch (error) {
    lastError = error;
  }
  throw lastError;
}

function createNoopRecorder(): SubagentActivityRecorder {
  const noop = () => {};
  return {
    sessionStart: noop,
    input: noop,
    beforeAgentStart: noop,
    agentStart: noop,
    agentEndWaiting: noop,
    agentEndDone: noop,
    turnStart: noop,
    turnEnd: noop,
    beforeProviderRequest: noop,
    afterProviderResponse: noop,
    messageUpdate: noop,
    toolExecutionStart: noop,
    toolCall: noop,
    toolExecutionUpdate: noop,
    toolResult: noop,
    toolExecutionEnd: noop,
    askQuestion: noop,
    sessionShutdown: noop,
    dispose: noop,
  };
}

function clearActiveState(activity: SubagentActivityState): void {
  activity.agentActive = false;
  activity.turnActive = false;
  activity.providerActive = false;
  activity.toolActive = false;
  delete activity.activeScope;
  delete activity.activeSince;
}

function refreshActiveScope(activity: SubagentActivityState): void {
  if (activity.toolActive) {
    activity.phase = "active";
    activity.activeScope = "tool";
    return;
  }
  if (activity.providerActive) {
    activity.phase = "active";
    activity.activeScope = "provider";
    return;
  }
  if (activity.turnActive) {
    activity.phase = "active";
    activity.activeScope = "turn";
    return;
  }
  if (activity.agentActive) {
    activity.phase = "active";
    activity.activeScope = "agent";
    return;
  }
  delete activity.activeScope;
  delete activity.activeSince;
}

function markActive(
  activity: SubagentActivityState,
  scope: SubagentActivityScope,
  now: number,
  resetActiveSince = false,
): void {
  activity.phase = "active";
  activity.activeScope = scope;
  if (activity.activeSince == null || resetActiveSince) activity.activeSince = now;
  delete activity.waitingSince;
}

export function createSubagentActivityRecorder(params: {
  runningChildId?: string;
  activityFile?: string;
  now?: () => number;
  /** 测试注入的写实现（默认 tmp+rename 的 writeSubagentActivityFile）。 */
  writeActivityFile?: (activityFile: string, activity: SubagentActivityState) => void;
}): SubagentActivityRecorder {
  const runningChildId = params.runningChildId?.trim();
  const activityFile = params.activityFile?.trim();
  if (!runningChildId || !activityFile) return createNoopRecorder();

  const now = params.now ?? (() => Date.now());
  const write = params.writeActivityFile
    ?? ((file: string, state: SubagentActivityState) => writeSubagentActivityFile(file, state));
  // 守卫后的非可选别名：上面函数声明会被提升，narrowing 不进嵌套函数。
  const activityFilePath: string = activityFile;
  const createdAt = now();
  const activity: SubagentActivityState = {
    version: 1,
    runningChildId,
    createdAt,
    updatedAt: createdAt,
    sequence: 0,
    latestEvent: "session_start",
    phase: "starting",
    agentActive: false,
    turnActive: false,
    providerActive: false,
    toolActive: false,
  };

  let stopped = false;
  let failureWindowStart: number | null = null;
  let failureCount = 0;
  /** 下次允许尝试写入的时刻（退避降频）；null = 无退避。 */
  let nextRetryAt: number | null = null;
  let lastFlushAt = 0;
  let pendingFlush: ReturnType<typeof setTimeout> | null = null;

  function clearPendingFlush(): void {
    if (!pendingFlush) return;
    clearTimeout(pendingFlush);
    pendingFlush = null;
  }

  function scheduleFlushIn(delayMs: number): void {
    if (pendingFlush || stopped) return;
    pendingFlush = setTimeout(() => {
      pendingFlush = null;
      flushNow();
    }, delayMs);
  }

  /** 停写（不再写普通事件）；markSnapshot=true 时尽力把停写标记写进快照。 */
  function stopWriting(reason: string, markSnapshot: boolean): void {
    if (stopped) return;
    stopped = true;
    clearPendingFlush();
    // 停写不静默（工单 45 实验 A）：至少落 debug 日志。
    debugLog(`activity recorder stopped writing (${reason}) for ${runningChildId}`);
    if (!markSnapshot) return;
    // 快照里留可见标记（父侧读快照即知停写）；尽力写一次，失败也只有日志。
    activity.writerStoppedReason = reason;
    activity.updatedAt = now();
    activity.sequence += 1;
    flushNow(true);
  }

  function tryWriteOnce(): unknown {
    try {
      write(activityFilePath, activity);
      return null;
    } catch (error) {
      return error;
    }
  }

  function writeSucceeded(): void {
    lastFlushAt = now();
    failureWindowStart = null;
    failureCount = 0;
    nextRetryAt = null;
  }

  function handleWriteFailure(error: unknown): void {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    // 目录被破坏（ENOTDIR/ENOENT）：重建目录后立即重试一次，不进退避。
    if (typeof code === "string" && REBUILD_DIR_CODES.has(code)) {
      try {
        mkdirSync(dirname(activityFilePath), { recursive: true });
        if (tryWriteOnce() == null) {
          writeSucceeded();
          return;
        }
      } catch (rebuildError) {
        debugLog(`activity: directory rebuild failed for ${runningChildId}`, rebuildError);
      }
    }

    failureCount += 1;
    failureWindowStart ??= now();
    const backoffMs = Math.min(
      WRITE_BACKOFF_MAX_MS,
      WRITE_BACKOFF_INITIAL_MS * 2 ** Math.min(failureCount - 1, 6),
    );
    nextRetryAt = now() + backoffMs;
    // 退避到期自动重写内存中的最新状态（没有新事件也会补写）。
    scheduleFlushIn(backoffMs);
    debugLog(`activity write failed (${code ?? "unknown"}) for ${runningChildId}; retry in ${backoffMs}ms`);

    if (typeof code === "string" && LOCK_RETRYABLE_CODES.has(code)) return;
    if (now() - failureWindowStart < ACTIVITY_WRITE_GIVEUP_AFTER_MS) return;
    // 非持锁类错误（ENOSPC/EROFS/未知）持续满时间窗才停写，且必须可见。
    stopWriting(`write-failed-${code ?? "unknown"}`, true);
  }

  function flushNow(force = false): void {
    if (stopped && !force) return;
    if (!force && nextRetryAt != null && now() < nextRetryAt) {
      scheduleFlushIn(nextRetryAt - now());
      return;
    }
    const error = tryWriteOnce();
    if (error == null) {
      writeSucceeded();
      return;
    }
    handleWriteFailure(error);
  }

  function scheduleFlush(): void {
    if (stopped || pendingFlush) return;

    const remainingMs = Math.max(0, ACTIVITY_UPDATE_THROTTLE_MS - (now() - lastFlushAt));
    if (remainingMs === 0) {
      flushNow();
      return;
    }

    scheduleFlushIn(remainingMs);
  }

  function record(
    latestEvent: SubagentActivityEvent,
    update: (current: SubagentActivityState, now: number) => void,
    flush: "immediate" | "throttled",
  ): void {
    if (stopped) return;
    if (flush === "immediate") clearPendingFlush();

    const observedAt = now();
    activity.latestEvent = latestEvent;
    activity.updatedAt = observedAt;
    activity.sequence += 1;
    update(activity, observedAt);

    if (flush === "immediate") flushNow();
    else scheduleFlush();
  }

  function markDone(latestEvent: SubagentActivityEvent): void {
    // 终态保底（工单 45 实验 A/B3）：停写与退避都不拦终态——父侧回收与结果
    // 提取锚定 phase=done，写侧降级绝不能丢；失败也只有这一次，不循环重试。
    clearPendingFlush();
    const observedAt = now();
    activity.latestEvent = latestEvent;
    activity.updatedAt = observedAt;
    activity.sequence += 1;
    activity.phase = "done";
    clearActiveState(activity);
    delete activity.waitingSince;
    flushNow(true);
    stopWriting("done", false);
  }

  return {
    sessionStart() {
      record("session_start", (current) => {
        current.phase = "starting";
        clearActiveState(current);
        delete current.waitingSince;
      }, "immediate");
    },
    input() {
      record("input", () => {}, "immediate");
    },
    beforeAgentStart() {
      record("before_agent_start", (current, observedAt) => {
        current.agentActive = true;
        markActive(current, "agent", observedAt);
      }, "immediate");
    },
    agentStart() {
      record("agent_start", (current, observedAt) => {
        current.agentActive = true;
        markActive(current, "agent", observedAt);
      }, "immediate");
    },
    agentEndWaiting() {
      record("agent_end", (current, observedAt) => {
        clearActiveState(current);
        current.phase = "waiting";
        current.waitingSince = observedAt;
      }, "immediate");
    },
    agentEndDone() {
      markDone("agent_end");
    },
    turnStart(turnIndex) {
      record("turn_start", (current, observedAt) => {
        current.agentActive = true;
        current.turnActive = true;
        if (turnIndex != null) current.turnIndex = turnIndex;
        markActive(current, current.toolActive || current.providerActive ? current.activeScope ?? "turn" : "turn", observedAt);
      }, "immediate");
    },
    turnEnd(turnIndex) {
      record("turn_end", (current) => {
        current.turnActive = false;
        current.providerActive = false;
        current.toolActive = false;
        if (turnIndex != null) current.turnIndex = turnIndex;
        refreshActiveScope(current);
      }, "immediate");
    },
    beforeProviderRequest() {
      record("before_provider_request", (current, observedAt) => {
        current.providerActive = true;
        markActive(current, "provider", observedAt, true);
      }, "immediate");
    },
    afterProviderResponse() {
      record("after_provider_response", (current) => {
        current.providerActive = false;
        refreshActiveScope(current);
      }, "immediate");
    },
    messageUpdate(messageEventType) {
      record("message_update", (current, observedAt) => {
        current.agentActive = true;
        current.turnActive = true;
        current.messageEventType = messageEventType;
        if (!current.toolActive) markActive(current, "streaming", observedAt);
      }, "throttled");
    },
    toolExecutionStart(toolCallId, toolName) {
      record("tool_execution_start", (current, observedAt) => {
        current.toolActive = true;
        current.toolCallId = toolCallId;
        current.toolName = toolName;
        current.toolStartedAt = observedAt;
        markActive(current, "tool", observedAt, true);
      }, "immediate");
    },
    toolCall(toolCallId, toolName) {
      record("tool_call", (current, observedAt) => {
        current.toolActive = true;
        current.toolCallId = toolCallId ?? current.toolCallId;
        current.toolName = toolName ?? current.toolName;
        markActive(current, "tool", observedAt);
      }, "immediate");
    },
    toolExecutionUpdate(toolCallId, toolName) {
      record("tool_execution_update", (current, observedAt) => {
        current.toolActive = true;
        current.toolCallId = toolCallId ?? current.toolCallId;
        current.toolName = toolName ?? current.toolName;
        markActive(current, "tool", observedAt);
      }, "throttled");
    },
    toolResult(toolCallId, toolName) {
      record("tool_result", (current) => {
        current.toolCallId = toolCallId ?? current.toolCallId;
        current.toolName = toolName ?? current.toolName;
        refreshActiveScope(current);
      }, "immediate");
    },
    toolExecutionEnd(toolCallId, toolName) {
      record("tool_execution_end", (current, observedAt) => {
        current.toolActive = false;
        current.toolCallId = toolCallId ?? current.toolCallId;
        current.toolName = toolName ?? current.toolName;
        current.toolEndedAt = observedAt;
        refreshActiveScope(current);
      }, "immediate");
    },
    askQuestion() {
      // The subagent paused to ask the orchestrator a question. Park it in the
      // "waiting" phase (do NOT disable the recorder) so the status widget shows
      // it as waiting and recording resumes when the answer arrives.
      record("ask_question", (current, observedAt) => {
        clearActiveState(current);
        current.phase = "waiting";
        current.waitingSince = observedAt;
      }, "immediate");
    },
    sessionShutdown(reason) {
      if (reason === "quit") markDone("session_shutdown");
      // 非 quit 关停（reload/new/resume/fork）是计划内移交，不是写侧故障：
      // 冻结在最后状态即可，不写停写标记。
      else stopWriting(`shutdown-${reason}`, false);
    },
    dispose() {
      stopped = true;
      clearPendingFlush();
    },
  };
}
