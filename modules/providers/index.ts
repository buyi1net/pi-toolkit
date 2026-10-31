import { enabledField, type ModuleContext, type ModuleDefinition } from "../../kit/module.ts";
import {
	DEFAULT_PROVIDER_REFRESH_MS,
	PROVIDER_REFRESH_INTERVALS,
} from "./api.ts";
import { buildProvidersMenuItems, buildProvidersTopLevel } from "./menu.ts";
import { registerProviders, type ProvidersModuleOptions } from "./mod.ts";

export const PROVIDERS_MODULE_ID = "providers";

export {
	PROVIDERS_POOL_USAGE_SERVICE_NAME,
	PROVIDERS_USAGE_SERVICE_NAME,
	type ProvidersPoolUsageService,
	type ProvidersUsageService,
} from "./api.ts";
export type { ProvidersModuleOptions } from "./mod.ts";

const REFRESH_MS_LABEL_KEYS: Readonly<Record<string, string>> = {
	"30000": "module.providers.refresh.30",
	"60000": "module.providers.refresh.60",
	"120000": "module.providers.refresh.120",
	"300000": "module.providers.refresh.300",
};

export function createProvidersModule(options: ProvidersModuleOptions = {}): ModuleDefinition {
	return {
		id: PROVIDERS_MODULE_ID,
		labelKey: "module.providers.label",
		descriptionKey: "module.providers.description",

		group: "models",
		pageId: "providers-usage",
		configSchema: {
			enabled: enabledField("module.providers.enabled.label", "module.providers.enabled.description"),
			refreshMs: {
				default: DEFAULT_PROVIDER_REFRESH_MS,
				values: PROVIDER_REFRESH_INTERVALS.map((ms) => String(ms)),
				labelKey: "module.providers.refresh.label",
				descriptionKey: "module.providers.refresh.description",
				valueLabelKeys: REFRESH_MS_LABEL_KEYS,
			},
		},
		register(context: ModuleContext): void {
			registerProviders(context, options);
		},
		topLevel: buildProvidersTopLevel,
		menuItems(context): ReturnType<typeof buildProvidersMenuItems> {
			return buildProvidersMenuItems(context);
		},
	};
}

export const providersModule: ModuleDefinition = createProvidersModule();
