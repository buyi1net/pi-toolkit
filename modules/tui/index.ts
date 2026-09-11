// pi-tui 模块：把 pi-tui 的 pi 宿主侧（编辑器边框、Header、Footer、转场、
// 遥测、状态数据源、主题、配置）装进 pi-toolkit。
//
// 迁入原则是搬移优先于重写：`plugin/`、`renderer/`、`status/`、`adapter/` 是原
// pi-src 的实现（只把对 `packages/usage-*` 的 import 改走 `kernel/` 转发），
// `themes/` 是随包注册的主题 JSON。`claude-src/` 与 `packages/` 共享内核留在原仓，
// 继续支撑 claude-line 独立发布线（规格说明决策 2）。
//
// 本文件只做装配：
//   - 15 个事件钩子、常驻 UI（编辑器 / Header / Footer / 工作指示动画）由
//     registerPiTuiLifecycle 按配置安装；enabled=false 时装配器根本不调用 register
//   - 外观 / 状态 / 数据 / 高级四个子节读写 pi-toolkit.json 的 `modules.tui` 节
//   - 供应商查询凭据只读独立文件 <agentDir>/pi-tui.json（用户裁决），永不写回
//   - 服务句柄 `ui.provider-usage`：供其它模块查询供应商余额/套餐运行态（本单只注册）

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { enabledField, type ModuleContext, type ModuleDefinition } from "../../module.ts";
import { TUI_MODULE_ID, readTuiSection } from "./config.ts";
import type { UsageRuntimeState } from "./kernel/usage-node.ts";
import { buildTuiMenuItems, TUI_MENU_ITEM_ID, type TuiMenuRuntime } from "./menu.ts";
import { registerPiTuiLifecycle, type PiTuiLifecycleHandle } from "./plugin/lifecycle.ts";import type { VisibleScreenOutput } from "./plugin/screen-transition.ts";
import { loadProviderAccessFile, type LoadedPiTuiConfig } from "./plugin/settings-config.ts";

export { TUI_MODULE_ID } from "./config.ts";
export { TUI_MENU_ITEM_ID, TuiPanel } from "./menu.ts";

/** 服务句柄名（注册表要求全小写） */
export const TUI_PROVIDER_SERVICE_NAME = "ui.provider-usage";

/**
 * 供应商余额/套餐查询服务句柄：与编辑器状态栏同一份运行态数据源。
 * 本单只注册不做联动；常驻 UI 未安装（enabled=false 或非 tui 会话）时
 * snapshot() 返回 undefined，refresh() 是空操作。
 */
export interface TuiProviderUsageService {
	readonly id: "tui";
	snapshot(): UsageRuntimeState | undefined;
	refresh(): Promise<void>;
}

export interface TuiModuleOptions {
	/** pi 的配置目录（pi-toolkit.json 与只读的 pi-tui.json 都在它下面）；默认 getAgentDir() */
	readonly agentDir?: string;
	/** 终端的可见屏幕输出；默认 process.stdout */
	readonly output?: VisibleScreenOutput;
}

/** 自测钩子：最近一次 register 交回的 lifecycle 把手（生产代码不读） */
export const __test__: { handle?: PiTuiLifecycleHandle } = {};

/** 本模块认识的配置 = modules.tui 节 + 独立凭据文件里的 providerAccess */
function loadModuleConfig(context: ModuleContext, agentDir: string): LoadedPiTuiConfig {
	const section = readTuiSection(context.getConfig());
	const provider = loadProviderAccessFile(agentDir);
	return {
		config: {
			appearance: section.config.appearance,
			status: section.config.status,
			data: {
				...section.config.data,
				...(provider.access ? { providerAccess: provider.access } : {}),
			},
			advanced: section.config.advanced,
		},
		warnings: [...section.warnings, ...provider.warnings],
	};
}

function registerTui(
	context: ModuleContext,
	options: TuiModuleOptions,
	runtime: TuiMenuRuntime,
): void {
	const agentDir = options.agentDir ?? getAgentDir();

	// 宿主注入：配置完全来自本模块（modules.tui 节 + pi-tui.json 凭据文件），
	// lifecycle 不再自己找配置文件；保存后由 TuiMenuRuntime.applyUi 触发原子重装。
	const handle = registerPiTuiLifecycle(context.pi, options.output ?? process.stdout, {
		agentDir,
		loadConfig: () => loadModuleConfig(context, agentDir),
		t: context.t,
	});
	__test__.handle = handle;

	runtime.reload = () => context.reloadConfig();
	runtime.applyUi = () => handle.applyConfig();

	context.services.register(TUI_PROVIDER_SERVICE_NAME, {
		id: "tui",
		snapshot: () => handle.getProviderUsage()?.getState(),
		refresh: async () => {
			await handle.getProviderUsage()?.refresh();
		},
	} satisfies TuiProviderUsageService);
}

export function createTuiModule(options: TuiModuleOptions = {}): ModuleDefinition {
	// 菜单写盘后要让状态中枢重新读盘，并让 lifecycle 重装常驻 UI
	const runtime: TuiMenuRuntime = { reload: async () => {}, applyUi: () => false };

	return {
		id: TUI_MODULE_ID,
		labelKey: "module.tui.label",
		descriptionKey: "module.tui.description",
		group: "general",
		// schema 只放总开关；外观/状态/数据/高级是结构化配置（非 schema 键），
		// 由本模块的菜单与配置层读写。
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
