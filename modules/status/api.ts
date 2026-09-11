// status 模块对其它模块开放的静态导出面（工单 07 定案「决策 9」的例外口径：
// 这里只放类型、常量与无状态的纯函数）。
//
// 有状态、有生命周期的运行能力不走静态 import：控制器由本模块装配时创建，
// 消费方（tui）经服务注册表的 `status.*` 句柄取快照与触发刷新（工单 07 定案 2）。
//
// 句柄契约：`{ snapshot(): T | undefined; refresh(): Promise<void> }`。
// 唯一补充：`status.workspace` 额外带 `settings()` —— 段位配置（preset/segments）
// 按定案 4 归本模块配置节后，渲染侧（tui）必须能读到解析结果，见接口注释。

import type { ProjectStatusSnapshot } from "./project-status.ts";
import type { ResolvedStatusSettings } from "./status-config.ts";
import type { SessionStatusSnapshot } from "./session-status.ts";
import type { TurnTelemetrySnapshot } from "./turn-telemetry.ts";
import type { TurnTimerSnapshot } from "./turn-timer.ts";

/** 本模块在服务注册表里的五个句柄名（工单 07 定案 2） */
export const STATUS_WORKSPACE_SERVICE_NAME = "status.workspace";
export const STATUS_SESSION_SERVICE_NAME = "status.session";
export const STATUS_TIMER_SERVICE_NAME = "status.timer";
export const STATUS_TELEMETRY_SERVICE_NAME = "status.telemetry";
export const STATUS_COMPACTION_SERVICE_NAME = "status.compaction";

/** git 数据域类型（经 `status.workspace` 快照透出，不单独设句柄） */
export type {
	GitRefreshState,
	GitStatusCodeCount,
	GitStatusDetails,
	ProjectStatusSegmentId,
	ProjectStatusSnapshot,
} from "./project-status.ts";
/** 运行时探测快照 */
export type { RuntimeStatusSnapshot } from "./runtime-status.ts";
/** 会话段：采集结果与段位 id */
export type { EditorUsageSegmentId, SessionStatusSnapshot, SessionStatusSegmentId } from "./session-status.ts";
/** 回合计时 */
export type { TurnTimerSnapshot, TurnTimerState } from "./turn-timer.ts";
/** 回合遥测：快照、条目数据与落盘条目类型 */
export type { PersistedTurnDuration, PersistedTurnTelemetry, TurnTelemetrySnapshot } from "./turn-telemetry.ts";
/** 段位设置（status-config.ts 的语言） */
export type {
	EditorLeftSegmentId,
	FooterExtraSegmentId,
	ResolvedStatusSettings,
	StatusPresetName,
	StatusSectionConfig,
	StatusSegmentId,
	StatusSettingsOverride,
} from "./status-config.ts";

/** 回合遥测条目：custom entry 类型常量与解析（渲染半在 tui 侧复用） */
export {
	TURN_DURATION_ENTRY_TYPE,
	TURN_TELEMETRY_ENTRY_TYPE,
	readLatestTurnDuration,
	readTurnDurationEntryData,
	readTurnTelemetryEntryData,
} from "./turn-telemetry.ts";
/** 段位设置：预设表、段位全集、解析函数（tui 侧静态消费） */
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

/** 只读解析面：会话采集与 git 解析的纯函数 */
export { collectSessionStatus } from "./session-status.ts";
export { parseGitStatusV2 } from "./project-status.ts";

/**
 * `status.workspace` 句柄：project / git / duration / runtime 四段聚合快照。
 *
 * `settings()` 是段位设置（preset/segments/telemetry 的解析结果）的读取面：
 * 设置已随「配置构造下沉」归本模块配置节，渲染侧每帧需要知道渲染哪些段，
 * 因此随聚合句柄一起透出（工单 11 自行定案的契约补充，快照面本身仍只有
 * snapshot/refresh）。设置随配置实时变化，不做缓存。
 */
export interface StatusWorkspaceService {
	readonly id: "status";
	snapshot(): ProjectStatusSnapshot | undefined;
	refresh(): Promise<void>;
	settings(): ResolvedStatusSettings;
}

/** `status.session` 句柄：会话段数据（token / cache / 轮数 / 压缩次数） */
export interface StatusSessionService {
	readonly id: "status";
	snapshot(): SessionStatusSnapshot | undefined;
	refresh(): Promise<void>;
}

/** `status.timer` 句柄：回合计时（会话绑定前 undefined；刷新是空操作，状态由事件驱动） */
export interface StatusTimerService {
	readonly id: "status";
	snapshot(): TurnTimerSnapshot | undefined;
	refresh(): Promise<void>;
}

/** `status.telemetry` 句柄：最近一次落盘的回合遥测（刷新是空操作，状态由事件驱动） */
export interface StatusTelemetryService {
	readonly id: "status";
	snapshot(): TurnTelemetrySnapshot | undefined;
	refresh(): Promise<void>;
}

/** `status.compaction` 句柄：自动压缩开关（未创建控制器时 undefined） */
export interface StatusCompactionService {
	readonly id: "status";
	snapshot(): boolean | undefined;
	refresh(): Promise<void>;
}
