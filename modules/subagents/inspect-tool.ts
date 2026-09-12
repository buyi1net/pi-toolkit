import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { existsSync, readFileSync } from "node:fs";
import { parseHeadlessSurface, type HeadlessChild } from "./headless.ts";
import {
  getSubagentActivityFile,
  readSubagentActivityFile,
  type ActivityReadResult,
  type SubagentActivityState,
} from "./activity.ts";
import {
  classifyStatus,
  createStatusState,
  observeStatus,
  type StatusSnapshot,
  type SubagentStatusState,
} from "./status.ts";
import {
  type NameRegistry,
  type NameRegistryEntry,
  type SubagentLoadout,
} from "./session.ts";
import { normalizeSubagentName as normalizeName } from "./names.ts";
import { peekExitSidecar } from "./surface.ts";
import type { RuntimeRecord, RuntimeRegistry } from "./registry.ts";
import type { RunningSubagent, SubagentWaitMode, SubagentWaitRelease } from "./types.ts";

/** 只读状态观测的来源。runtime-registry 是 /reload 后尚未恢复的磁盘记录。 */
export type SubagentInspectionSource = "live" | "runtime-registry" | "session-registry";

export type SubagentInspectionLifecycle =
  | "launching"
  | "running"
  | "waiting"
  | "stalled"
  | "exited"
  | "offline"
  | "finished"
  | "discarded";

export type SubagentInspectionTimeoutState = "not-configured" | "pending" | "expired";

export interface SubagentInspection {
  name: string;
  id: string | null;
  cohortId: string | null;
  agent: string | null;
  task: string | null;
  model: string | null;
  thinking: string | null;
  tier: string | null;
  source: SubagentInspectionSource;
  lifecycle: SubagentInspectionLifecycle;
  /** activity sidecar 中的原始阶段;没有快照时为 null。 */
  phase: "starting" | "active" | "waiting" | "done" | null;
  /** status.ts 根据快照计算出的即时状态;已结束的历史记录为 null。 */
  status: "starting" | "active" | "waiting" | "stalled" | "running" | null;
  statusLabel: string | null;
  surface: string | null;
  surfaceKind: "headless" | "pane" | null;
  pid: number | null;
  processAlive: boolean | null;
  surfaceAlive: boolean | null;
  processExitCode: number | null;
  processExitSignal: string | null;
  startTime: number | null;
  elapsedMs: number | null;
  lastActivityAt: number | null;
  lastActivityAgeMs: number | null;
  activeScope: string | null;
  activeSince: number | null;
  activeDurationMs: number | null;
  waitingSince: number | null;
  waitingDurationMs: number | null;
  latestEvent: string | null;
  activitySnapshot: "present" | "missing" | "invalid" | "wrong-id" | "unavailable";
  activityError: string | null;
  waitingReason: string | null;
  waitingQuestion?: string;
  member: boolean;
  memberRound: "idle" | "dispatched" | null;
  rosterStatus: "idle" | "dispatched" | "offline" | null;
  rosterReason: string | null;
  parentId: string | null;
  childCount: number;
  childNames: string[];
  waitMode: SubagentWaitMode | null;
  waitReleased: SubagentWaitRelease | null;
  timeoutMs: number | null;
  timeoutAt: number | null;
  timeoutState: SubagentInspectionTimeoutState;
  stdinLost: boolean;
  sessionFile: string | null;
  sessionFileExists: boolean;
  loadoutExists: boolean;
  resumable: boolean;
  canSteer: boolean;
  canResume: boolean;
  controlReason: string | null;
  exitCode: number | null;
  exitError: string | null;
  observedAt: number;
}

export interface InspectRosterMember {
  status: "idle" | "dispatched" | "offline";
  offlineReason?: string;
  dispatchedAt?: number;
  lastRoundAt?: number;
}

