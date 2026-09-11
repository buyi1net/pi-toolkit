// providers 模块的配置菜单行。
//
// 刷新间隔是 schema 字段（`providers.refreshMs`），由骨架自动生成选择行；
// 本文件只补一行只读的凭据文件状态（文件由用户自行维护，模块永不写）：
//   供应商凭据 —— 只读：检测 <agentDir>/pi-tui.json 是否存在

import type { SettingItem } from "@earendil-works/pi-tui";
import type { ModuleMenuContext } from "../../kit/module.ts";
import { piTuiConfigPath, providerAccessConfigured } from "./credentials.ts";

/** 只读凭据状态行 id（schema 行是 `providers.<字段>`，此处避开该前缀） */
export const PROVIDERS_CREDENTIALS_ROW_ID = "provider-usage.credentials";

function providerAccessValue(context: ModuleMenuContext): string {
	return providerAccessConfigured(context.agentDir)
		? context.t("module.providers.providerAccess.configured")
		: context.t("module.providers.providerAccess.missing");
}

export function buildProvidersMenuItems(context: ModuleMenuContext): readonly SettingItem[] {
	return [
		{
			id: PROVIDERS_CREDENTIALS_ROW_ID,
			label: context.t("module.providers.providerAccess.label"),
			description: `${context.t("module.providers.providerAccess.description")} ${piTuiConfigPath(context.agentDir)}`,
			currentValue: providerAccessValue(context),
		},
	];
}
