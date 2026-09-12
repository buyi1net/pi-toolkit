// pi-tui 模块的配置落点：pi-toolkit.json 的 `modules.tui` 节。
//
// 节结构（与迁入前的 pi-tui.json 外观语义一致，只是换了宿主文件）：
//   modules.tui.appearance.editor / header / footer
//   modules.tui.advanced.spinner
// 供应商查询凭据与刷新间隔不在这里（工单 10 归 providers 模块）：
// 凭据留在独立文件 <agentDir>/pi-tui.json，刷新间隔在 modules.providers.refreshMs。
// 状态预设 / 段位与回复遥测开关也不在这里（工单 11 归 status 模块：modules.status.*）。
//
// 写盘走 kit 的结构化配置写入事务（ModuleContext / ModuleMenuContext.saveConfig）：
// 深合并、剥敏感键、0600 原子替换与内存重载都在事务里。

import type { ModuleConfigRecord } from "../../kit/module.ts";
import {
	parseTuiSection,
	type LoadedPiTuiConfig,
	type PiTuiConfig,
} from "./plugin/settings-config.ts";

/** 模块 id：同时是配置节名与菜单项 id 前缀 */
export const TUI_MODULE_ID = "tui";
export const TUI_SECTION_LABEL = `modules.${TUI_MODULE_ID}`;

export type TuiSectionUpdate = {
	appearance?: Partial<PiTuiConfig["appearance"]>;
	advanced?: Partial<PiTuiConfig["advanced"]>;
};

/**
 * 读 `modules.tui` 节并规范化。非法取值逐条记 warning 并回退默认值，
 * 菜单展示与 lifecycle 的实际安装都用这一份结果。
 */
export function readTuiSection(section: Record<string, unknown> | undefined): LoadedPiTuiConfig {
	return parseTuiSection(section);
}

/** 写盘补丁语义（工单 19）：外观 / 高级更新 → `modules.tui` 节补丁 */
export function tuiSectionPatch(update: TuiSectionUpdate): ModuleConfigRecord {
	return { ...update } as ModuleConfigRecord;
}
