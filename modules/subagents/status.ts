import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatElapsed } from "../tui/status/status-segments.ts";

export const SNAPSHOT_STALLED_AFTER_MS = 60_000;

export const STALE_HINT_AFTER_MS = 120_000;
export const DEFAULT_STATUS_LINE_LIMIT = 4;
export const MAX_STATUS_NAME_LENGTH = 72;
export const MAX_STATUS_LINE_LENGTH = 120;

const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url));
const DEFAULT_STATUS_CONFIG_PATH = join(PACKAGE_ROOT, "config.json");
const STATUS_CONFIG_EXAMPLE_PATH = join(PACKAGE_ROOT, "config.json.example");

export type SubagentStatusKind =
  | "starting"
  | "active"
  | "waiting"
  | "stalled"
  | "running"

  | "stale"

  | "stale-tool";
export type SubagentStatusSource = "pi" | "claude";
export type SubagentStatusTransition = "stalled" | "recovered" | null;
export type StatusSnapshotState = "unseen" | "present" | "missing" | "invalid" | "wrong-id";
export type StatusActivityPhase = "starting" | "active" | "waiting" | "done";

export interface StatusLivenessEvidence {

  sessionLastChangeAtMs: number | null;

  processAlive: boolean | null;
}

export type SubagentStatusLabelCode = "done" | "wrong-activity-id";

export interface StatusConfig {
  enabled: boolean;
  lineLimit: number;
}

export type StatusObservation =
  | {
      snapshot: "present";
      updatedAt: number;
      sequence: number;
      phase: StatusActivityPhase;
      active?: boolean;

      toolActive?: boolean;
      activeScope?: string;
      activeSince?: number;
      waitingSince?: number;
      latestEvent?: string;
      activityLabel?: string;
    }
  | {
      snapshot: "missing" | "invalid" | "wrong-id";
      snapshotError?: string;
    };

export interface SubagentStatusState {
  source: SubagentStatusSource;
  startTimeMs: number;
  firstObservationAtMs: number | null;
  lastActivityAtMs: number | null;
  lastActivitySequence: number | null;
  localOverrideAtMs: number | null;
  localOverrideSequence: number | null;
  activeNow: boolean;

  toolActive: boolean;
  activeSinceMs: number | null;
  activeScope: string | null;
  waitingSinceMs: number | null;
  phase: StatusActivityPhase | null;
  latestEvent: string | null;
  activityLabel: string | null;
  snapshotState: StatusSnapshotState;
  snapshotProblemSinceMs: number | null;
  snapshotError: string | null;

  liveness: StatusLivenessEvidence | null;
  currentKind: SubagentStatusKind;
}

export interface StatusSnapshot {
  kind: SubagentStatusKind;
  elapsedMs: number;
  elapsedText: string;
  activeSinceMs: number | null;
  activeDurationText: string | null;
  activeScope: string | null;
  waitingSinceMs: number | null;
  waitingDurationText: string | null;
  latestEvent: string | null;
  activityLabel: string | null;
  snapshotState: StatusSnapshotState;
  snapshotError: string | null;
  snapshotProblemText: string | null;
  statusLabel: SubagentStatusLabelCode | null;

  staleDurationText: string | null;

  stalledWithEvidence: boolean;
}

export interface CappedStatusLines {
  visibleLines: string[];
  overflow: number;
}

function invalidStatusConfig(source: string, message: string): never {
  throw new Error(`Invalid subagent status config in ${source}: ${message}`);
}

