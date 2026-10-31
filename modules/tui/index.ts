import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { enabledField, type ModuleContext, type ModuleDefinition } from "../../kit/module.ts";
import { TUI_MODULE_ID, readTuiSection } from "./config.ts";
import { buildTuiMenuItems, buildTuiTopLevel, TUI_MENU_ITEM_ID, type TuiMenuRuntime } from "./menu.ts";
import { registerPiTuiLifecycle, type PiTuiLifecycleHandle } from "./plugin/lifecycle.ts";
import type { VisibleScreenOutput } from "./plugin/screen-transition.ts";
import type { LoadedPiTuiConfig } from "./plugin/settings-config.ts";

export { TUI_MODULE_ID } from "./config.ts";
export { TUI_MENU_ITEM_ID } from "./menu.ts";

export interface TuiModuleOptions {

	readonly agentDir?: string;

	readonly output?: VisibleScreenOutput;
}

export const __test__: { handle?: PiTuiLifecycleHandle } = {};

function loadModuleConfig(context: ModuleContext): LoadedPiTuiConfig {
	const section = readTuiSection(context.getConfig());
	return { config: section.config, warnings: section.warnings };
}

function registerTui(
	context: ModuleContext,
	options: TuiModuleOptions,
	runtime: TuiMenuRuntime,
): void {
	const agentDir = options.agentDir ?? getAgentDir();

	const handle = registerPiTuiLifecycle(context.pi, options.output ?? process.stdout, {
		agentDir,
		loadConfig: () => loadModuleConfig(context),
		services: context.services,
		t: context.t,
	});
	__test__.handle = handle;

	runtime.applyUi = () => handle.applyConfig();
}

export function createTuiModule(options: TuiModuleOptions = {}): ModuleDefinition {

	const runtime: TuiMenuRuntime = { applyUi: () => false };

	return {
		id: TUI_MODULE_ID,
		labelKey: "module.tui.label",
		descriptionKey: "module.tui.description",

		group: "tui",
		pageId: "tui",

		configSchema: {
			enabled: enabledField("module.tui.enabled.label", "module.tui.enabled.description"),
		},
		register(context): void {
			registerTui(context, options, runtime);
		},
		topLevel(context): ReturnType<typeof buildTuiTopLevel> {
			return buildTuiTopLevel(context, runtime);
		},
		menuItems(context): ReturnType<typeof buildTuiMenuItems> {
			return buildTuiMenuItems(context, runtime);
		},
	};
}

export const tuiModule: ModuleDefinition = createTuiModule();
