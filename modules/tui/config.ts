// pi-tui 模块的配置落点：pi-toolkit.json 的 `modules.tui` 节。
//
// 节结构（与迁入前的 pi-tui.json 外观语义一致，只是换了宿主文件）：
//   modules.tui.appearance.editor / header / footer
//   modules.tui.status.preset / segments
//   modules.tui.data.providerRefreshMs / telemetry
//   modules.tui.advanced.spinner
// 供应商查询凭据不在这里：按用户裁决留在独立文件 <agentDir>/pi-tui.json，
// 本模块只读（见 plugin/settings-config.ts），toolkit 永不写它。
//
// 写盘走骨架的 saveToolkitConfig：深合并、剥敏感键、0600 原子替换。

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getToolkitConfigPath, saveToolkitConfig } from "../../config.ts";
import type { ModuleConfigRecord } from "../../module.ts";
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
	status?: Partial<PiTuiConfig["status"]>;
	data?: Partial<Pick<PiTuiConfig["data"], "providerRefreshMs" | "telemetry">>;
	advanced?: Partial<PiTuiConfig["advanced"]>;
};

/**
 * 读 `modules.tui` 节并规范化。非法取值逐条记 warning 并回退默认值，
 * 菜单展示与 lifecycle 的实际安装都用这一份结果。
 */
export function readTuiSection(section: Record<string, unknown> | undefined): LoadedPiTuiConfig {
	return parseTuiSection(section);
}

/** 写本节点（深合并，不动其它模块节与语言设置）。 */
export async function saveTuiSection(
	update: TuiSectionUpdate,
	options: { readonly agentDir?: string } = {},
): Promise<void> {
	const path = getToolkitConfigPath(options.agentDir ?? getAgentDir());
	await saveToolkitConfig(path, {
		modules: { [TUI_MODULE_ID]: update as ModuleConfigRecord },
	});
}
