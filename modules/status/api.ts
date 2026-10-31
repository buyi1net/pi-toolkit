import type { ProjectStatusSnapshot } from "./project-status.ts";
import type { ResolvedStatusSettings } from "./status-config.ts";
import type { SessionStatusSnapshot } from "./session-status.ts";
import type { TurnTelemetryLiveSnapshot, TurnTelemetrySnapshot } from "./turn-telemetry.ts";
import type { TurnTimerSnapshot } from "./turn-timer.ts";
import type { AutoCompactionSnapshot } from "./auto-compaction.ts";

export const STATUS_WORKSPACE_SERVICE_NAME = "status.workspace";
export const STATUS_SESSION_SERVICE_NAME = "status.session";
export const STATUS_TIMER_SERVICE_NAME = "status.timer";
export const STATUS_TELEMETRY_SERVICE_NAME = "status.telemetry";
export const STATUS_COMPACTION_SERVICE_NAME = "status.compaction";

export type { AutoCompactionSnapshot } from "./auto-compaction.ts";

export interface SnapshotRevision {
	readonly revision: number;
}

export type StatusWorkspaceSnapshot = ProjectStatusSnapshot & SnapshotRevision;

export type StatusSessionSnapshot = SessionStatusSnapshot & SnapshotRevision;

export type StatusTimerSnapshot = TurnTimerSnapshot & SnapshotRevision;

export type {
	GitRefreshState,
	GitStatusCodeCount,
	GitStatusDetails,
	ProjectStatusSegmentId,
	ProjectStatusSnapshot,
} from "./project-status.ts";

export type { RuntimeStatusSnapshot } from "./runtime-status.ts";

export type { EditorUsageSegmentId, SessionStatusSnapshot, SessionStatusSegmentId } from "./session-status.ts";

export type { TurnTimerSnapshot, TurnTimerState } from "./turn-timer.ts";

export type { PersistedTurnDuration, PersistedTurnTelemetry, TurnTelemetryLiveSnapshot, TurnTelemetrySnapshot } from "./turn-telemetry.ts";

export type {
	EditorLeftSegmentId,
	EditorRightSegmentId,
	FooterExtraSegmentId,
	ResolvedStatusSettings,
	StatusPresetName,
	StatusSectionConfig,
	StatusSegmentId,
	StatusSettingsOverride,
} from "./status-config.ts";

export {
	TURN_DURATION_ENTRY_TYPE,
	TURN_TELEMETRY_ENTRY_TYPE,
	readLatestTurnDuration,
	readTurnDurationEntryData,
	readTurnTelemetryEntryData,
} from "./turn-telemetry.ts";

export {
	DEFAULT_STATUS_SECTION,
	STATUS_MODULE_ID,
	STATUS_PRESET_NAMES,
	STATUS_SEGMENT_IDS,
	resolveStatusSettings,
	statusPresetSegments,
	statusSettingsFromSection,
} from "./status-config.ts";
export type { LoadedStatusSection, StatusSectionUpdate } from "./status-config.ts";

export { collectSessionStatus } from "./session-status.ts";
export { parseGitStatusV2 } from "./project-status.ts";

export interface StatusWorkspaceService {
	readonly id: "status";
	snapshot(): StatusWorkspaceSnapshot | undefined;
	refresh(): Promise<void>;
	settings(): ResolvedStatusSettings;
}

export interface StatusSessionService {
	readonly id: "status";
	snapshot(): StatusSessionSnapshot | undefined;
	refresh(): Promise<void>;
}

export interface StatusTimerService {
	readonly id: "status";
	snapshot(): StatusTimerSnapshot | undefined;
	refresh(): Promise<void>;
}

export interface StatusTelemetryService {
	readonly id: "status";
	snapshot(): TurnTelemetrySnapshot | undefined;
	liveSnapshot(): TurnTelemetryLiveSnapshot | undefined;
	refresh(): Promise<void>;
}

export interface StatusCompactionService {
	readonly id: "status";
	snapshot(): AutoCompactionSnapshot | undefined;
	refresh(): Promise<void>;
}
