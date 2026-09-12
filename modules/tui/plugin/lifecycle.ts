import {
	VERSION,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type {
	EditorTheme,
	TUI,
	TuiMainScreenRenderState,
} from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { PiTuiHeader } from "../renderer/header.ts";
import { resolveGlyphs } from "../renderer/icons.ts";
import { registerTurnTelemetryRenderers } from "../status/turn-telemetry.ts";
import {
	loadStandaloneTuiConfig,
	type LoadedPiTuiConfig,
} from "./settings-config.ts";
import { getTerminalTransitionGate, type TerminalTransitionGate } from "./transition-gate.ts";
import { RepaintRhythm } from "./repaint-rhythm.ts";
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
import type { Translator } from "../../../i18n/index.ts";
import type { ServiceRegistry } from "../../../kit/services.ts";
import { PROVIDERS_USAGE_SERVICE_NAME, type ProvidersUsageService } from "../../providers/api.ts";
import {
	STATUS_COMPACTION_SERVICE_NAME,
	STATUS_SESSION_SERVICE_NAME,
	STATUS_TIMER_SERVICE_NAME,
	STATUS_WORKSPACE_SERVICE_NAME,
	resolveStatusSettings,
	type StatusCompactionService,
	type StatusSessionService,
	type StatusTimerService,
	type StatusWorkspaceService,
} from "../../status/api.ts";

export interface PiTuiPluginDependencies {
	agentDir?: string;
	env?: Readonly<Record<string, string | undefined>>;
	loadConfig?: () => LoadedPiTuiConfig;
	transitionGate?: TerminalTransitionGate | null;
	/** 服务注册表：providers.usage 与 status.* 句柄从这里取；未传时对应区域不显示 */
	services?: ServiceRegistry;
	/** 通知文案用的译者；缺省时不发本地化通知 */
	t?: Translator;
}

/** registerPiTuiLifecycle 交回给模块的把手：菜单保存外观后靠它重装常驻 UI */
export interface PiTuiLifecycleHandle {
	/** 重读配置；常驻 UI 已安装时原子重装，返回是否重装 */
	applyConfig(): boolean;
	/** 常驻 UI 是否已安装 */
	isActive(): boolean;
}

/**
 * 插件装配与生命周期：安装/卸载 UI、接线各状态句柄、订阅会话事件。
 * 视图组件（editor/footer/设置向导）只通过数据源分组参数接收数据与回调，
 * 不反向依赖本文件；jiti 重装与模块级状态也留在本文件内。
 *
 * 工单 11：状态控制器归 status 模块（status.* 句柄），供应商控制器归 providers 模块
 * （providers.usage）；本文件只从句柄取快照、在自己的事件上触发刷新与重绘，不再 new 控制器。
 * 工单 18：外部变化（git 轮询、设置文件、供应商轮询）由统一重绘节奏（repaint-rhythm.ts）
 * 每秒检查五条快照的变更序号后补帧，本文件的宿主事件钩子仍是即时重绘那一路。
 */
export function registerPiTuiLifecycle(
	pi: ExtensionAPI,
	output: VisibleScreenOutput = process.stdout,
	dependencies: PiTuiPluginDependencies = {},
): PiTuiLifecycleHandle {
	const env = dependencies.env ?? process.env;
	const agentDir = dependencies.agentDir ?? getAgentDir();
	const readConfig = dependencies.loadConfig ?? (() => loadStandaloneTuiConfig());
	const t = dependencies.t;

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
	/** status 模块的句柄群（status 模块装配时注册；未装配时为 undefined） */
	let statusWorkspace: StatusWorkspaceService | undefined;
	let statusSession: StatusSessionService | undefined;
	let statusTimer: StatusTimerService | undefined;
	let statusCompaction: StatusCompactionService | undefined;
	/** 供应商运行态句柄（providers 模块注册；未装配时为 undefined） */
	let providerUsage: ProvidersUsageService | undefined;
	let cleanupSpinner: (() => void) | undefined;
	let installedTui: TUI | undefined;
	// 启动守卫：首次消费只触发一次 providers 模块的周期刷新。
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
	// 统一重绘节奏（工单 18）：一秒一拍检查五条快照的变更序号，有变化才重绘（闸门保护在
	// requestStatusRender 里）。计时 working、git 轮询与设置文件变化都由此上屏；
	// 宿主事件驱动的即时重绘照旧保留。
	const repaintRhythm = new RepaintRhythm({
		sources: [
			{ id: STATUS_WORKSPACE_SERVICE_NAME, read: () => statusWorkspace?.snapshot() },
			{ id: STATUS_SESSION_SERVICE_NAME, read: () => statusSession?.snapshot() },
			{ id: STATUS_TIMER_SERVICE_NAME, read: () => statusTimer?.snapshot() },
			{ id: STATUS_COMPACTION_SERVICE_NAME, read: () => statusCompaction?.snapshot() },
			{ id: PROVIDERS_USAGE_SERVICE_NAME, read: () => providerUsage?.snapshot() },
		],
		requestRender: requestStatusRender,
	});
	const resetStatusQueries = (): void => {
		transitionRevealEnabled = false;
		if (transitionRevealTimer) clearTimeout(transitionRevealTimer);
		transitionRevealTimer = undefined;
		if (deferredStatusImmediate) clearImmediate(deferredStatusImmediate);
		deferredStatusImmediate = undefined;
		statusQueriesStarted = false;
	};
	const startStatusQueries = (): void => {
		// 安装尾部的延迟补排可能早于揭示，不能让它绕过首帧屏障。
		if (statusQueriesStarted || !active || transitionGate?.isHolding()) return;
		statusQueriesStarted = true;
		// 首次消费触发 providers 模块的周期刷新；刷新完成后补一帧
		// （句柄契约只有 snapshot/refresh，变更通知由消费方自己的事件驱动）
		void providerUsage?.refresh().then(requestStatusRender);
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
		repaintRhythm.stop();
		resetStatusQueries();
		providerUsage = undefined;
		statusWorkspace = undefined;
		statusSession = undefined;
		statusTimer = undefined;
		statusCompaction = undefined;
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
		const statusSettings = statusWorkspace?.settings() ?? resolveStatusSettings(env);
		const getStatusSettings = (): ReturnType<typeof resolveStatusSettings> => statusWorkspace?.settings() ?? statusSettings;
		const getGlyphs = () => resolveGlyphs("auto", env);
		// 句柄组：控制器归 status / providers 模块（它们在自己在装配时创建），
		// tui 只取快照；模块未装配或未启用时句柄不存在，对应区域自动降级。
		// 供应商段是否使用由段位设置决定（渲染时过滤），这里不做门控。
		const usage = dependencies.services?.get<ProvidersUsageService>(PROVIDERS_USAGE_SERVICE_NAME);
		const workspace = dependencies.services?.get<StatusWorkspaceService>(STATUS_WORKSPACE_SERVICE_NAME);
		const session = dependencies.services?.get<StatusSessionService>(STATUS_SESSION_SERVICE_NAME);
		const timer = dependencies.services?.get<StatusTimerService>(STATUS_TIMER_SERVICE_NAME);
		const compaction = dependencies.services?.get<StatusCompactionService>(STATUS_COMPACTION_SERVICE_NAME);
		statusWorkspace = workspace;
		statusSession = session;
		statusTimer = timer;
		statusCompaction = compaction;
		providerUsage = usage;
		let activeTui: TUI | undefined;
		let preClearState: TuiMainScreenRenderState | undefined;
		let headerInstalled = false;
		let footerInstalled = false;
		let installedEditor: PiUiEditor | undefined;
		// 数据源分组接线：视图构造器只收分组接口；段位设置每帧读取
		// （status 模块配置改动后下一次重绘即生效）。
		const appearanceSource: StatusAppearance = { getGlyphs, getSettings: getStatusSettings };
		const providerSource: ProviderUsageSource = { getState: () => usage?.snapshot() };
		const sessionSource: SessionStatusSource = {
			getTimer: () => timer?.snapshot(),
			getSessionStatus: () => session?.snapshot(),
			getContextUsage: () => ctx.getContextUsage(),
			getContextWindow: () => ctx.model?.contextWindow,
			getAutoCompactionEnabled: () => compaction?.snapshot()?.enabled,
		};
		const projectSource: ProjectEnvironmentSource = {
			getProjectStatus: workspace ? () => workspace.snapshot() : undefined,
			getRuntimeStatus: workspace ? () => workspace.snapshot()?.runtime : undefined,
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
			resetStatusQueries();
			repaintRhythm.stop();
			installedEditor?.dispose();
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

		repaintRhythm.start();
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
			!active && !providerUsage && !statusWorkspace && !statusSession && !statusTimer && !statusCompaction &&
			!cleanupEditor && !cleanupFooter && !cleanupHeader && !cleanupSpinner
		) return;
		active = false;
		cancelModelSwitchRepaint();
		repaintRhythm.stop();
		resetStatusQueries();
		const restoreFooter = cleanupFooter;
		const restoreHeader = cleanupHeader;
		const restoreEditor = cleanupEditor;
		const restoreSpinner = cleanupSpinner;
		providerUsage = undefined;
		statusWorkspace = undefined;
		statusSession = undefined;
		statusTimer = undefined;
		statusCompaction = undefined;
		cleanupFooter = undefined;
		cleanupHeader = undefined;
		cleanupEditor = undefined;
		cleanupSpinner = undefined;
		installedTui = undefined;

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

	// 状态数据的取数策略在 status 模块；消费方在自己的事件上触发刷新，
	// 等刷新完成再补一帧（与 providers.usage 的消费形式一致）。
	pi.on("tool_execution_end", () => {
		void statusWorkspace?.refresh().then(requestStatusRender);
	});
	pi.on("model_select", (event) => {
		void providerUsage?.refresh(event.model).then(requestStatusRender);
		requestStatusRender();
		scheduleModelSwitchRepaint();
	});

	// 回合计时与遥测的事件接线归 status 模块（turn/message/agent 事件）。
	pi.on("message_end", requestStatusRender);
	pi.on("session_info_changed", requestStatusRender);
	pi.on("session_compact", requestStatusRender);
	pi.on("session_tree", requestStatusRender);

	pi.on("agent_settled", (_event, ctx) => {
		void providerUsage?.refresh(ctx.model).then(requestStatusRender);
		requestStatusRender();
	});

	pi.on("session_shutdown", (event) => {
		uninstallUi();
		if (event.reason === "quit") transitionGate?.release(false);
	});

	return { applyConfig, isActive: () => active };
}