function requireObject(value: unknown, source: string, fieldName: string): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    invalidStatusConfig(source, `${fieldName} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireBoolean(value: unknown, source: string, fieldName: string): boolean {
  if (typeof value !== "boolean") {
    invalidStatusConfig(source, `${fieldName} must be a boolean`);
  }
  return value;
}

function rejectUnsupportedKeys(
  value: Record<string, unknown>,
  allowedKeys: string[],
  source: string,
  fieldName: string,
): void {
  const unsupportedKeys = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unsupportedKeys.length > 0) {
    invalidStatusConfig(source, `${fieldName} has unsupported key(s): ${unsupportedKeys.join(", ")}`);
  }
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  if (maxLength <= 1) return text.slice(0, maxLength);
  return `${text.slice(0, maxLength - 1)}…`;
}

export function normalizeStatusName(name: string): string {
  const collapsed = name.replace(/\s+/g, " ").trim() || "subagent";
  return truncateText(collapsed, MAX_STATUS_NAME_LENGTH);
}

function snapshotProblemCode(snapshotState: StatusSnapshotState): SubagentStatusLabelCode | null {
  if (snapshotState === "wrong-id") return "wrong-activity-id";
  return null;
}

export function parseStatusConfig(rawConfig: unknown, source = "config.json"): StatusConfig {
  const config = requireObject(rawConfig, source, "root");
  const status = requireObject(config.status, source, "status");
  rejectUnsupportedKeys(status, ["enabled"], source, "status");
  const enabled = requireBoolean(status.enabled, source, "status.enabled");

  return {
    enabled,
    lineLimit: DEFAULT_STATUS_LINE_LIMIT,
  };
}

function readStatusConfigFile(configPath: string, examplePath: string): { sourcePath: string; rawConfig: string } {
  try {
    return { sourcePath: configPath, rawConfig: readFileSync(configPath, "utf8") };
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code !== "ENOENT") throw error;
  }

  try {
    return { sourcePath: examplePath, rawConfig: readFileSync(examplePath, "utf8") };
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") {
      throw new Error(
        `Missing subagent status config. Expected ${configPath} or ${examplePath}.`,
      );
    }
    throw error;
  }
}

export function loadStatusConfig(
  configPath = DEFAULT_STATUS_CONFIG_PATH,
  examplePath = STATUS_CONFIG_EXAMPLE_PATH,
): StatusConfig {
  const { sourcePath, rawConfig } = readStatusConfigFile(configPath, examplePath);

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawConfig) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in subagent config ${sourcePath}: ${detail}`);
  }

  return parseStatusConfig(parsed, sourcePath);
}

export function formatElapsedDuration(ms: number): string {
  return formatElapsed(ms);
}

export function createStatusState(params: {
  source: SubagentStatusSource;
  startTimeMs: number;
}): SubagentStatusState {
  const initialKind = params.source === "claude" ? "running" : "starting";
  return {
    source: params.source,
    startTimeMs: params.startTimeMs,
    firstObservationAtMs: null,
    lastActivityAtMs: null,
    lastActivitySequence: null,
    localOverrideAtMs: null,
    localOverrideSequence: null,
    activeNow: false,
    activeSinceMs: null,
    activeScope: null,
    waitingSinceMs: null,
    phase: null,
    latestEvent: null,
    activityLabel: null,
    snapshotState: params.source === "claude" ? "unseen" : "unseen",
    snapshotProblemSinceMs: null,
    snapshotError: null,
    liveness: null,
    toolActive: false,
    currentKind: initialKind,
  };
}

export function withoutLivenessEvidence(state: SubagentStatusState): SubagentStatusState {
  return state.liveness == null ? state : { ...state, liveness: null };
}

export function observeStatus(
  state: SubagentStatusState,
  observation: StatusObservation,
  now: number,
  evidence?: StatusLivenessEvidence,
): SubagentStatusState {
  const next = applyStatusObservation(state, observation, now);
  if (evidence === undefined || next.source === "claude") return next;
  return { ...next, liveness: evidence };
}

function applyStatusObservation(
  state: SubagentStatusState,
  observation: StatusObservation,
  now: number,
): SubagentStatusState {
  if (state.source === "claude") return state;

  if (observation.snapshot !== "present") {
    return {
      ...state,
      firstObservationAtMs: state.firstObservationAtMs ?? now,
      snapshotState: observation.snapshot,
      snapshotProblemSinceMs: state.snapshotProblemSinceMs ?? now,
      snapshotError: observation.snapshotError ?? null,
    };
  }

  const updatedAt = observation.updatedAt;
  const sequence = observation.sequence;
  const lastActivityAtMs = state.lastActivityAtMs;
  const lastActivitySequence = state.lastActivitySequence;
  const olderThanLastActivity = lastActivityAtMs != null && (
    updatedAt < lastActivityAtMs ||
    (updatedAt === lastActivityAtMs && lastActivitySequence != null && sequence < lastActivitySequence)
  );
  if (olderThanLastActivity) return state;

  const blockedByLocalOverride = state.localOverrideAtMs != null && (
    updatedAt < state.localOverrideAtMs ||
    (updatedAt === state.localOverrideAtMs && state.localOverrideSequence != null && sequence <= state.localOverrideSequence)
  );
  if (blockedByLocalOverride) return state;

  const phase = observation.phase;
  const activeNow = phase === "active" || observation.active === true;
  const activeSinceMs = activeNow
    ? observation.activeSince ?? state.activeSinceMs ?? updatedAt
    : null;
  const toolActive = activeNow && (observation.toolActive === true || observation.activeScope === "tool");
  const waitingSinceMs = phase === "waiting"
    ? observation.waitingSince ?? state.waitingSinceMs ?? updatedAt
    : null;

  return {
    ...state,
    firstObservationAtMs: state.firstObservationAtMs ?? now,
    lastActivityAtMs: updatedAt,
    lastActivitySequence: sequence,
    activeNow,
    toolActive,
    activeSinceMs,
    activeScope: activeNow ? observation.activeScope ?? null : null,
    waitingSinceMs,
    phase,
    latestEvent: observation.latestEvent ?? null,
    activityLabel: observation.activityLabel ?? null,
    snapshotState: "present",
    snapshotProblemSinceMs: null,
    snapshotError: null,
    localOverrideAtMs: null,
    localOverrideSequence: null,
  };
}

