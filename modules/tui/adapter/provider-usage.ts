import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	ProviderAccess,
	ProviderAccessOptions,
	ProviderQueryAccess,
} from "../kernel/usage-core.ts";
import {
	createProviderAccess,
	FileUsageSnapshotCache,
	findProviderQueryConfig,
	UsageRuntime,
	type UsageRuntimeState,
} from "../kernel/usage-node.ts";

type PiModel = NonNullable<ExtensionContext["model"]>;
type AccessResolver = (
	ctx: ExtensionContext,
	model: PiModel | undefined,
	config?: PiProviderAccessConfig,
) => Promise<ProviderAccess | null>;

export interface PiProviderAccessConfig {
	queries?: readonly ProviderQueryAccess[];
	credentials?: ProviderAccessOptions["credentials"];
	githubDomain?: string;
}

const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";

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
	model: PiModel | undefined = ctx.model,
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
	private readonly ctx: ExtensionContext;
	private readonly runtime: UsageRuntime;
	private readonly resolveAccess: AccessResolver;
	private readonly accessConfig: PiProviderAccessConfig;
	private readonly refreshMs: number;
	private interval: NodeJS.Timeout | undefined;
	private activeModelKey = "";
	private refreshEpoch = 0;
	private disposed = false;

	constructor(
		ctx: ExtensionContext,
		onChange: (state: UsageRuntimeState) => void,
		options: {
			refreshMs?: number;
			resolveAccess?: AccessResolver;
			accessConfig?: PiProviderAccessConfig;
			runtime?: UsageRuntime;
		} = {},
	) {
		this.ctx = ctx;
		this.refreshMs = options.refreshMs ?? 60_000;
		this.resolveAccess = options.resolveAccess ?? resolvePiProviderAccess;
		this.accessConfig = options.accessConfig ?? {};
		this.runtime = options.runtime ?? new UsageRuntime({
			userAgent: "pi-tui",
			onChange,
			cache: new FileUsageSnapshotCache(join(homedir(), ".pi", "agent", "cache", "pi-tui", "usage")),
		});
	}

	getState(): UsageRuntimeState {
		return this.runtime.getState();
	}

	start(): Promise<void> {
		if (this.disposed || this.interval) return Promise.resolve();
		const initialRefresh = this.refresh();
		this.interval = setInterval(() => void this.refresh(), this.refreshMs);
		this.interval.unref?.();
		return initialRefresh;
	}

	async refresh(model: PiModel | undefined = this.ctx.model): Promise<void> {
		if (this.disposed) return;
		const epoch = ++this.refreshEpoch;
		const modelKey = model ? `${model.provider}\0${model.id}\0${model.baseUrl}` : "";
		if (modelKey !== this.activeModelKey) {
			this.activeModelKey = modelKey;
			// 凭据是异步解析的：身份一变先交运行层隔离旧供应商数据，解析期间不显示旧快照
			this.runtime.begin(model
				? { providerId: model.provider, modelId: model.id, endpoint: model.baseUrl }
				: null);
		}
		const access = await this.resolveAccess(this.ctx, model, this.accessConfig);
		// 解析期间有更新的 refresh 进场（换模型或换账号）：本次结果已过期，由最新一次 refresh 提交
		if (this.disposed || epoch !== this.refreshEpoch) return;
		await this.runtime.commit(access);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.interval) clearInterval(this.interval);
		this.interval = undefined;
		this.runtime.dispose();
	}
}
