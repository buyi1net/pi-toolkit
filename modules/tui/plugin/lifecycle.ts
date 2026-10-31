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
import { formatElapsed } from "../status/status-segments.ts";
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
	COMPRESSION_STATUS_SERVICE_NAME,
	type CompressionStatusService,
} from "../../compression/api.ts";
import {
	STATUS_COMPACTION_SERVICE_NAME,
	STATUS_SESSION_SERVICE_NAME,
	STATUS_TELEMETRY_SERVICE_NAME,
	STATUS_TIMER_SERVICE_NAME,
	STATUS_WORKSPACE_SERVICE_NAME,
	resolveStatusSettings,
	type StatusCompactionService,
	type StatusSessionService,
	type StatusTelemetryService,
	type StatusTimerService,
	type StatusWorkspaceService,
} from "../../status/api.ts";

export function formatWorkingMessage(
	tokensPerSecond: number | null | undefined,
	elapsedMs?: number,
): string {
	const speed = tokensPerSecond !== null && tokensPerSecond !== undefined && Number.isFinite(tokensPerSecond)
		? tokensPerSecond
		: 0;
	const elapsed = elapsedMs !== undefined && Number.isFinite(elapsedMs) && elapsedMs >= 0
		? ` · ${formatElapsed(elapsedMs)}`
		: "";
	return `Working${elapsed} · ${speed.toString()} tok/s`;
}

export interface PiTuiPluginDependencies {
	agentDir?: string;
	env?: Readonly<Record<string, string | undefined>>;
	loadConfig?: () => LoadedPiTuiConfig;
	transitionGate?: TerminalTransitionGate | null;

	services?: ServiceRegistry;

	t?: Translator;
}

export interface PiTuiLifecycleHandle {

	applyConfig(): boolean;