export function forceStatusAfterInterrupt(state: SubagentStatusState, now: number): SubagentStatusState {
  if (state.source === "claude") return state;

  return {
    ...state,
    firstObservationAtMs: state.firstObservationAtMs ?? now,
    lastActivityAtMs: now,
    localOverrideAtMs: now,
    localOverrideSequence: state.lastActivitySequence,
    activeNow: false,
    toolActive: false,
    activeSinceMs: null,
    activeScope: null,
    waitingSinceMs: now,
    phase: "waiting",
    latestEvent: "interrupt_requested",

    activityLabel: "interrupted",
    snapshotState: "present",
    snapshotProblemSinceMs: null,
    snapshotError: null,
    currentKind: "waiting",
  };
}

function sessionGrowing(state: SubagentStatusState, now: number): boolean {
  const lastChangeAtMs = state.liveness?.sessionLastChangeAtMs;
  return lastChangeAtMs != null && now - lastChangeAtMs < STALE_HINT_AFTER_MS;
}

function stalledVerdict(staleDurationText: string | null = null): Pick<
  StatusSnapshot,
  "kind" | "staleDurationText" | "stalledWithEvidence"
> {
  return { kind: "stalled", staleDurationText, stalledWithEvidence: false };
}

function classifyProblemState(
  state: SubagentStatusState,
  now: number,
): Pick<StatusSnapshot, "kind" | "statusLabel" | "staleDurationText" | "stalledWithEvidence"> {
  const problemLabel = snapshotProblemCode(state.snapshotState);
  const hasValidSnapshot = state.lastActivityAtMs != null;

  if (!hasValidSnapshot) {
    const referenceMs = state.firstObservationAtMs ?? state.startTimeMs;
    const elapsedMs = Math.max(0, now - referenceMs);
    if (elapsedMs < SNAPSHOT_STALLED_AFTER_MS) {
      return { kind: "starting", statusLabel: null, staleDurationText: null, stalledWithEvidence: false };
    }

    if (sessionGrowing(state, now)) {
      return {
        kind: "stale",
        statusLabel: problemLabel,
        staleDurationText: formatElapsedDuration(elapsedMs),
        stalledWithEvidence: false,
      };
    }
    return { ...stalledVerdict(), statusLabel: problemLabel };
  }

  const problemSinceMs = state.snapshotProblemSinceMs ?? now;
  const problemMs = Math.max(0, now - problemSinceMs);
  if (problemMs >= SNAPSHOT_STALLED_AFTER_MS) {
    if (sessionGrowing(state, now)) {
      return {
        kind: "stale",
        statusLabel: problemLabel,
        staleDurationText: formatElapsedDuration(Math.max(0, now - state.lastActivityAtMs!)),
        stalledWithEvidence: false,
      };
    }
    return { ...stalledVerdict(), statusLabel: problemLabel };
  }

  const lastHealthyKind = state.activeNow
    ? "active"
    : state.waitingSinceMs != null || state.phase === "done"
      ? "waiting"
      : state.currentKind === "stalled"
        ? "starting"
        : state.currentKind;
  return { kind: lastHealthyKind, statusLabel: problemLabel, staleDurationText: null, stalledWithEvidence: false };
}

function classifyActiveStaleness(
  state: SubagentStatusState,
  now: number,
): Pick<StatusSnapshot, "kind" | "staleDurationText" | "stalledWithEvidence"> {
  const lastActivityAtMs = state.lastActivityAtMs;
  if (lastActivityAtMs == null) {
    return { kind: "active", staleDurationText: null, stalledWithEvidence: false };
  }
  const staleMs = now - lastActivityAtMs;
  if (staleMs < STALE_HINT_AFTER_MS) {
    return { kind: "active", staleDurationText: null, stalledWithEvidence: false };
  }

  if (state.toolActive) {
    return { kind: "stale-tool", staleDurationText: null, stalledWithEvidence: false };
  }

  const lastChangeAtMs = state.liveness?.sessionLastChangeAtMs ?? null;
  if (lastChangeAtMs == null) {

    return state.liveness?.processAlive === false
      ? stalledVerdict(formatElapsedDuration(staleMs))
      : { kind: "active", staleDurationText: null, stalledWithEvidence: false };
  }

  if (now - lastChangeAtMs < STALE_HINT_AFTER_MS) {

    return { kind: "stale", staleDurationText: formatElapsedDuration(staleMs), stalledWithEvidence: false };
  }

  return {
    kind: "stalled",
    staleDurationText: formatElapsedDuration(staleMs),
    stalledWithEvidence: true,
  };
}

