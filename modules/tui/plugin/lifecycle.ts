import {
	SettingsManager,
	VERSION,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	type ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import type {
	EditorTheme,
	TUI,
	TuiMainScreenRenderState,
} from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { PiProviderUsageController } from "../adapter/provider-usage.ts";
import { PiTuiHeader } from "../renderer/header.ts";
import { resolveGlyphs } from "../renderer/icons.ts";
import {
	ProjectStatusController,
	createGitStatusQuery,
} from "../status/project-status.ts";
import {
	RuntimeStatusController,
	createRuntimeStatusDetector,
} from "../status/runtime-status.ts";
import { TurnTimerController } from "../status/status-segments.ts";
import { resolveStatusSettings } from "../status/status-config.ts";
import { collectSessionStatus } from "../status/session-status.ts";
import {
	TurnTelemetryController,
	readLatestTurnDuration,
	registerTurnTelemetryRenderers,
} from "../status/turn-telemetry.ts";
import {
	AutoCompactionStatusController,
	watchAgentSettings,
} from "../status/auto-compaction.ts";
import {
	loadStandaloneTuiConfig,
	type LoadedPiTuiConfig,
} from "./settings-config.ts";
import { getTerminalTransitionGate, type TerminalTransitionGate } from "./transition-gate.ts";
import { ensureFirstPackage } from "./package-order.ts";
import {
	flashVisibleScreen,
	isInteractiveLaunch,
	restoreVisibleMainScreen,
	TRANSITION_SETTLE_MS,
	type VisibleScreenOutput,
} from "./screen-transition.ts";
import { PiUiEditor, formatModel } from "./editor.ts";
import { ProjectStatusFooter } from "./footer.ts";
import type {
	EditorLayoutSource,
	FooterLayoutSource,
	ProjectEnvironmentSource,
	ProviderUsageSource,
	SessionStatusSource,
	StatusAppearance,
} from "./status-sources.ts";
import type { Translator } from "../../../i18n.ts";

export interface PiTuiPluginDependencies {
	agentDir?: string;
	env?: Readonly<Record<string, string | undefined>>;
	loadConfig?: () => LoadedPiTuiConfig;
	readAutoCompactionEnabled?: (ctx: ExtensionContext, agentDir: string) => boolean;
	watchAutoCompactionSettings?: (agentDir: string, onChange: () => void) => () => void;
	transitionGate?: TerminalTransitionGate | null;
	/** 通知文案用的译者；缺省时不发本地化通知 */
	t?: Translator;
}

/** registerPiTuiLifecycle 交回给模块的把手：菜单保存外观后靠它重装常驻 UI */
export interface PiTuiLifecycleHandle {
	/** 重读配置；常驻 UI 已安装时原子重装，返回是否重装 */
	applyConfig(): boolean;
	/** 常驻 UI 是否已安装 */
	isActive(): boolean;
	/** 供应商余额/套餐运行态（常驻 UI 未安装时为 undefined） */
	getProviderUsage(): PiProviderUsageController | undefined;
}

/**
 * 插件装配与生命周期：安装/卸载 UI、创建并接线各状态控制器、订阅会话事件。
 * 视图组件（editor/footer/设置向导）只通过数据源分组参数接收数据与回调，
 * 不反向依赖本文件；jiti 重装与模块级状态也留在本文件内。
 */
export function registerPiTuiLifecycle(
	pi: ExtensionAPI,
	output: VisibleScreenOutput = process.stdout,
	dependencies: PiTuiPluginDependencies = {},
): PiTuiLifecycleHandle {
	const env = dependencies.env ?? process.env;
	const agentDir = dependencies.agentDir ?? getAgentDir();
	const readConfig = dependencies.loadConfig ?? (() => loadStandaloneTuiConfig(agentDir));
	const t = dependencies.t;
	const watchAutoCompactionSettings = dependencies.watchAutoCompactionSettings ?? watchAgentSettings;
	const readAutoCompactionEnabled = dependencies.readAutoCompactionEnabled ?? ((ctx: ExtensionContext) => {
		try {
			return SettingsManager.create(ctx.cwd, agentDir, {
				projectTrusted: ctx.isProjectTrusted?.() ?? false,
			}).getCompactionEnabled();
		} catch {
			return false;
		}
	});

	let loadedConfig = readConfig();
	let currentConfig = loadedConfig.config;
	let configWarningsShown = false;
	let active = false;
	/** 当前安装是否含底部状态栏；无 Footer 时转场闸门与状态查询不等 footerData 连接 */
	let footerEnabled = true;
	let lastContext: ExtensionContext | undefined;
	let cleanupEditor: (() => void) | undefined;
	let cleanupFooter: (() => void) | undefined;
	let cleanupHeader: (() => void) | undefined;
	let projectStatus: ProjectStatusController | undefined;
	let runtimeStatus: RuntimeStatusController | undefined;
	let providerUsage: PiProviderUsageController | undefined;
	let turnTimer: TurnTimerController | undefined;
	let autoCompactionStatus: AutoCompactionStatusController | undefined;
	let cleanupSpinner: (() => void) | undefined;
	const turnTelemetry = new TurnTelemetryController({
		isEnabled: () => currentConfig.data.telemetry,
		getTimer: () => turnTimer,
		appendEntry: (customType, data) => pi.appendEntry(customType, data),
	});
	let installedTui: TUI | undefined;
	// 启动守卫跨 UI 工厂共享，避免宿主重建 Footer 后查询状态失步。
	let projectConnection: { footerData: ReadonlyFooterDataProvider } | undefined;
	let statusQueriesStarted = false;
	let deferredStatusImmediate: ReturnType<typeof setImmediate> | undefined;
	let modelSwitchRepaintImmediate: ReturnType<typeof setImmediate> | undefined;
	const cancelModelSwitchRepaint = (): void => {
		if (!modelSwitchRepaintImmediate) return;
		clearImmediate(modelSwitchRepaintImmediate);
		modelSwitchRepaintImmediate = undefined;
	};
	const scheduleModelSwitchRepaint = (): void => {
		if (modelSwitchRepaintImmediate) return;
		modelSwitchRepaintImmediate = setImmediate(() => {
			modelSwitchRepaintImmediate = undefined;
			const tui = installedTui;
			// 模型事件可能早于宿主关闭选择器；等当前宿主调用栈结束后，
			// 只对仍然活跃且未处于 reload 过渡的主屏做可见区安全重绘。
			if (!active || !tui || transitionGate?.isHolding()) return;
			restoreVisibleMainScreen(tui);
		});
		modelSwitchRepaintImmediate.unref?.();
	};
	// 编辑框 factory 链：原子重装时“恢复目标”必须仍是本插件首次安装前的 factory，
	// 不能错记成自己上一次的 ownFactory（否则真卸载时会重建已废弃的旧编辑框）。
	type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
	let originalEditorFactory: EditorFactory | undefined;
	let lastOwnEditorFactory: EditorFactory | undefined;
	// 当前已安装的编辑框实例：闭包外持有，原子重装时 dispose 旧实例（自动补全
	// Overlay 挂在 TUI 上，不 dispose 会残留）。
	let installedEditorRef: PiUiEditor | undefined;
	const transitionGate: TerminalTransitionGate | undefined = dependencies.transitionGate === null
		? undefined
		: dependencies.transitionGate ?? (
			output === process.stdout && isInteractiveLaunch() ? getTerminalTransitionGate() : undefined
		);
	const requestStatusRender = () => {
		if (transitionGate?.isHolding()) return;
		installedTui?.requestRender();
	};
	let transitionRevealEnabled = true;
	let transitionRevealTimer: ReturnType<typeof setTimeout> | undefined;
	// Footer 首帧回报：模块级，供揭示门槛读取（installUi 闭包外）。
	const layoutState = { footerHeight: 0 };
	const connectProjectStatus = (): void => {
		if (!projectConnection) return;
		projectStatus?.connect(projectConnection.footerData, requestStatusRender);
		runtimeStatus?.connect(requestStatusRender);
	};
	const disconnectProjectStatus = (): void => {
		if (!projectConnection) return;
		projectConnection = undefined;
		statusQueriesStarted = false;
		projectStatus?.disconnect();
		runtimeStatus?.disconnect();
	};
	const disposeProjectStatus = (): void => {
		transitionRevealEnabled = false;
		if (transitionRevealTimer) clearTimeout(transitionRevealTimer);
		transitionRevealTimer = undefined;
		if (deferredStatusImmediate) clearImmediate(deferredStatusImmediate);
		deferredStatusImmediate = undefined;
		statusQueriesStarted = false;
		disconnectProjectStatus();
		projectStatus?.dispose();
		runtimeStatus?.dispose();
		projectStatus = undefined;
		runtimeStatus = undefined;
	};
	const startStatusQueries = (): void => {
		// 安装尾部的延迟补排可能早于揭示，不能让它绕过首帧屏障。
		if (statusQueriesStarted || !active || transitionGate?.isHolding()) return;
		// 无 Footer 时没有 footerData 可接，但供应商刷新等状态查询仍要启动。
		if (footerEnabled && !projectConnection) return;
		statusQueriesStarted = true;
		connectProjectStatus();
		void providerUsage?.start();
	};
	const scheduleStatusQueries = (): void => {
		if (statusQueriesStarted || deferredStatusImmediate) return;
		deferredStatusImmediate = setImmediate(() => {
			deferredStatusImmediate = undefined;
			startStatusQueries();
		});
		deferredStatusImmediate.unref?.();
	};
	const scheduleTransitionReveal = (tui: TUI): void => {
		if (!transitionRevealEnabled || !transitionGate?.isHolding()) return;
		// 揭示门槛：Editor 稳定帧 + Footer 已出过首帧。只等 Editor 会让揭示帧
		// 缺 Footer（dock 尚未调用 Footer 渲染），揭示后 Footer 补帧造成二次跳变。
		// 未安装 Footer（appearance.footer=false）时没有首帧可等，只等 Editor。
		if (footerEnabled && layoutState.footerHeight < 1) return;
		if (transitionRevealTimer) clearTimeout(transitionRevealTimer);
		transitionRevealTimer = setTimeout(() => {
			transitionRevealTimer = undefined;
			if (!transitionRevealEnabled || !transitionGate.isHolding()) return;
			if (footerEnabled && layoutState.footerHeight < 1) return;
			transitionGate.reveal(tui);
			startStatusQueries();
		}, TRANSITION_SETTLE_MS);
		transitionRevealTimer.unref?.();
	};
	registerTurnTelemetryRenderers(pi, () => resolveGlyphs("auto", env));

	const disposeInstalledControllers = (): void => {
		cancelModelSwitchRepaint();
		installedEditorRef?.dispose();
		installedEditorRef = undefined;
		turnTimer?.dispose();
		autoCompactionStatus?.dispose();
		providerUsage?.dispose();
		disposeProjectStatus();
		turnTimer = undefined;
		autoCompactionStatus = undefined;
		providerUsage = undefined;
		cleanupFooter = undefined;
		cleanupHeader = undefined;
		cleanupEditor = undefined;
		cleanupSpinner = undefined;
		installedTui = undefined;
	};

	const installUi = (ctx: ExtensionContext): void => {
		if (active) {
			// 原子重装（设置保存后）：只 dispose 控制器，不把组件恢复成 Pi 默认——
			// “恢复默认→再装自定义”的往返会让 dock 高度抖动，把 transcript 行推进
			// 滚动缓冲形成残影；组件由本次安装直接覆盖，高度最多变化一次。
			active = false;
			disposeInstalledControllers();
		}
		transitionRevealEnabled = true;
		if (transitionRevealTimer) clearTimeout(transitionRevealTimer);
		transitionRevealTimer = undefined;
		footerEnabled = currentConfig.appearance.footer;
		const currentFactory = ctx.ui.getEditorComponent();
		// 恢复目标：当前生效的是自己上次的 factory 时沿用最初的 factory。
		const previousFactory = currentFactory !== undefined && currentFactory === lastOwnEditorFactory
			? originalEditorFactory
			: currentFactory;
		originalEditorFactory = previousFactory;
		const statusSettings = resolveStatusSettings(env, {
			preset: currentConfig.status.preset,
			segments: currentConfig.status.segments,
		});
		const autoCompaction = currentConfig.appearance.editor && statusSettings.footerUsage.includes("context")
			? new AutoCompactionStatusController(
				() => readAutoCompactionEnabled(ctx, agentDir),
				(onChange) => watchAutoCompactionSettings(agentDir, onChange),
				requestStatusRender,
			)
			: undefined;
		autoCompactionStatus = autoCompaction;
		const getGlyphs = () => resolveGlyphs("auto", env);
		const timer = statusSettings.editorLeft.includes("duration")
			? new TurnTimerController(
				requestStatusRender,
				1_000,
				Date.now,
				readLatestTurnDuration(ctx.sessionManager?.getEntries?.() ?? []),
			)
			: undefined;
		const usage = statusSettings.editorLeft.some((segment) =>
			segment === "provider" || segment === "balance" || segment === "subscription"
		)
			? new PiProviderUsageController(ctx, requestStatusRender, {
				refreshMs: currentConfig.data.providerRefreshMs,
				accessConfig: currentConfig.data.providerAccess,
			})
			: undefined;
		const runtime = statusSettings.footerPrimary.includes("runtime")
			? new RuntimeStatusController(ctx.cwd,
				createRuntimeStatusDetector(
					async (command, args, commandCwd, commandSignal) => {
						const result = await pi.exec(command, [...args], {
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
			)
			: undefined;
		const controller = statusSettings.footerPrimary.includes("git")
			? new ProjectStatusController(ctx.cwd, createGitStatusQuery(pi.exec.bind(pi)))
			: undefined;
		projectStatus = controller;
		runtimeStatus = runtime;
		let activeTui: TUI | undefined;
		let preClearState: TuiMainScreenRenderState | undefined;
		let headerInstalled = false;
		let footerInstalled = false;
		let installedEditor: PiUiEditor | undefined;
		// 数据源分组接线：视图构造器只收分组接口；控制器刷新回调（供应商刷新、
		// 转场闸门等模块级状态）留在装配层，不外泄到视图构造接口。
		const appearanceSource: StatusAppearance = { getGlyphs, settings: statusSettings };
		const providerSource: ProviderUsageSource = usage ? { getState: () => usage.getState() } : {};
		const sessionSource: SessionStatusSource = {
			getTimer: () => timer?.getSnapshot() ?? { state: "idle", elapsedMs: 0 },
			getSessionStatus: () => collectSessionStatus(ctx.sessionManager),
			getContextUsage: () => ctx.getContextUsage(),
			getContextWindow: () => ctx.model?.contextWindow,
			getAutoCompactionEnabled: () => autoCompaction?.getSnapshot() ?? false,
		};
		const projectSource: ProjectEnvironmentSource = {
			getProjectStatus: controller ? () => controller.getSnapshot() : undefined,
			getRuntimeStatus: runtime ? () => runtime.getSnapshot() : undefined,
			cwd: ctx.cwd,
		};
		const editorLayoutSource: EditorLayoutSource = { getFooterHeight: () => layoutState.footerHeight };
		const footerLayoutSource: FooterLayoutSource = {
			reportHeight: (height) => { layoutState.footerHeight = height; },
		};
		const ownFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => {
			activeTui = tui;
			installedTui = tui;
			// 实例级拦截：挂到宿主真实 terminal（prototype patch 因 jiti 双副本无效）。
			transitionGate?.hookTerminal(tui.terminal);
			const editor = new PiUiEditor(
				tui,
				theme,
				keybindings,
				ctx,
				appearanceSource,
				providerSource,
				sessionSource,
				editorLayoutSource,
				{
					onReloadSubmit: () => {
						transitionRevealEnabled = false;
						transitionGate?.hold(tui, { clearVisibleScreen: true });
					},
					onFrameRendered: () => {
						// 闸门存在但已不在 holding（曾被提前释放或已揭示）时，
						// 旧逻辑两个分支都不执行，状态查询永不启动；这里兜底直启。
						if (transitionGate?.isHolding() && transitionRevealEnabled) scheduleTransitionReveal(tui);
						else scheduleStatusQueries();
					},
				},
			);
			installedEditor?.dispose();
			installedEditor = editor;
			installedEditorRef = editor;
			if (!transitionGate) preClearState = flashVisibleScreen(tui, output);
			return editor;
		};
		lastOwnEditorFactory = ownFactory;

		try {
			if (currentConfig.appearance.editor) ctx.ui.setEditorComponent(ownFactory);
			// Pi 正式 TUI 提供 setHeader；精简宿主桩或旧宿主没有该能力时跳过 Header。
			if (currentConfig.appearance.header && typeof ctx.ui.setHeader === "function") {
				ctx.ui.setHeader((tui) => new PiTuiHeader(
					() => ({
						version: VERSION,
						model: formatModel(ctx),
						thinking: ctx.thinkingLevel ?? "off",
						cwd: ctx.cwd,
					}),
					() => ctx.ui.theme,
					getGlyphs,
					tui.requestRender.bind(tui),
				));
				headerInstalled = true;
			}
			if (currentConfig.appearance.footer) {
				footerInstalled = true;
				ctx.ui.setFooter((tui, theme, footerData) => {
					activeTui ??= tui;
					installedTui = tui;
					disconnectProjectStatus();
					const connection = { footerData };
					projectConnection = connection;
					const installedFooter = new ProjectStatusFooter(
						tui,
						theme,
						footerData,
						appearanceSource,
						projectSource,
						sessionSource,
						footerLayoutSource,
						{
							beforeDispose: () => {
								transitionGate?.hold(tui);
								// 宿主可能先创建替代 Footer 再卸载旧实例，旧回调不能断开新连接。
								if (projectConnection !== connection) return;
								disconnectProjectStatus();
							},
						},
					);
					// 宿主重建 Footer 不会重跑安装；换绑数据源仍需经过同一个揭示屏障。
					if (active) scheduleStatusQueries();
					// 闸门 holding 期间 dock 不跑、Footer 首帧不产生，揭示门槛会永久等待。
					// 工厂内主动渲染一次回报高度，解锁揭示；dock 接管后的渲染不受影响。
					if (transitionGate?.isHolding()) {
						installedFooter.render(Math.max(1, tui.terminal.columns));
					}
					return installedFooter;
				});
			}
			if (currentConfig.advanced.spinner === "hidden") {
				ctx.ui.setWorkingVisible?.(false);
			} else {
				ctx.ui.setWorkingVisible?.(true);
				ctx.ui.setWorkingIndicator?.(
					currentConfig.advanced.spinner === "static" ? { frames: ["●"] } : undefined,
				);
			}
			if (!transitionGate && activeTui && preClearState) {
				restoreVisibleMainScreen(activeTui, preClearState, true);
			}
		} catch (error) {
			disposeProjectStatus();
			installedEditor?.dispose();
			autoCompaction?.dispose();
			if (autoCompactionStatus === autoCompaction) autoCompactionStatus = undefined;
			timer?.dispose();
			usage?.dispose();
			ctx.ui.setWorkingIndicator?.();
			ctx.ui.setWorkingVisible?.(true);
			try {
				if (footerInstalled) ctx.ui.setFooter(undefined);
			} finally {
				try {
					if (headerInstalled) ctx.ui.setHeader(undefined);
				} finally {
					if (currentConfig.appearance.editor && ctx.ui.getEditorComponent() === ownFactory) {
						ctx.ui.setEditorComponent(previousFactory);
					}
				}
			}
			if (activeTui && preClearState) {
				restoreVisibleMainScreen(activeTui, preClearState);
			}
			if (transitionGate?.isHolding()) {
				if (activeTui) transitionGate.reveal(activeTui);
				else transitionGate.release(true);
			}
			throw error;
		}

		providerUsage = usage;
		turnTimer = timer;
		cleanupEditor = currentConfig.appearance.editor ? () => {
			installedEditor?.dispose();
			installedEditor = undefined;
			if (ctx.ui.getEditorComponent() === ownFactory) {
				ctx.ui.setEditorComponent(previousFactory);
			}
		} : undefined;
		cleanupFooter = footerInstalled ? () => ctx.ui.setFooter(undefined) : undefined;
		cleanupHeader = headerInstalled ? () => ctx.ui.setHeader(undefined) : undefined;
		cleanupSpinner = () => {
			ctx.ui.setWorkingIndicator?.();
			ctx.ui.setWorkingVisible?.(true);
		};
		active = true;
		// 帧回调可能早于安装尾部，补排一次以免查询错过 active 切换。
		scheduleStatusQueries();
		// 没有自定义 Editor 时没有首帧回调可用：先释放闸门再同步启动状态查询。
		if (!currentConfig.appearance.editor) {
			if (transitionGate?.isHolding()) {
				if (activeTui) transitionGate.reveal(activeTui);
				else transitionGate.release(false);
			}
			startStatusQueries();
		}
	};

	const uninstallUi = (): void => {
		if (
			!active && !projectStatus && !runtimeStatus && !providerUsage && !turnTimer && !autoCompactionStatus &&
			!cleanupEditor && !cleanupFooter && !cleanupHeader && !cleanupSpinner
		) return;
		active = false;
		cancelModelSwitchRepaint();
		const usage = providerUsage;
		const timer = turnTimer;
		const autoCompaction = autoCompactionStatus;
		const restoreFooter = cleanupFooter;
		const restoreHeader = cleanupHeader;
		const restoreEditor = cleanupEditor;
		const restoreSpinner = cleanupSpinner;
		disposeProjectStatus();
		providerUsage = undefined;
		turnTimer = undefined;
		autoCompactionStatus = undefined;
		cleanupFooter = undefined;
		cleanupHeader = undefined;
		cleanupEditor = undefined;
		cleanupSpinner = undefined;
		installedTui = undefined;

		timer?.dispose();
		autoCompaction?.dispose();
		usage?.dispose();
		try {
			restoreFooter?.();
		} finally {
			try {
				restoreHeader?.();
			} finally {
				try {
					restoreEditor?.();
				} finally {
					restoreSpinner?.();
				}
			}
		}
	};

	/** 菜单保存外观后重读配置并原子重装常驻 UI；未安装时只更新内存副本 */
	const applyConfig = (): boolean => {
		loadedConfig = readConfig();
		currentConfig = loadedConfig.config;
		if (active && lastContext) {
			installUi(lastContext);
			return true;
		}
		return false;
	};

	/** 供应商余额/套餐运行态句柄（服务注册表用；未安装时为 undefined） */
	const getProviderUsage = (): PiProviderUsageController | undefined => providerUsage;

	let pendingOrderNotice: ReturnType<typeof setTimeout> | undefined;
	pi.on("session_start", (event, ctx) => {
		lastContext = ctx;
		// 包顺序自调：调整只做一次（下次启动已在前），失败静默。notify 延迟
		// 到揭示完成后（约 1s）再发，避免闸门 holding 期间被最终帧覆盖。
		if (event.reason !== "reload") {
			if (ensureFirstPackage(agentDir, env).adjusted && !pendingOrderNotice) {
				pendingOrderNotice = setTimeout(() => {
					pendingOrderNotice = undefined;
					ctx.ui.notify?.(
						t?.("module.tui.packageOrder.notice")
							?? "pi-toolkit was moved to the front of the startup package list; restart Pi to apply",
						"info",
					);
				}, 2_500);
				pendingOrderNotice.unref?.();
			}
		}
		if (ctx.mode !== "tui") {
			transitionGate?.release(true);
			return;
		}
		// 首次启动必须等宿主完成项目 Trust 等启动前交互后再清屏；过早 hold()
		// 会把宿主授权界面擦掉。session_start 时宿主 UI 已完全启动，清屏并
		// 拦帧到插件界面原子揭示（与 OpenTUI 的过渡页策略对齐）。
		if (!active) {
			transitionGate?.hold(installedTui, { clearVisibleScreen: true });
		}
		if (active) {
			transitionRevealEnabled = true;
			installedTui?.requestRender(true);
			return;
		}
		if (!configWarningsShown && loadedConfig.warnings.length > 0) {
			configWarningsShown = true;
			ctx.ui.notify(loadedConfig.warnings.join("\n"), "warning");
		}
		installUi(ctx);
	});

	pi.on("tool_execution_end", () => {
		projectStatus?.requestRefresh();
		runtimeStatus?.requestRefresh();
	});
	pi.on("model_select", (event) => {
		void providerUsage?.refresh(event.model);
		requestStatusRender();
		scheduleModelSwitchRepaint();
	});

	pi.on("turn_start", (event) => turnTelemetry.handle(event));
	pi.on("message_start", (event) => turnTelemetry.handle(event));
	pi.on("message_update", (event) => turnTelemetry.handle(event));
	pi.on("message_end", (event) => {
		turnTelemetry.handle(event);
		requestStatusRender();
	});
	pi.on("turn_end", (event) => turnTelemetry.handle(event));
	pi.on("session_info_changed", requestStatusRender);
	pi.on("session_compact", requestStatusRender);
	pi.on("session_tree", requestStatusRender);

	pi.on("agent_start", (event) => turnTelemetry.handle(event));
	pi.on("agent_end", (event) => turnTelemetry.handle(event));
	pi.on("agent_settled", (event, ctx) => {
		void providerUsage?.refresh(ctx.model);
		turnTelemetry.settle(event, ctx.mode);
	});

	pi.on("session_shutdown", (event) => {
		turnTelemetry.reset();
		uninstallUi();
		if (event.reason === "quit") transitionGate?.release(false);
	});

	return { applyConfig, isActive: () => active, getProviderUsage };
}
