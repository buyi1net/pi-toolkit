// status 模块实现入口：控制器创建、`status.*` 五个句柄注册、会话绑定与事件接线（工单 11）。
//
// 分工（工单 07 定案 2 + 定案 7）：
// - 控制器在模块装配时创建、随会话绑定重建；注册句柄后 tui lifecycle 只从句柄取快照；
// - 取数策略（什么时候刷 git / 运行时、哪些段位启用）留在本模块；
// - 重绘节奏属于 tui：控制器的 requestRender 传空操作，tui 侧按自己的心跳读快照重绘
//   （句柄契约只有 snapshot/refresh，变更通知由消费方自己的事件与心跳驱动）。
//
// 事件接线：session_start 绑定会话并按段位创建控制器；session_shutdown 释放；
// 回合计时与遥测由 turn/agent 事件驱动。工具执行后的数据刷新由消费方
// （tui 的 tool_execution_end 处理器）调句柄 refresh() 触发，取数策略仍在控制器内部
// （防抖、在途合并、1 秒轮询），与 providers.usage 的消费形式一致。

import { SettingsManager, getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModuleContext } from "../../kit/module.ts";
import {
	STATUS_COMPACTION_SERVICE_NAME,
	STATUS_SESSION_SERVICE_NAME,
	STATUS_TELEMETRY_SERVICE_NAME,
	STATUS_TIMER_SERVICE_NAME,
	STATUS_WORKSPACE_SERVICE_NAME,
	type StatusCompactionService,
	type StatusSessionService,
	type StatusTelemetryService,
	type StatusTimerService,
	type StatusWorkspaceService,
} from "./api.ts";
import { AutoCompactionStatusController, watchAgentSettings } from "./auto-compaction.ts";
import { ProjectStatusController, createGitStatusQuery } from "./project-status.ts";
import { RuntimeStatusController, createRuntimeStatusDetector } from "./runtime-status.ts";
import { collectSessionStatus } from "./session-status.ts";
import {
	readStatusSection,
	statusSettingsFromSection,
	type ResolvedStatusSettings,
} from "./status-config.ts";
import { TurnTelemetryController, readLatestTurnDuration } from "./turn-telemetry.ts";
import { TurnTimerController } from "./turn-timer.ts";

export interface StatusModuleOptions {
	/** pi 的配置目录（settings.json 在这里，自动压缩开关从它读）；默认 getAgentDir() */
	readonly agentDir?: string;
	/** 环境变量面（PI_UI_STATUS_PRESET / PI_UI_STATUS_SEGMENTS 段位覆盖）；默认 process.env */
	readonly env?: Readonly<Record<string, string | undefined>>;
	/** 自测钩子：自动压缩开关读取；默认读宿主 SettingsManager */
	readonly readAutoCompactionEnabled?: (ctx: ExtensionContext, agentDir: string) => boolean;
	/** 自测钩子：设置文件监听；默认 watchAgentSettings */
	readonly watchAutoCompactionSettings?: (agentDir: string, onChange: () => void) => () => void;
}

/** 菜单写盘后要触发的模块侧动作（模块装配时填入，菜单行闭包持用） */
export interface StatusMenuRuntime {
	/** 重载状态中枢的内存副本，让 getConfig() 跟上磁盘 */
	reload: () => Promise<void>;
	/** 段位设置变化后重建控制器（纯数据侧，不碰 UI） */
	reapply: () => void;
}