	isActive(): boolean;
}

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

	let footerEnabled = true;
	let lastContext: ExtensionContext | undefined;
	let cleanupEditor: (() => void) | undefined;
	let cleanupFooter: (() => void) | undefined;
	let cleanupHeader: (() => void) | undefined;

	let statusWorkspace: StatusWorkspaceService | undefined;
	let statusSession: StatusSessionService | undefined;
	let statusTimer: StatusTimerService | undefined;
	let statusTelemetry: StatusTelemetryService | undefined;
	let statusCompaction: StatusCompactionService | undefined;

	let providerUsage: ProvidersUsageService | undefined;

	let compressionStatus: CompressionStatusService | undefined;
	let cleanupSpinner: (() => void) | undefined;
	let installedTui: TUI | undefined;

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

			if (!active || !tui || transitionGate?.isHolding()) return;
			restoreVisibleMainScreen(tui);
		});
		modelSwitchRepaintImmediate.unref?.();
	};

	type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
	let originalEditorFactory: EditorFactory | undefined;
	let lastOwnEditorFactory: EditorFactory | undefined;

	let installedEditorRef: PiUiEditor | undefined;
	const transitionGate: TerminalTransitionGate | undefined = dependencies.transitionGate === null
		? undefined
		: dependencies.transitionGate ?? (
			output === process.stdout && isInteractiveLaunch() ? getTerminalTransitionGate() : undefined
		);
	const updateWorkingMessage = (
		ctx: ExtensionContext | undefined,
		timerSnapshot = statusTimer?.snapshot(),
	): void => {
		if (!ctx) return;
		const elapsedMs = timerSnapshot?.state === "working" ? timerSnapshot.elapsedMs : undefined;
		ctx.ui.setWorkingMessage?.(formatWorkingMessage(statusTelemetry?.liveSnapshot()?.tokensPerSecond, elapsedMs));
	};
	const requestStatusRender = () => {
		if (transitionGate?.isHolding()) return;
		const timerSnapshot = statusTimer?.snapshot();
		if (timerSnapshot?.state === "working") updateWorkingMessage(lastContext, timerSnapshot);
		installedTui?.requestRender();
	};
	let transitionRevealEnabled = true;
	let transitionRevealTimer: ReturnType<typeof setTimeout> | undefined;

	const layoutState = { footerHeight: 0 };

	const repaintRhythm = new RepaintRhythm({
		sources: [
			{ id: STATUS_WORKSPACE_SERVICE_NAME, read: () => statusWorkspace?.snapshot() },
			{ id: STATUS_SESSION_SERVICE_NAME, read: () => statusSession?.snapshot() },
			{ id: STATUS_TIMER_SERVICE_NAME, read: () => statusTimer?.snapshot() },
			{ id: STATUS_COMPACTION_SERVICE_NAME, read: () => statusCompaction?.snapshot() },
			{ id: COMPRESSION_STATUS_SERVICE_NAME, read: () => compressionStatus?.snapshot() },
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

		if (statusQueriesStarted || !active || transitionGate?.isHolding()) return;
		statusQueriesStarted = true;

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
	registerTurnTelemetryRenderers(pi);

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
		statusTelemetry = undefined;
		statusCompaction = undefined;
		compressionStatus = undefined;
		cleanupFooter = undefined;
		cleanupHeader = undefined;
		cleanupEditor = undefined;
		cleanupSpinner = undefined;
		installedTui = undefined;
	};

	const installUi = (ctx: ExtensionContext): void => {
		if (active) {

			active = false;
			disposeInstalledControllers();
		}
		transitionRevealEnabled = true;
		if (transitionRevealTimer) clearTimeout(transitionRevealTimer);
		transitionRevealTimer = undefined;
		footerEnabled = currentConfig.appearance.footer;
		const currentFactory = ctx.ui.getEditorComponent();

		const previousFactory = currentFactory !== undefined && currentFactory === lastOwnEditorFactory
			? originalEditorFactory
			: currentFactory;
		originalEditorFactory = previousFactory;
		const statusSettings = statusWorkspace?.settings() ?? resolveStatusSettings(env);
		const getStatusSettings = (): ReturnType<typeof resolveStatusSettings> => statusWorkspace?.settings() ?? statusSettings;
		const getGlyphs = () => resolveGlyphs("auto", env);

		const usage = dependencies.services?.get<ProvidersUsageService>(PROVIDERS_USAGE_SERVICE_NAME);
		const workspace = dependencies.services?.get<StatusWorkspaceService>(STATUS_WORKSPACE_SERVICE_NAME);
		const session = dependencies.services?.get<StatusSessionService>(STATUS_SESSION_SERVICE_NAME);
		const timer = dependencies.services?.get<StatusTimerService>(STATUS_TIMER_SERVICE_NAME);
		const telemetry = dependencies.services?.get<StatusTelemetryService>(STATUS_TELEMETRY_SERVICE_NAME);
		const compaction = dependencies.services?.get<StatusCompactionService>(STATUS_COMPACTION_SERVICE_NAME);
		const compression = dependencies.services?.get<CompressionStatusService>(COMPRESSION_STATUS_SERVICE_NAME);
		statusWorkspace = workspace;
		statusSession = session;
		statusTimer = timer;
		statusTelemetry = telemetry;
		statusCompaction = compaction;
		compressionStatus = compression;
		providerUsage = usage;
		let activeTui: TUI | undefined;
		let preClearState: TuiMainScreenRenderState | undefined;
		let headerInstalled = false;
		let footerInstalled = false;
		let installedEditor: PiUiEditor | undefined;

		const appearanceSource: StatusAppearance = { getGlyphs, getSettings: getStatusSettings };
		const providerSource: ProviderUsageSource = { getState: () => usage?.snapshot() };
		const sessionSource: SessionStatusSource = {
			getTimer: () => timer?.snapshot(),
			getSessionStatus: () => session?.snapshot(),
			getSessionId: () => ctx.sessionManager.getSessionId(),
			getContextUsage: () => ctx.getContextUsage(),
			getContextWindow: () => ctx.model?.contextWindow,
			getCompressionLabel: (compact: boolean) => compression?.label(compact) ?? "",
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

					if (active) scheduleStatusQueries();

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
			ctx.ui.setWorkingMessage?.();
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
			ctx.ui.setWorkingMessage?.();
			ctx.ui.setWorkingVisible?.(true);
		};
		active = true;

		scheduleStatusQueries();

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
			!active && !providerUsage && !statusWorkspace && !statusSession && !statusTimer && !statusTelemetry && !statusCompaction &&
			!compressionStatus &&
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
		statusTelemetry = undefined;
		statusCompaction = undefined;
		compressionStatus = undefined;
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
		void statusWorkspace?.refresh().then(requestStatusRender);
	});
	pi.on("model_select", (event) => {
		void providerUsage?.refresh(event.model).then(requestStatusRender);
		requestStatusRender();
		scheduleModelSwitchRepaint();
	});

	pi.on("turn_start", (_event, ctx) => {
		if (!active) return;
		updateWorkingMessage(ctx);
		requestStatusRender();
	});
	pi.on("message_update", (_event, ctx) => {
		if (!active) return;
		updateWorkingMessage(ctx);
		requestStatusRender();
	});

	pi.on("message_end", (_event, ctx) => {
		if (active) {
			updateWorkingMessage(ctx);
			requestStatusRender();
		}
	});
	pi.on("session_info_changed", requestStatusRender);
	pi.on("session_compact", requestStatusRender);
	pi.on("session_tree", requestStatusRender);

	pi.on("agent_settled", (_event, ctx) => {
		ctx.ui.setWorkingMessage?.();
		void providerUsage?.refresh(ctx.model).then(requestStatusRender);
		requestStatusRender();
	});

	pi.on("session_shutdown", (event) => {
		uninstallUi();
		if (event.reason === "quit") transitionGate?.release(false);
	});

	return { applyConfig, isActive: () => active };
}