export interface SubagentInspectDeps {
  /** 运行态登记表：实时态、内存优先的磁盘记录视图都从它取。 */
  registry: RuntimeRegistry;
  /** 读取并刷新当前进程持有的 activity/status 快照。 */
  observeRunningSubagent: (running: RunningSubagent, observedAt?: number) => void;
  getArtifactDir: (sessionDir: string, sessionId: string) => string;
  readNameRegistry: (artifactDir: string) => NameRegistry;
  readSubagentLoadout: (sessionFile: string) => SubagentLoadout | null;
  isPidAlive: (pid: number) => boolean;
  /** 没有复用器或表面不支持探测时返回 null。 */
  probeSurface?: (surface: string) => boolean | null;
  readRosterMember?: (name: string, artifactDir: string) => InspectRosterMember | null;
}

interface InspectRecord {
  id: string;
  name: string;
  task: string;
  cohortId?: string;
  agent?: string;
  model?: string | null;
  surface: string;
  startTime: number;
  sessionFile: string;
  activityFile?: string;
  interactive: boolean;
  kind?: "pane" | "headless";
  pid?: number;
  parentId?: string | null;
  timeoutMs?: number;
  waitMode?: SubagentWaitMode;
  waitReleased?: SubagentWaitRelease;
  member?: boolean;
  dispatchedRound?: boolean;
  stdinLost?: boolean;
  headlessChild?: HeadlessChild;
}

