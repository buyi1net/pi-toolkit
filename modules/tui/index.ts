// pi-tui 模块：把 pi-tui 的 pi 宿主侧（编辑器边框、Header、Footer、转场、
// 遥测渲染器、主题、配置）装进 pi-toolkit。
//
// 迁入原则是搬移优先于重写：`plugin/`、`renderer/` 是原 pi-src 的实现
// （对供应商内核的 import 已改走 providers 模块），`themes/` 是随包注册的主题 JSON。
// `claude-src/` 与 `packages/` 共享内核留在原仓，继续支撑 claude-line 独立发布线
// （规格说明决策 2）。
//
// 本文件只做装配：
//   - 事件钩子与常驻 UI（编辑器 / Header / Footer / 工作指示动画）由
//     registerPiTuiLifecycle 按配置安装；enabled=false 时装配器根本不调用 register
//   - 外观 / 高级两个子节读写 pi-toolkit.json 的 `modules.tui` 节
//   - 运行态数据不再由本模块创建：供应商控制器与 `providers.usage` 句柄归 providers 模块，
//     状态数据源与 `status.*` 句柄归 status 模块（工单 10 / 11）；
//     tui 只从服务注册表取句柄消费（对应模块禁用/未装配时相应区域不显示）

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { enabledField, type ModuleContext, type ModuleDefinition } from "../../kit/module.ts";
import { TUI_MODULE_ID, readTuiSection } from "./config.ts";
import { buildTuiMenuItems, TUI_MENU_ITEM_ID, type TuiMenuRuntime } from "./menu.ts";
import { registerPiTuiLifecycle, type PiTuiLifecycleHandle } from "./plugin/lifecycle.ts";
import type { VisibleScreenOutput } from "./plugin/screen-transition.ts";
import type { LoadedPiTuiConfig } from "./plugin/settings-config.ts";

export { TUI_MODULE_ID } from "./config.ts";
export { TUI_MENU_ITEM_ID, TuiPanel } from "./menu.ts";

export interface TuiModuleOptions {
	/** pi 的配置目录（pi-toolkit.json 在它下面）；默认 getAgentDir() */
	readonly agentDir?: string;
	/** 终端的可见屏幕输出；默认 process.stdout */
	readonly output?: VisibleScreenOutput;
}

/** 自测钩子：最近一次 register 交回的 lifecycle 把手（生产代码不读） */
export const __test__: { handle?: PiTuiLifecycleHandle } = {};

/** 本模块认识的配置 = modules.tui 节（供应商凭据归 providers 模块读取） */
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

	// 宿主注入：配置完全来自本模块（modules.tui 节），lifecycle 不再自己找配置文件；
	// 保存后由 TuiMenuRuntime.applyUi 触发原子重装。
	const handle = registerPiTuiLifecycle(context.pi, options.output ?? process.stdout, {
		agentDir,
		loadConfig: () => loadModuleConfig(context),
		services: context.services,
		t: context.t,
	});
	__test__.handle = handle;

	runtime.reload = () => context.reloadConfig();
	runtime.applyUi = () => handle.applyConfig();
}

export function createTuiModule(options: TuiModuleOptions = {}): ModuleDefinition {
	// 菜单写盘后要让状态中枢重新读盘，并让 lifecycle 重装常驻 UI
	const runtime: TuiMenuRuntime = { reload: async () => {}, applyUi: () => false };

	return {
		id: TUI_MODULE_ID,
		labelKey: "module.tui.label",
		descriptionKey: "module.tui.description",
		group: "general",
	// schema 只放总开关；外观与高级是结构化配置（非 schema 键），
	// 由本模块的菜单与配置层读写。供应商刷新间隔归 providers 模块，
	// 状态预设 / 段位与回复遥测开关归 status 模块。
		configSchema: {
			enabled: enabledField("module.tui.enabled.label", "module.tui.enabled.description"),
		},
		register(context): void {
			registerTui(context, options, runtime);
		},
		menuItems(context): ReturnType<typeof buildTuiMenuItems> {
			return buildTuiMenuItems(context, runtime);
		},
	};
}

export const tuiModule: ModuleDefinition = createTuiModule();
