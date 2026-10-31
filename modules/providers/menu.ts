import type { SettingItem } from "@earendil-works/pi-tui";
import { SettingsPanel } from "../../kit/menu/panels.ts";
import type { ModuleMenuContext } from "../../kit/module.ts";
import { piTuiConfigPath, providerAccessConfigured } from "./credentials.ts";

export const PROVIDERS_CREDENTIALS_ROW_ID = "provider-usage.credentials";

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