export function classifyStatus(state: SubagentStatusState, now: number): StatusSnapshot {
  const elapsedMs = Math.max(0, now - state.startTimeMs);
  const elapsedText = formatElapsedDuration(elapsedMs);

  if (state.source === "claude") {
    return {
      kind: "running",
      elapsedMs,
      elapsedText,
      activeSinceMs: null,
      activeDurationText: null,
      activeScope: null,
      waitingSinceMs: null,
      waitingDurationText: null,
      latestEvent: null,
      activityLabel: null,
      snapshotState: state.snapshotState,
      snapshotError: null,
      snapshotProblemText: null,
      statusLabel: null,
      staleDurationText: null,
      stalledWithEvidence: false,
    };
  }

  let kind: SubagentStatusKind;
  let statusLabel: SubagentStatusLabelCode | null = null;
  let staleVerdictExtras: Pick<StatusSnapshot, "staleDurationText" | "stalledWithEvidence"> = {
    staleDurationText: null,
    stalledWithEvidence: false,
  };

  if (state.snapshotState === "present") {
    if (state.phase === "active" || state.activeNow) {
      const verdict = classifyActiveStaleness(state, now);
      kind = verdict.kind;
      staleVerdictExtras = {
        staleDurationText: verdict.staleDurationText,
        stalledWithEvidence: verdict.stalledWithEvidence,
      };
    } else if (state.phase === "waiting") {
      kind = "waiting";
    } else if (state.phase === "done") {
      kind = "waiting";
      statusLabel = "done";
    } else {
      const referenceMs = state.firstObservationAtMs ?? state.startTimeMs;
      const elapsedSinceObservationMs = Math.max(0, now - referenceMs);
      if (elapsedSinceObservationMs < SNAPSHOT_STALLED_AFTER_MS) {
        kind = "starting";
      } else if (sessionGrowing(state, now)) {

        kind = "stale";
        staleVerdictExtras = {
          staleDurationText: formatElapsedDuration(Math.max(0, now - (state.lastActivityAtMs ?? referenceMs))),
          stalledWithEvidence: false,
        };
      } else {
        kind = "stalled";
      }
      statusLabel = null;
    }
  } else {
    const classified = classifyProblemState(state, now);
    kind = classified.kind;
    statusLabel = classified.statusLabel;
    staleVerdictExtras = {
      staleDurationText: classified.staleDurationText,
      stalledWithEvidence: classified.stalledWithEvidence,
    };
  }

  const activeDurationText = state.activeSinceMs == null
    ? null
    : formatElapsedDuration(now - state.activeSinceMs);
  const waitingDurationText = state.waitingSinceMs == null
    ? null
    : formatElapsedDuration(now - state.waitingSinceMs);
  const snapshotProblemText = state.snapshotProblemSinceMs == null
    ? null
    : formatElapsedDuration(now - state.snapshotProblemSinceMs);

  return {
    kind,
    elapsedMs,
    elapsedText,
    activeSinceMs: state.activeSinceMs,
    activeDurationText,
    activeScope: state.activeScope,
    waitingSinceMs: state.waitingSinceMs,
    waitingDurationText,
    latestEvent: state.latestEvent,
    activityLabel: state.activityLabel,
    snapshotState: state.snapshotState,
    snapshotError: state.snapshotError,
    snapshotProblemText,
    statusLabel,
    staleDurationText: staleVerdictExtras.staleDurationText,
    stalledWithEvidence: staleVerdictExtras.stalledWithEvidence,
  };
}

export function advanceStatusState(
  state: SubagentStatusState,
  now: number,
): {
  nextState: SubagentStatusState;
  snapshot: StatusSnapshot;
  transition: SubagentStatusTransition;
} {
  const snapshot = classifyStatus(state, now);
  const transition =
    state.currentKind !== "stalled" && snapshot.kind === "stalled"
      ? "stalled"
      : state.currentKind === "stalled" && (snapshot.kind === "active" || snapshot.kind === "waiting")
        ? "recovered"
        : null;

  return {
    snapshot,
    transition,
    nextState: {
      ...state,
      currentKind: snapshot.kind,
    },
  };
}

export function capStatusLines(lines: string[], lineLimit: number): CappedStatusLines {
  const visibleLines = lines.slice(0, lineLimit);
  return {
    visibleLines,
    overflow: Math.max(0, lines.length - visibleLines.length),
  };
}
