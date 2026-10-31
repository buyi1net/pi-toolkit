import { SettingsManager, getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModuleContext } from "../../kit/module.ts";
import {
	STATUS_COMPACTION_SERVICE_NAME,
	STATUS_SESSION_SERVICE_NAME,
	STATUS_TELEMETRY_SERVICE_NAME,
	STATUS_TIMER_SERVICE_NAME,
	STATUS_WORKSPACE_SERVICE_NAME,
	type ProjectStatusSnapshot,
	type SessionStatusSnapshot,
	type SnapshotRevision,
	type StatusCompactionService,
	type StatusSessionService,
	type StatusTelemetryService,
	type StatusTimerService,
	type StatusWorkspaceService,
	type TurnTimerSnapshot,
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

function createRevisionReader<T extends object>(): (value: T | undefined) => (T & SnapshotRevision) | undefined {
	let revision = 0;
	let signature: string | undefined;
	let hasSignature = false;
	return (value) => {
		if (value === undefined) return undefined;
		const next = JSON.stringify(value);
		if (hasSignature && next !== signature) revision += 1;
		signature = next;
		hasSignature = true;
		return { ...value, revision };
	};
}

export interface StatusModuleOptions {

	readonly agentDir?: string;

	readonly env?: Readonly<Record<string, string | undefined>>;

	readonly readAutoCompactionEnabled?: (ctx: ExtensionContext, agentDir: string) => boolean;

	readonly watchAutoCompactionSettings?: (agentDir: string, onChange: () => void) => () => void;
}

export interface StatusMenuRuntime {

	reapply: () => void;
}

export function registerStatus(
	context: ModuleContext,
	options: StatusModuleOptions = {},
	menuRuntime: StatusMenuRuntime = { reapply: () => {} },
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

	const readWorkspaceRevision = createRevisionReader<ProjectStatusSnapshot>();
	const readSessionRevision = createRevisionReader<SessionStatusSnapshot>();
	const readTimerRevision = createRevisionReader<TurnTimerSnapshot>();

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
		timer = new TurnTimerController(
			Date.now,
			readLatestTurnDuration(ctx.sessionManager?.getEntries?.() ?? []),
		);
		if (settings.footerUsage.includes("context")) {
			compaction = new AutoCompactionStatusController(
				() => readCompactionEnabled(ctx, agentDir),
				(onChange) => watchSettings(agentDir, onChange),
			);
		}
	};

	context.services.register(STATUS_WORKSPACE_SERVICE_NAME, {
		id: "status",
		snapshot: () => (sessionContext ? readWorkspaceRevision({
			...(git?.getSnapshot() ?? { cwd: sessionContext.cwd, branch: null }),
			runtime: runtimeStatus?.getSnapshot(),
			duration: timer?.getSnapshot(),
		}) : undefined),
		refresh: async () => {
			await Promise.all([git?.refresh(), runtimeStatus?.refresh()]);
		},
		settings: () => currentSettings(),
	} satisfies StatusWorkspaceService);

	context.services.register(STATUS_SESSION_SERVICE_NAME, {
		id: "status",
		snapshot: () => (sessionContext
			? readSessionRevision(collectSessionStatus(sessionContext.sessionManager))
			: undefined),
		refresh: async () => {},
	} satisfies StatusSessionService);

	context.services.register(STATUS_TIMER_SERVICE_NAME, {
		id: "status",
		snapshot: () => readTimerRevision(timer?.getSnapshot()),
		refresh: async () => {},
	} satisfies StatusTimerService);

	context.services.register(STATUS_TELEMETRY_SERVICE_NAME, {
		id: "status",
		snapshot: () => telemetry.getSnapshot(),
		liveSnapshot: () => telemetry.getLiveSnapshot(),
		refresh: async () => {},
	} satisfies StatusTelemetryService);

	context.services.register(STATUS_COMPACTION_SERVICE_NAME, {
		id: "status",
		snapshot: () => compaction?.getSnapshot(),
		refresh: async () => {
			compaction?.refresh();
		},
	} satisfies StatusCompactionService);

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
