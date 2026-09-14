import type { ContextUsage } from "@earendil-works/pi-coding-agent";
import type { UsageRuntimeState } from "../../providers/api.ts";
import type {
	ProjectStatusSnapshot,
	ResolvedStatusSettings,
	RuntimeStatusSnapshot,
	SessionStatusSnapshot,
	TurnTimerSnapshot,
} from "../../status/api.ts";
import type { IconGlyphs } from "../renderer/icons.ts";

// 视图数据源分组契约：Footer 与 Editor 只按数据源接收分组接口，装配
// （lifecycle.ts）负责把 status/providers 模块的句柄与宿主上下文接成这些组。
// 新增一个状态数据段只扩展或实现对应分组，不再改动视图构造器签名。
//
// 工单 11：各分组的数据来自 status.* / providers.usage 句柄（类型从模块 api 面取），
// 段位设置改为每帧读取（配置改动后下一次重绘即生效）。

/** 会话源：本轮计时器与会话遥测（token/cache、上下文用量、自动压缩）。 */
export interface SessionStatusSource {
	getTimer?: () => TurnTimerSnapshot | undefined;
	getSessionStatus?: () => SessionStatusSnapshot | undefined;
	/** 会话 id：直读宿主会话管理器，不经 status 句柄（status 关闭时短码段仍显示） */
	getSessionId?: () => string | null;
	getContextUsage?: () => ContextUsage | undefined;
	getContextWindow?: () => number | undefined;
	getAutoCompactionEnabled?: () => boolean | undefined;
}

/** 供应商源：用量快照查询；刷新请求由装配层接给控制器，不进视图。 */
export interface ProviderUsageSource {
	getState?: () => UsageRuntimeState | undefined;
}

/** 项目环境源：工作区快照（project / git / runtime）与工作目录，供 Footer 项目行。 */
export interface ProjectEnvironmentSource {
	getProjectStatus?: () => Readonly<ProjectStatusSnapshot> | undefined;
	getRuntimeStatus?: () => Readonly<RuntimeStatusSnapshot> | null | undefined;
	cwd?: string;
}

/** 布局源（Footer 侧）：高度回报。 */
export interface FooterLayoutSource {
	reportHeight?: (height: number) => void;
}

/** 布局源（Editor 侧）：Footer 高度查询，供补全 Overlay 定位。 */
export interface EditorLayoutSource {
	getFooterHeight?: () => number;
}

/** 外观配置：图标解析与状态段设置，随数据源分组一起注入两端视图。 */
export interface StatusAppearance {
	getGlyphs?: () => IconGlyphs;
	/** 段位设置（status 模块配置节的解析结果）：每帧读取，配置改动后下一次重绘即生效 */
	getSettings?: () => ResolvedStatusSettings;
}