const MAX_TASK_LENGTH = 1200;
const MAX_QUESTION_LENGTH = 1200;
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function truncate(value: string | null | undefined, maxLength: number): string {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function readPendingQuestion(sessionFile: string): string | null {
  try {
    const raw = readFileSync(`${sessionFile}.ask`, "utf8");
    const parsed = JSON.parse(raw) as { question?: unknown };
    return typeof parsed.question === "string" && parsed.question.trim()
      ? truncate(parsed.question, MAX_QUESTION_LENGTH)
      : null;
  } catch {
    return null;
  }
}

function activityLabel(activity: SubagentActivityState): string | undefined {
  if (activity.phase !== "active") return undefined;
  if (activity.activeScope === "tool") return activity.toolName ?? "tool";
  if (activity.activeScope === "provider") return "provider";
  if (activity.activeScope === "streaming") return "streaming";
  return activity.activeScope;
}

function activityObservation(activity: SubagentActivityState) {
  return {
    snapshot: "present" as const,
    updatedAt: activity.updatedAt,
    sequence: activity.sequence,
    phase: activity.phase,
    active: activity.phase === "active",
    activeScope: activity.activeScope,
    activeSince: activity.activeSince,
    waitingSince: activity.waitingSince,
    latestEvent: activity.latestEvent,
    activityLabel: activityLabel(activity),
  };
}

function freshActivity(
  record: Pick<InspectRecord, "id" | "activityFile">,
): ActivityReadResult {
  if (!record.activityFile) return { ok: false, reason: "missing" };
  return readSubagentActivityFile(record.activityFile, record.id);
}

function statusFromActivity(
  startTime: number,
  read: ActivityReadResult,
  now: number,
): { state: SubagentStatusState; snapshot: StatusSnapshot; activity?: SubagentActivityState } {
  const state = createStatusState({ source: "pi", startTimeMs: startTime });
  const next = observeStatus(
    state,
    read.ok ? activityObservation(read.activity) : { snapshot: read.reason, snapshotError: read.error },
    now,
  );
  return {
    state: next,
    snapshot: classifyStatus(next, now),
    ...(read.ok ? { activity: read.activity } : {}),
  };
}

function resolveThinking(loadout: SubagentLoadout | null, model: string | null): string | null {
  if (loadout?.thinkingOverride) return loadout.thinkingOverride;
  const suffix = model?.match(/:([a-z]+)$/)?.[1];
  if (suffix && THINKING_LEVELS.has(suffix)) return suffix;
  return loadout?.thinking ?? null;
}

function resolveSurfaceKind(record: Pick<InspectRecord, "kind" | "surface">): "headless" | "pane" {
  if (record.kind) return record.kind;
  return record.surface.startsWith("headless:") ? "headless" : "pane";
}

function inspectProcess(
  record: InspectRecord,
  source: SubagentInspectionSource,
  deps: Pick<SubagentInspectDeps, "isPidAlive" | "probeSurface">,
): {
  kind: "headless" | "pane";
  pid: number | null;
  processAlive: boolean | null;
  surfaceAlive: boolean | null;
  exitCode: number | null;
  exitSignal: string | null;
} {
  const kind = resolveSurfaceKind(record);
  if (kind === "headless") {
    const pid = record.pid ?? parseHeadlessSurface(record.surface);
    let processAlive: boolean | null = null;
    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    if (record.headlessChild?.exited) {
      processAlive = false;
    } else if (pid != null) {
      // ChildProcess 的退出事件可能晚于外部终止。这里同时探测 PID，避免
      // 一次性观测在 watcher 下一轮运行前把已死亡的子进程报告为存活。
      processAlive = deps.isPidAlive(pid);
    } else if (source === "live" && record.headlessChild) {
      processAlive = true;
    }
    if (record.headlessChild?.exitInfo) {
      exitCode = record.headlessChild.exitInfo.code;
      exitSignal = record.headlessChild.exitInfo.signal;
    }
    return {
      kind,
      pid,
      processAlive,
      surfaceAlive: null,
      exitCode,
      exitSignal,
    };
  }

  let surfaceAlive: boolean | null = null;
  if (deps.probeSurface) {
    try {
      surfaceAlive = deps.probeSurface(record.surface);
    } catch {
      surfaceAlive = null;
    }
  }
  return {
    kind,
    pid: null,
    processAlive: surfaceAlive,
    surfaceAlive,
    exitCode: null,
    exitSignal: null,
  };
}

function classifyLifecycle(
  source: SubagentInspectionSource,
  status: StatusSnapshot | null,
  processAlive: boolean | null,
  member: boolean,
  rosterStatus: InspectRosterMember["status"] | null,
  sessionFileExists: boolean,
): SubagentInspectionLifecycle {
  if (source === "session-registry") {
    if (!sessionFileExists) return "discarded";
    return member ? "offline" : "finished";
  }
  if (member && rosterStatus === "offline") return "offline";
  if (processAlive === false) return "exited";
  if (status?.kind === "stalled") return "stalled";
  if (status?.kind === "waiting") return "waiting";
  if (status?.kind === "active" || status?.kind === "running") return "running";
  return "launching";
}

function resolveWaitingReason(params: {
  lifecycle: SubagentInspectionLifecycle;
  status: StatusSnapshot | null;
  activity?: SubagentActivityState;
  pendingQuestion: string | null;
  member: boolean;
  memberRound: "idle" | "dispatched" | null;
  stdinLost: boolean;
}): string | null {
  if (params.lifecycle === "exited") return "process_exited_pending_cleanup";
  if (params.lifecycle === "offline") return "member_offline";
  if (params.stdinLost) return "stdin_unavailable_after_reload";
  if (params.pendingQuestion) return "ask_question";
  if (
    params.member &&
    params.memberRound === "idle" &&
    params.status?.kind !== "active" &&
    params.status?.kind !== "running"
  ) return "awaiting_dispatch";
  if (params.status?.kind === "stalled") return "activity_stale";
  if (params.status?.kind === "waiting") {
    if (params.activity?.latestEvent === "ask_question") return "ask_question";
    if (params.activity?.latestEvent === "agent_end") return "agent_waiting";
    return "waiting_for_input";
  }
  if (params.status?.kind === "starting") return "starting";
  return null;
}

function defaultWaitMode(record: InspectRecord, source: SubagentInspectionSource): SubagentWaitMode | null {
  if (record.waitMode) return record.waitMode;
  if (record.member) return "member-round";
  if (record.interactive) return "interactive";
  if (source === "runtime-registry") return "recovered";
  if (source === "live") return "hard-barrier";
  return null;
}

function buildInspection(
  record: InspectRecord,
  source: SubagentInspectionSource,
  params: {
    now: number;
    activityRead: ActivityReadResult;
    activity?: SubagentActivityState;
    status: StatusSnapshot | null;
    statusState?: SubagentStatusState;
    process: ReturnType<typeof inspectProcess>;
    loadout: SubagentLoadout | null;
    roster: InspectRosterMember | null;
    childNames: string[];
  },
): SubagentInspection {
  const { now, activityRead, activity, status, statusState, process, loadout, roster, childNames } = params;
  const sessionFileExists = Boolean(record.sessionFile) && existsSync(record.sessionFile);
  const member = record.member === true || loadout?.member === true;
  const memberRound = member
    ? record.dispatchedRound != null
      ? record.dispatchedRound ? "dispatched" : "idle"
      : roster?.status === "dispatched" ? "dispatched" : "idle"
    : null;
  const rosterStatus = member ? roster?.status ?? null : null;
  const lifecycle = classifyLifecycle(source, status, process.processAlive, member, rosterStatus, sessionFileExists);
  const pendingQuestion = sessionFileExists ? readPendingQuestion(record.sessionFile) : null;
  const lastActivityAt = statusState?.lastActivityAtMs ?? (activity ? activity.updatedAt : null);
  const lastActivityAgeMs = lastActivityAt == null ? null : Math.max(0, now - lastActivityAt);
  const activeSince = status?.activeSinceMs ?? activity?.activeSince ?? null;
  const waitingSince = status?.waitingSinceMs ?? activity?.waitingSince ?? null;
  const timeoutMs = record.timeoutMs ?? null;
  const timeoutAt = timeoutMs == null ? null : record.startTime + timeoutMs;
  const timeoutState: SubagentInspectionTimeoutState = timeoutMs == null
    ? "not-configured"
    : now >= timeoutAt!
      ? "expired"
      : "pending";
  const waitMode = defaultWaitMode(record, source);
  const stdinLost = record.stdinLost === true;
  const trackedLive = source === "live";
  const canSteer = trackedLive && process.processAlive !== false && (
    process.kind === "pane"
      ? process.surfaceAlive !== false
      : !stdinLost && Boolean(record.headlessChild) && !record.headlessChild!.exited
  );
  const canResume = !trackedLive && process.processAlive !== true && sessionFileExists && Boolean(loadout);
  let controlReason: string | null = null;
  if (canSteer) controlReason = null;
  else if (lifecycle === "exited") controlReason = "process_exited";
  else if (stdinLost) controlReason = "host_reload_lost_stdin";
  else if (source === "runtime-registry") controlReason = "not_owned_by_current_host";
  else if (source === "session-registry") controlReason = "not_running";
  else if (process.kind === "pane" && process.surfaceAlive === false) controlReason = "pane_not_found";
  else controlReason = "no_live_control_handle";

  let exitCode = process.exitCode;
  let exitError: string | null = null;
  const sidecar = sessionFileExists ? peekExitSidecar(record.sessionFile) : null;
  if (sidecar) {
    exitCode = sidecar.exitCode;
    exitError = sidecar.errorMessage ?? null;
  }

  const activitySnapshot = source === "session-registry"
    ? "unavailable" as const
    : activityRead.ok
      ? "present" as const
      : activityRead.reason;
  const statusPhase = activity?.phase ?? statusState?.phase ?? null;
  const waitingReason = resolveWaitingReason({
    lifecycle,
    status,
    activity,
    pendingQuestion,
    member,
    memberRound,
    stdinLost,
  });
  const model = loadout?.model ?? record.model ?? null;
  const cohortId = record.cohortId ?? loadout?.cohortId ?? null;

  return {
    name: record.name,
    id: record.id || null,
    cohortId,
    agent: loadout?.agent ?? record.agent ?? null,
    task: truncate(record.task, MAX_TASK_LENGTH) || null,
    model,
    thinking: resolveThinking(loadout, model),
    tier: loadout?.tier ?? null,
    source,
    lifecycle,
    phase: statusPhase,
    status: status?.kind ?? null,
    statusLabel: status?.statusLabel ?? null,
    surface: record.surface || null,
    surfaceKind: source === "session-registry" ? null : process.kind,
    pid: process.pid,
    processAlive: process.processAlive,
    surfaceAlive: process.surfaceAlive,
    processExitCode: process.exitCode,
    processExitSignal: process.exitSignal,
    startTime: record.startTime,
    elapsedMs: Math.max(0, now - record.startTime),
    lastActivityAt,
    lastActivityAgeMs,
    activeScope: status?.activeScope ?? activity?.activeScope ?? null,
    activeSince,
    activeDurationMs: activeSince == null ? null : Math.max(0, now - activeSince),
    waitingSince,
    waitingDurationMs: waitingSince == null ? null : Math.max(0, now - waitingSince),
    latestEvent: status?.latestEvent ?? activity?.latestEvent ?? null,
    activitySnapshot,
    activityError: activityRead.ok ? null : activityRead.error ?? null,
    waitingReason,
    ...(pendingQuestion ? { waitingQuestion: pendingQuestion } : {}),
    member,
    memberRound,
    rosterStatus,
    rosterReason: roster?.offlineReason ?? null,
    parentId: record.parentId ?? null,
    childCount: childNames.length,
    childNames,
    waitMode,
    waitReleased: record.waitReleased ?? null,
    timeoutMs,
    timeoutAt,
    timeoutState,
    stdinLost,
    sessionFile: record.sessionFile || null,
    sessionFileExists,
    loadoutExists: Boolean(loadout),
    resumable: sessionFileExists && Boolean(loadout),
    canSteer,
    canResume,
    controlReason,
    exitCode,
    exitError,
    observedAt: now,
  };
}

function asInspectRecord(record: RunningSubagent | RuntimeRecord): InspectRecord {
  return record as unknown as InspectRecord;
}

/** 构造当前进程直接持有的实时观测。每次调用都会刷新 activity 快照。 */
export function buildLiveSubagentInspection(
  running: RunningSubagent,
  deps: Pick<SubagentInspectDeps, "observeRunningSubagent" | "isPidAlive" | "probeSurface" | "readSubagentLoadout"> & {
    readRosterMember?: SubagentInspectDeps["readRosterMember"];
  },
  childNames: string[] = [],
  now = Date.now(),
): SubagentInspection {
  deps.observeRunningSubagent(running, now);
  const record = asInspectRecord(running);
  const activityRead = freshActivity(record);
  const activity = activityRead.ok ? activityRead.activity : running.activity;
  // 根据刚读到的文件再核对一次状态。生产 observer 通常已经完成这一步，
  // 但让 builder 自包含可以避免调用方传入轻量 observer 时返回旧状态。
  const baseState = running.statusState ?? createStatusState({ source: "pi", startTimeMs: running.startTime });
  const freshState = observeStatus(
    baseState,
    activityRead.ok
      ? activityObservation(activityRead.activity)
      : { snapshot: activityRead.reason, snapshotError: activityRead.error },
    now,
  );
  running.statusState = freshState;
  const status = classifyStatus(freshState, now);
  const process = inspectProcess(record, "live", deps);
  const loadout = deps.readSubagentLoadout(running.sessionFile);
  const roster = deps.readRosterMember?.(running.name, "") ?? null;
  return buildInspection(record, "live", {
    now,
    activityRead,
    activity,
    status,
    statusState: freshState,
    process,
    loadout,
    roster,
    childNames,
  });
}

/** 构造 /reload 后 runtime registry 中尚未被当前模块接管的记录。 */
export function buildRuntimeSubagentInspection(
  record: RuntimeRecord,
  deps: Pick<SubagentInspectDeps, "isPidAlive" | "probeSurface" | "readSubagentLoadout">,
  childNames: string[] = [],
  roster: InspectRosterMember | null = null,
  now = Date.now(),
): SubagentInspection {
  const inspectRecord = asInspectRecord(record);
  const activityRead = freshActivity(inspectRecord);
  const activityStatus = statusFromActivity(record.startTime, activityRead, now);
  const process = inspectProcess(inspectRecord, "runtime-registry", deps);
  const loadout = deps.readSubagentLoadout(record.sessionFile);
  return buildInspection(inspectRecord, "runtime-registry", {
    now,
    activityRead,
    activity: activityStatus.activity,
    status: activityStatus.snapshot,
    statusState: activityStatus.state,
    process,
    loadout,
    roster,
    childNames,
  });
}

/** 构造已完成或已清理的会话注册记录；不会把未知进程状态说成存活。 */
export function buildSessionSubagentInspection(
  name: string,
  entry: NameRegistryEntry,
  deps: Pick<SubagentInspectDeps, "readSubagentLoadout">,
  roster: InspectRosterMember | null = null,
  now = Date.now(),
): SubagentInspection {
  const loadout = deps.readSubagentLoadout(entry.sessionFile);
  const record: InspectRecord = {
    id: "",
    name,
    task: "",
    agent: loadout?.agent ?? undefined,
    model: loadout?.model ?? null,
    surface: "",
    startTime: now,
    sessionFile: entry.sessionFile,
    ...(entry.cohortId ? { cohortId: entry.cohortId } : {}),
    interactive: loadout?.autoExit === false,
    ...(loadout?.member ? { member: true } : {}),
  };
  const activityRead: ActivityReadResult = { ok: false, reason: "missing" };
  return buildInspection(record, "session-registry", {
    now,
    activityRead,
    status: null,
    process: {
      kind: "pane",
      pid: null,
      processAlive: null,
      surfaceAlive: null,
      exitCode: null,
      exitSignal: null,
    },
    loadout,
    roster,
    childNames: [],
  });
}

function formatAge(ageMs: number | null): string {
  if (ageMs == null) return "unknown";
  if (ageMs < 1000) return "<1s ago";
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function formatInspection(view: SubagentInspection): string {
  const status = view.status ? ` status=${view.status}` : "";
  const phase = view.phase ? ` phase=${view.phase}` : "";
  const process = view.pid != null
    ? `pid=${view.pid} ${view.processAlive === true ? "alive" : view.processAlive === false ? "exited" : "unknown"}`
    : view.surfaceKind === "pane"
      ? `pane=${view.surfaceAlive === true ? "alive" : view.surfaceAlive === false ? "gone" : "unknown"}`
      : "process=unknown";
  const activity = view.latestEvent
    ? `event=${view.latestEvent}${view.activeScope ? `/${view.activeScope}` : ""}`
    : `activity=${view.activitySnapshot}`;
  const wait = view.waitingReason ? ` wait=${view.waitingReason}` : "";
  const children = view.childCount > 0 ? ` children=${view.childCount}(${view.childNames.join(",")})` : " children=0";
  const timeout = view.timeoutMs == null ? " timeout=none" : ` timeout=${view.timeoutState}/${view.timeoutMs}ms`;
  const controls = `steer=${view.canSteer ? "yes" : "no"} resume=${view.canResume ? "yes" : "no"}`;
  const model = view.model ? ` model=${view.model}` : "";
  const thinking = view.thinking ? ` thinking=${view.thinking}` : "";
  const cohort = view.cohortId ? ` cohort=${view.cohortId}` : "";
  const task = view.task ? `\n  task: ${view.task}` : "";
  const question = view.waitingQuestion ? `\n  question: ${view.waitingQuestion}` : "";
  return (
    `• ${view.name} [${view.lifecycle}]${status}${phase} elapsed=${Math.floor((view.elapsedMs ?? 0) / 1000)}s ` +
    `${process} last=${formatAge(view.lastActivityAgeMs)} ${activity}${wait}${children}${timeout} ${controls}${model}${thinking}${cohort}` +
    task + question
  );
}

export function registerSubagentInspectTool(pi: ExtensionAPI, deps: SubagentInspectDeps): void {
  pi.registerTool({
    name: "subagent_inspect",
    label: "Inspect Subagents",
    description:
      "Take a fresh, read-only status snapshot of subagents managed by this pi-subagents extension. " +
      "With no name, inspect all currently running/recovering subagents; with name, inspect that session even if it has finished. " +
      "The snapshot includes lifecycle, activity phase/event, last activity age, waiting reason or question, process/PID or pane liveness, " +
      "model/thinking, optional cohortId, child count, timeout state, and steer/resume availability. " +
      "This is an on-demand observation, not a polling loop; do not call it repeatedly just to wait.",
    promptSnippet:
      "Inspect the current subagent status once: lifecycle, phase, last activity, waiting reason, process/PID, children, timeout, and controls.",
    parameters: Type.Object({
      name: Type.Optional(
        Type.String({
          description:
            "Optional exact subagent display name. Omit to inspect all currently running or recovering subagents.",
        }),
      ),
      includeFinished: Type.Optional(
        Type.Boolean({
          description:
            "When name is omitted, also include finished, offline, and discarded session-registry entries.",
        }),
      ),
    }),

    renderCall(args, theme) {
      const name = typeof (args as any)?.name === "string" && (args as any).name.trim()
        ? (args as any).name.trim()
        : "all running";
      return new Text(
        "○ " + theme.fg("toolTitle", theme.bold("inspect ")) + theme.fg("dim", name),
        0,
        0,
      );
    },

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionFile = ctx?.sessionManager?.getSessionFile?.();
      if (!sessionFile) {
        const error =
          "Subagent inspection is unavailable without a persistent parent session. Start pi with a session file first.";
        return { content: [{ type: "text" as const, text: error }], details: { error: "session-unavailable" } };
      }

      const artifactDir = deps.getArtifactDir(
        ctx.sessionManager.getSessionDir(),
        ctx.sessionManager.getSessionId(),
      );
      const now = Date.now();
      const registry = deps.readNameRegistry(artifactDir);
      const runtimePath = deps.registry.pathFor(artifactDir);
      const runtimeRecords = deps.registry.readRecords(runtimePath);
      const requestedName = typeof params?.name === "string"
        ? normalizeName(params.name.trim(), "")
        : "";
      const includeFinished = params?.includeFinished === true;
      const live = deps.registry.list();
      const liveByName = new Map<string, RunningSubagent>();
      for (const running of live) {
        liveByName.set(running.name, running);
      }
      // 内存优先：磁盘记录里名字已被实时运行态占用的条目不再单独展示。
      const runtimeByName = new Map<string, RuntimeRecord>();
      for (const record of deps.registry.inspectableRecords(runtimePath)) {
        runtimeByName.set(record.name, record);
      }
      const rosterFor = (name: string): InspectRosterMember | null =>
        deps.readRosterMember ? deps.readRosterMember(name, artifactDir) : null;
      const childRecords = [
        ...live.map((child) => ({
          id: child.id,
          name: child.name,
          parentId: child.parentId ?? null,
        })),
        ...runtimeRecords.map((record) => ({
          id: record.id,
          name: record.name,
          parentId: record.parentId ?? null,
        })),
      ];
      const childNamesFor = (id: string): string[] => [...new Set(
        childRecords
          .filter((child) => child.parentId === id)
          .map((child) => child.name),
      )].sort((a, b) => a.localeCompare(b));

      const inspectOne = (name: string): SubagentInspection | null => {
        const live = liveByName.get(name);
        if (live) {
          return buildLiveSubagentInspection(
            live,
            {
              observeRunningSubagent: deps.observeRunningSubagent,
              isPidAlive: deps.isPidAlive,
              probeSurface: deps.probeSurface,
              readSubagentLoadout: deps.readSubagentLoadout,
              readRosterMember: (memberName) => rosterFor(memberName),
            },
            childNamesFor(live.id),
            now,
          );
        }
        const runtime = runtimeByName.get(name);
        if (runtime) {
          // 旧 runtime 记录可能没有 activityFile；新路径可由父 artifact
          // 目录和 child id 稳定推导，避免 /reload 后丢失状态观测。
          const runtimeForInspection = runtime.activityFile
            ? runtime
            : { ...runtime, activityFile: getSubagentActivityFile(artifactDir, runtime.id) };
          return buildRuntimeSubagentInspection(
            runtimeForInspection,
            {
              isPidAlive: deps.isPidAlive,
              probeSurface: deps.probeSurface,
              readSubagentLoadout: deps.readSubagentLoadout,
            },
            childNamesFor(runtime.id),
            rosterFor(name),
            now,
          );
        }
        const entry = registry[name];
        if (entry && typeof entry.sessionFile === "string") {
          return buildSessionSubagentInspection(name, entry, deps, rosterFor(name), now);
        }
        return null;
      };

      if (requestedName) {
        const inspection = inspectOne(requestedName);
        if (!inspection) {
          const known = [...new Set([
            ...liveByName.keys(),
            ...runtimeByName.keys(),
            ...Object.keys(registry),
          ])].sort();
          const error = `No subagent named "${requestedName}" is registered in this parent session.`;
          return {
            content: [{ type: "text" as const, text: known.length ? `${error} Known names: ${known.join(", ")}.` : error }],
            details: { error: "unknown-subagent", name: requestedName, knownNames: known, observedAt: now },
          };
        }
        return {
          content: [{ type: "text" as const, text: `Subagent status (observed at ${new Date(now).toISOString()}):\n${formatInspection(inspection)}` }],
          details: { observedAt: now, scope: "name", name: requestedName, subagents: [inspection] },
        };
      }

      const inspections: SubagentInspection[] = [];
      for (const name of liveByName.keys()) {
        const inspection = inspectOne(name);
        if (inspection) inspections.push(inspection);
      }
      for (const name of runtimeByName.keys()) {
        const inspection = inspectOne(name);
        if (inspection) inspections.push(inspection);
      }
      if (includeFinished) {
        for (const name of Object.keys(registry)) {
          if (liveByName.has(name) || runtimeByName.has(name)) continue;
          const inspection = inspectOne(name);
          if (inspection) inspections.push(inspection);
        }
      }
      inspections.sort((a, b) => a.name.localeCompare(b.name));
      const text = inspections.length === 0
        ? includeFinished
          ? "No subagents are registered in this parent session."
          : "No running or recovering subagents are currently registered. Use includeFinished: true to include session history."
        : `Subagent status (observed at ${new Date(now).toISOString()}):\n${inspections.map(formatInspection).join("\n")}`;
      return {
        content: [{ type: "text" as const, text }],
        details: { observedAt: now, scope: includeFinished ? "all" : "running", subagents: inspections },
      };
    },

    renderResult(result, _opts, theme) {
      const details = result.details as { subagents?: SubagentInspection[]; error?: string } | undefined;
      if (details?.error) {
        const text = result.content[0]?.type === "text" ? result.content[0].text : details.error;
        return new Text(theme.fg("error", text), 0, 0);
      }
      const views = details?.subagents ?? [];
      if (views.length === 0) {
        return new Text(theme.fg("dim", "No running subagents"), 0, 0);
      }
      return new Text(
        views.map((view) => {
          const color = view.lifecycle === "stalled" || view.lifecycle === "exited" ? "error" :
            view.lifecycle === "waiting" || view.lifecycle === "offline" ? "warning" : "accent";
          return theme.fg(color, `● ${view.name} — ${view.lifecycle}, last ${formatAge(view.lastActivityAgeMs)}`);
        }).join("\n"),
        0,
        0,
      );
    },
  });
}
