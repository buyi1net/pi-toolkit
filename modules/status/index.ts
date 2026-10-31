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

	const runtime: StatusMenuRuntime = { reapply: () => {} };

	return {
		id: STATUS_MODULE_ID,
		labelKey: "module.status.label",
		descriptionKey: "module.status.description",

		group: "tui",
		pageId: "tui",
		topLevel: () => [],

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
