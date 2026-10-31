import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_PROVIDER_REFRESH_MS,
	type PiProviderAccessConfig,
	type ProviderUsageModel,
} from "./api.ts";
import type { ProviderAccess } from "./kernel/usage-core.ts";
import {
	createProviderAccess,
	FileUsageSnapshotCache,
	findProviderQueryConfig,
	UsageRuntime,
	type UsageRuntimeState,
} from "./kernel/usage-node.ts";

export type AccessResolver = (
	ctx: ExtensionContext,
	model: ProviderUsageModel | undefined,
	config?: PiProviderAccessConfig,
) => Promise<ProviderAccess | null>;

const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";

export const USAGE_SNAPSHOT_CACHE_ROOT = join(homedir(), ".pi", "agent", "cache", "pi-tui", "usage");

function extractCodexAccountId(providerId: string, credential: string): string | undefined {
	if (providerId !== "openai-codex") return undefined;
	const payload = credential.split(".")[1];
	if (!payload) return undefined;
	try {
		const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
		if (!claims || typeof claims !== "object") return undefined;
		const auth = (claims as Record<string, unknown>)[OPENAI_AUTH_CLAIM];
		if (!auth || typeof auth !== "object") return undefined;
		const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
		return typeof accountId === "string" && accountId.trim() ? accountId : undefined;
	} catch {
		return undefined;
	}
}

export async function resolvePiProviderAccess(
	ctx: ExtensionContext,
	model: ProviderUsageModel | undefined = ctx.model,
	config: PiProviderAccessConfig = {},
): Promise<ProviderAccess | null> {
	if (!model) return null;
	try {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) return null;
		const credential = auth.apiKey ?? "";
		const endpoint = auth.baseUrl ?? model.baseUrl;
		return createProviderAccess({
			providerId: model.provider,
			modelId: model.id,
			endpoint,
			credential,
			authKind: ctx.modelRegistry.isUsingOAuth(model) ? "oauth" : "api-key",
			accountId: extractCodexAccountId(model.provider, credential),
			githubDomain: config.githubDomain,
			query: findProviderQueryConfig(endpoint, config.queries ?? []),
			credentials: config.credentials,
		});
	} catch {
		return null;
	}
}

export class PiProviderUsageController {
	private readonly getContext: () => ExtensionContext | undefined;
	private readonly runtime: UsageRuntime;
	private readonly resolveAccess: AccessResolver;
	private readonly refreshMs: number | (() => number);
	private readonly accessConfig: PiProviderAccessConfig | (() => PiProviderAccessConfig);
	private timer: NodeJS.Timeout | undefined;

	private polling = false;
	private activeModelKey = "";
	private refreshEpoch = 0;
	private disposed = false;

	constructor(
		getContext: () => ExtensionContext | undefined,
		onChange: (state: UsageRuntimeState) => void,
		options: {

			refreshMs?: number | (() => number);
			resolveAccess?: AccessResolver;

			accessConfig?: PiProviderAccessConfig | (() => PiProviderAccessConfig);
			runtime?: UsageRuntime;
		} = {},
	) {
		this.getContext = getContext;
		this.refreshMs = options.refreshMs ?? DEFAULT_PROVIDER_REFRESH_MS;
		this.resolveAccess = options.resolveAccess ?? resolvePiProviderAccess;
		this.accessConfig = options.accessConfig ?? {};
		this.runtime = options.runtime ?? new UsageRuntime({
			userAgent: "pi-tui",
			onChange,
			cache: new FileUsageSnapshotCache(USAGE_SNAPSHOT_CACHE_ROOT),
		});
	}

	getState(): UsageRuntimeState {
		return this.runtime.getState();
	}

	start(model?: ProviderUsageModel): Promise<void> {
		if (this.disposed) return Promise.resolve();
		this.polling = true;
		this.schedule();
		return this.refresh(model);
	}

	async refresh(model?: ProviderUsageModel): Promise<void> {
		if (this.disposed) return;
		const ctx = this.getContext();
		if (!ctx) return;
		const target = model ?? ctx.model;
		const epoch = ++this.refreshEpoch;
		const modelKey = target ? `${target.provider}\0${target.id}\0${target.baseUrl}` : "";
		if (modelKey !== this.activeModelKey) {
			this.activeModelKey = modelKey;

			this.runtime.begin(target
				? { providerId: target.provider, modelId: target.id, endpoint: target.baseUrl }
				: null);
		}
		const access = await this.resolveAccess(ctx, target, this.resolveAccessConfig());

		if (this.disposed || epoch !== this.refreshEpoch) return;
		await this.runtime.commit(access);
	}

	stop(): void {
		if (this.disposed) return;
		this.polling = false;
		this.refreshEpoch += 1;
		this.activeModelKey = "";
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		this.runtime.begin(null);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.runtime.dispose();
	}

	private schedule(): void {
		if (this.disposed || !this.polling || this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.refresh().finally(() => this.schedule());
		}, this.resolveRefreshMs());
		this.timer.unref?.();
	}

	private resolveRefreshMs(): number {
		const value = typeof this.refreshMs === "function" ? this.refreshMs() : this.refreshMs;
		return Number.isFinite(value) && value > 0 ? value : DEFAULT_PROVIDER_REFRESH_MS;
	}

	private resolveAccessConfig(): PiProviderAccessConfig {
		return typeof this.accessConfig === "function" ? this.accessConfig() : this.accessConfig;
	}
}
