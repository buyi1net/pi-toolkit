import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModuleContext } from "../../kit/module.ts";
import {
	PROVIDERS_POOL_USAGE_SERVICE_NAME,
	PROVIDERS_USAGE_SERVICE_NAME,
	resolveProviderRefreshMs,
	type ProvidersPoolUsageService,
	type ProvidersUsageService,
	type ProvidersUsageSnapshot,
	type UsageRuntimeState,
} from "./api.ts";
import { loadProviderAccessFile } from "./credentials.ts";
import { PiProviderUsageController } from "./provider-usage.ts";
import { PoolUsageTracker } from "./pool-usage.ts";

export interface ProvidersModuleOptions {

	readonly agentDir?: string;
}

function createRevisionReader(): (value: UsageRuntimeState) => ProvidersUsageSnapshot {
	let revision = 0;
	let signature: string | undefined;
	let hasSignature = false;
	return (value) => {
		const next = JSON.stringify(value);
		if (hasSignature && next !== signature) revision += 1;
		signature = next;
		hasSignature = true;
		return { ...value, revision };
	};
}

export function registerProviders(context: ModuleContext, options: ProvidersModuleOptions = {}): void {
	const agentDir = options.agentDir ?? getAgentDir();
	let sessionContext: ExtensionContext | undefined;
	let polling = false;

	const readUsageRevision = createRevisionReader();

	const controller = new PiProviderUsageController(
		() => sessionContext,
		() => {},
		{
			refreshMs: () => resolveProviderRefreshMs(context.getConfig()),
			accessConfig: () => loadProviderAccessFile(agentDir).access ?? {},
		},
	);

	const poolTracker = new PoolUsageTracker(
		() => sessionContext,
		() => loadProviderAccessFile(agentDir).access ?? {},
		{ ttlMs: () => resolveProviderRefreshMs(context.getConfig()) },
	);

	context.services.register(PROVIDERS_USAGE_SERVICE_NAME, {
		id: "providers",
		snapshot: () => (sessionContext ? readUsageRevision(controller.getState()) : undefined),
		refresh: async (model) => {
			if (!sessionContext) return;

			if (!polling) {
				polling = true;
				await controller.start(model);
				return;
			}
			await controller.refresh(model);
		},
	} satisfies ProvidersUsageService);

	context.services.register(PROVIDERS_POOL_USAGE_SERVICE_NAME, {
		id: "providers",
		snapshot: (pool) => poolTracker.snapshot(pool),
		refresh: (pool) => poolTracker.refresh(pool),
	} satisfies ProvidersPoolUsageService);

	context.pi.on("session_start", (_event, ctx) => {
		sessionContext = ctx;

		const loaded = loadProviderAccessFile(agentDir);
		if (ctx.hasUI) {
			for (const warning of loaded.warnings) ctx.ui.notify(warning, "warning");
		}
	});

	context.pi.on("session_shutdown", () => {
		polling = false;
		controller.stop();
		poolTracker.stop();
		sessionContext = undefined;
	});
}
