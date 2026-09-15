// providers 模块的配置菜单行（工单 46 起，凭证状态行收进「余额查询」共享二级页）。
//
// 刷新间隔是 schema 字段（`providers.refreshMs`），由骨架自动生成选择行；
// 本文件补一行只读的凭据文件状态（文件由用户自行维护，模块永不写）：
//   供应商凭据 —— 只读：检测 <agentDir>/pi-tui.json 是否存在
// 顶层入口行（工单 46）：打开 providers 与 usage 共享的「余额查询」二级页。

import type { SettingItem } from "@earendil-works/pi-tui";
import { SettingsPanel } from "../../kit/menu/panels.ts";
import type { ModuleMenuContext } from "../../kit/module.ts";
import { piTuiConfigPath, providerAccessConfigured } from "./credentials.ts";

/** 只读凭据状态行 id（schema 行是 `providers.<字段>`，此处避开该前缀） */
export const PROVIDERS_CREDENTIALS_ROW_ID = "provider-usage.credentials";

/** 一级「余额查询」入口行 id */
export const PROVIDERS_MENU_ITEM_ID = "providers.settings";

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

/**
 * 顶层入口行（本单起）：打开 providers 与 usage 共享的「余额查询」二级页；值位不显示状态摘要。
 */
export function buildProvidersTopLevel(context: ModuleMenuContext): readonly SettingItem[] {
	const t = context.t;
	return [
		{
			id: PROVIDERS_MENU_ITEM_ID,
			label: t("module.providers.menu.label"),
			description: t("module.providers.menu.description"),
			currentValue: "",
			submenu: (_currentValue, done) =>
				new SettingsPanel({
					items: context.pageItems?.() ?? [],
					theme: context.theme,
					t,
					onChange: context.onChange,
					onClose: () => done(),
				}),
		},
	];
}