export function registerStatus(
	context: ModuleContext,
	options: StatusModuleOptions = {},
	menuRuntime: StatusMenuRuntime = { reload: async () => {}, reapply: () => {} },
): void {
	const agentDir = options.agentDir ?? getAgentDir();
	const env = options.env ?? process.env;
	const watchSettings = options.watchAutoCompactionSettings ?? watchAgentSettings;
	const readCompactionEnabled = options.readAutoCompactionEnabled ?? ((ctx: ExtensionContext) => {
		try {
			return SettingsManager.create(ctx.cwd, agentDir, {
				projectTrusted: ctx.isProjectTrusted?.() ?? false,
			}).getCompactionEnabled();
		} catch {
			return false;
		}
	});

	let sessionContext: ExtensionContext | undefined;
	let git: ProjectStatusController | undefined;
	let runtimeStatus: RuntimeStatusController | undefined;
	let timer: TurnTimerController | undefined;
	let compaction: AutoCompactionStatusController | undefined;

	const currentConfig = () => context.getConfig();
	const currentSettings = (): ResolvedStatusSettings => statusSettingsFromSection(currentConfig(), env);

	const telemetry = new TurnTelemetryController({
		isEnabled: () => readStatusSection(currentConfig()).config.telemetry,
		getTimer: () => timer,
		appendEntry: (customType, data) => context.pi.appendEntry(customType, data),
	});

	const disposeControllers = (): void => {
		git?.dispose();
		runtimeStatus?.dispose();
		timer?.dispose();
		compaction?.dispose();
		git = undefined;
		runtimeStatus = undefined;
		timer = undefined;
		compaction = undefined;
	};

	/** 按当前段位设置重建控制器（会话绑定与菜单改设置都走这里） */
	const startControllers = (ctx: ExtensionContext): void => {
		disposeControllers();
		const settings = currentSettings();
		if (settings.footerPrimary.includes("git")) {
			git = new ProjectStatusController(ctx.cwd, createGitStatusQuery(context.pi.exec.bind(context.pi)));
			git.connect();
		}
		if (settings.footerPrimary.includes("runtime")) {
			runtimeStatus = new RuntimeStatusController(
				ctx.cwd,
				createRuntimeStatusDetector(
					async (command, args, commandCwd, commandSignal) => {
						const result = await context.pi.exec(command, [...args], {
							cwd: commandCwd,
							signal: commandSignal,
							timeout: 2500,
						});
						return {
							stdout: result.stdout,
							stderr: result.stderr,
							code: result.code,
							killed: result.killed,
						};
					},
					env,
				),
			);
			runtimeStatus.connect();
		}
		if (settings.editorLeft.includes("duration")) {
			timer = new TurnTimerController(
				() => {},
				1_000,
				Date.now,
				readLatestTurnDuration(ctx.sessionManager?.getEntries?.() ?? []),
			);
		}
		if (settings.footerUsage.includes("context")) {
			compaction = new AutoCompactionStatusController(
				() => readCompactionEnabled(ctx, agentDir),
				(onChange) => watchSettings(agentDir, onChange),
				() => {},
			);
		}
	};

	context.services.register(STATUS_WORKSPACE_SERVICE_NAME, {
		id: "status",
		snapshot: () => {
			if (!sessionContext) return undefined;
			return {
				...(git?.getSnapshot() ?? { cwd: sessionContext.cwd, branch: null }),
				runtime: runtimeStatus?.getSnapshot(),
				duration: timer?.getSnapshot(),
			};
		},
		refresh: async () => {
			await Promise.all([git?.refresh(), runtimeStatus?.refresh()]);
		},
		settings: () => currentSettings(),
	} satisfies StatusWorkspaceService);

	context.services.register(STATUS_SESSION_SERVICE_NAME, {
		id: "status",
		snapshot: () => (sessionContext ? collectSessionStatus(sessionContext.sessionManager) : undefined),
		refresh: async () => {},
	} satisfies StatusSessionService);

	context.services.register(STATUS_TIMER_SERVICE_NAME, {
		id: "status",
		snapshot: () => timer?.getSnapshot(),
		refresh: async () => {},
	} satisfies StatusTimerService);

	context.services.register(STATUS_TELEMETRY_SERVICE_NAME, {
		id: "status",
		snapshot: () => telemetry.getSnapshot(),
		refresh: async () => {},
	} satisfies StatusTelemetryService);

	context.services.register(STATUS_COMPACTION_SERVICE_NAME, {
		id: "status",
		snapshot: () => compaction?.getSnapshot(),
		refresh: async () => {
			compaction?.refresh();
		},
	} satisfies StatusCompactionService);

	menuRuntime.reload = () => context.reloadConfig();
	menuRuntime.reapply = () => {
		if (sessionContext) startControllers(sessionContext);
	};

	context.pi.on("session_start", (_event, ctx) => {
		sessionContext = ctx;
		startControllers(ctx);
	});

	context.pi.on("session_shutdown", () => {
		disposeControllers();
		telemetry.reset();
		sessionContext = undefined;
	});

	context.pi.on("turn_start", (event) => telemetry.handle(event));
	context.pi.on("message_start", (event) => telemetry.handle(event));
	context.pi.on("message_update", (event) => telemetry.handle(event));
	context.pi.on("message_end", (event) => telemetry.handle(event));
	context.pi.on("turn_end", (event) => telemetry.handle(event));
	context.pi.on("agent_start", (event) => telemetry.handle(event));
	context.pi.on("agent_end", (event) => telemetry.handle(event));
	context.pi.on("agent_settled", (event, ctx) => telemetry.settle(event, ctx.mode));
}
