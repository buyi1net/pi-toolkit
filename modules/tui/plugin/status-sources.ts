import type { ContextUsage } from "@earendil-works/pi-coding-agent";
import type { UsageRuntimeState } from "../kernel/usage-node.ts";
import type { IconGlyphs } from "../renderer/icons.ts";
import type { ProjectStatusSnapshot } from "../status/project-status.ts";
import type { ResolvedStatusSettings } from "../status/status-config.ts";
import type { RuntimeStatusSnapshot } from "../status/runtime-status.ts";
import type { SessionStatusSnapshot } from "../status/session-status.ts";
import type { TurnTimerSnapshot } from "../status/status-segments.ts";

// 视图数据源分组契约：Footer 与 Editor 只按数据源接收分组接口，装配
// （lifecycle.ts）负责把状态控制器与宿主上下文接成这些组。新增一个状态
// 数据段只扩展或实现对应分组，不再改动视图构造器签名。

/** 会话源：本轮计时器与会话遥测（token/cache、上下文用量、自动压缩）。 */
export interface SessionStatusSource {
	getTimer?: () => TurnTimerSnapshot;
	getSessionStatus?: () => SessionStatusSnapshot;
	getContextUsage?: () => ContextUsage | undefined;
	getContextWindow?: () => number | undefined;
	getAutoCompactionEnabled?: () => boolean;
}

/** 供应商源：用量快照查询；刷新请求由装配层接给控制器，不进视图。 */
export interface ProviderUsageSource {
	getState?: () => UsageRuntimeState | undefined;
}

/** 项目环境源：Git 状态、运行时状态与工作目录，供 Footer 项目行。 */
export interface ProjectEnvironmentSource {
	getProjectStatus?: () => Readonly<ProjectStatusSnapshot>;
	getRuntimeStatus?: () => Readonly<RuntimeStatusSnapshot> | null;
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
	settings?: ResolvedStatusSettings;
}
