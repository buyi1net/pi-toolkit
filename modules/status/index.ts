// status 模块装配定义（工单 11）：工作区与会话状态数据源从 tui 迁出后的独立模块。
//
// 模块边界（工单 07 定案 5 / 7）：
// - 数据半在本模块：project(git) / runtime / duration(timer) / session / telemetry / compaction
//   各数据源与 status-config.ts（段位预设、模块配置节解析）
// - 渲染半留 tui：status-segments.ts、provider-status.ts 与各数据文件切出的渲染函数
// - 运行态经 `status.*` 五个句柄透出，控制器在本模块装配时创建（工单 07 定案 2）
// - 菜单行（状态预设、回复遥测）在本模块 menu.ts；tui 只消费句柄与静态导出面

import { enabledField, type ModuleContext, type ModuleDefinition } from "../../kit/module.ts";
import { buildStatusMenuItems } from "./menu.ts";
import { registerStatus, type StatusMenuRuntime, type StatusModuleOptions } from "./mod.ts";
import { STATUS_MODULE_ID } from "./status-config.ts";

export { STATUS_MODULE_ID } from "./status-config.ts";
export { STATUS_PRESET_ROW_ID, STATUS_TELEMETRY_ROW_ID } from "./menu.ts";
export type { StatusMenuRuntime, StatusModuleOptions } from "./mod.ts";
export {
	STATUS_COMPACTION_SERVICE_NAME,
	STATUS_SESSION_SERVICE_NAME,
	STATUS_TELEMETRY_SERVICE_NAME,
	STATUS_TIMER_SERVICE_NAME,
	STATUS_WORKSPACE_SERVICE_NAME,
} from "./api.ts";

export function createStatusModule(options: StatusModuleOptions = {}): ModuleDefinition {
	// 菜单保存走 kit 的配置写入事务（补丁 → 落盘 → 重载 → reapply）：模块只留控制器重建动作
	const runtime: StatusMenuRuntime = { reapply: () => {} };

	return {
		id: STATUS_MODULE_ID,
		labelKey: "module.status.label",
		descriptionKey: "module.status.description",
		// 工单 46：归 TUI 分组，与 tui 模块共享「外观与状态」二级页（pageId "tui"）；
		// 一级不出现（topLevel 空数组），行全部收进二级页
		group: "tui",
		pageId: "tui",
		topLevel: () => [],
		// schema 只放总开关；段位设置（preset / segments / telemetry）是模块自己的
		// 结构化配置，由本模块的 menu.ts 与 status-config.ts 读写。
		configSchema: {
			enabled: enabledField("module.status.enabled.label", "module.status.enabled.description"),
		},
		register(context: ModuleContext): void {
			registerStatus(context, options, runtime);
		},
		menuItems(context): ReturnType<typeof buildStatusMenuItems> {
			return buildStatusMenuItems(context, runtime);
		},
	};
}

export const statusModule: ModuleDefinition = createStatusModule();
