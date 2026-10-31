import { findProviderByUrl, type BuiltinQueryKind } from "../shared/provider-catalog.ts";
import type {
	ProviderQueryConfig,
	ProviderQueryCredentials,
	ProviderUsage,
} from "../shared/provider-contracts.ts";
import {
	numberValue,
	parseKimiBalance,
	parseKimiQuota,
	parseMiniMaxQuota,
	parseNovitaBalance,
	parseOpenRouterBalance,
	parseSiliconFlowBalance,
	parseStepFunBalance,
	parseSub2ApiUsage,
	parseZenMuxQuota,
} from "../shared/provider-parsers.ts";
import {
	fetchDeepSeekBalance,
	fetchZhipuBalance,
	fetchZhipuQuota,
	fetchZhipuTeamQuota,
} from "../shared/zhipu.ts";
import { fetchVolcengineQuota } from "../shared/volcengine.ts";
import {
	fetchClaudeSubscription,
	fetchCodexSubscription,
	fetchCopilotSubscription,
	fetchGeminiSubscription,
} from "../shared/official-subscription.ts";
import { fetchGrokSubscription } from "../shared/grok-subscription.ts";
import {
	findProviderRoute,
	type ConnectorId,
	type CredentialSource,
	type JsonParserId,
	type JsonQueryStep,
	type ProviderRouteStep,
} from "../usage-core/provider-routes.ts";

export type ProviderKind = BuiltinQueryKind | "unknown";

export function detectProviderKind(baseUrl: string): ProviderKind {
	return findProviderByUrl(baseUrl)?.queryKind ?? "unknown";
}

export interface ProviderUsageQuery {

	userAgent?: string;
	kind: ProviderKind;
	baseUrl: string;
	credentials: ProviderQueryCredentials;
	request?: typeof fetch;

	query?: ProviderQueryConfig | null;
}

export interface ConfiguredProviderUsageQuery {
	config: ProviderQueryConfig;

	baseUrl: string;
	credentials: ProviderQueryCredentials;
	request?: typeof fetch;
}

interface QueryContext {
	userAgent?: string;
	kind: string;
	baseUrl: string;
	credentials: ProviderQueryCredentials;
	request: typeof fetch;
}

function hostIs(baseUrl: string, hostname: string): boolean {
	try {
		return new URL(baseUrl).hostname === hostname;
	} catch {
		return false;
	}
}

async function requestJson(url: string, apiKey: string, request: typeof fetch): Promise<any | null> {
	const response = await request(url, {
		headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
		signal: AbortSignal.timeout(15_000),
	});
	if (!response.ok) return null;
	return response.json().catch(() => null);
}

const JSON_PARSERS: Record<
	JsonParserId,
	(json: any, ctx: QueryContext) => ProviderUsage | null
> = {
	"stepfun-balance": (json) => {
		const balance = parseStepFunBalance(json);
		return balance ? { mode: "api", balance } : null;
	},
	"siliconflow-balance": (json, ctx) => {
		const balance = parseSiliconFlowBalance(json, ctx.kind === "siliconflow-en");
		return balance ? { mode: "api", balance } : null;
	},
	"openrouter-balance": (json) => {
		const balance = parseOpenRouterBalance(json);
		return balance ? { mode: "api", balance } : null;
	},
	"novita-balance": (json) => {
		const balance = parseNovitaBalance(json);
		return balance ? { mode: "api", balance } : null;
	},

	"kimi-balance": (json, ctx) => {
		const balance = parseKimiBalance(json, hostIs(ctx.baseUrl, "api.moonshot.ai"));
		return balance ? { mode: "api", balance } : null;
	},
	"kimi-quota": (json) => {
		const quota = parseKimiQuota(json);
		return quota ? { mode: "subscription", quota } : null;
	},
	"minimax-quota": (json) => {
		const quota = parseMiniMaxQuota(json);
		return quota ? { mode: "subscription", quota } : null;
	},

	"sub2api-usage": (json, ctx) =>
		parseSub2ApiUsage(json, findProviderByUrl(ctx.baseUrl)?.id ?? "sub2api"),
};

const CONNECTORS: Record<ConnectorId, (ctx: QueryContext) => Promise<ProviderUsage | null>> = {
	"claude-subscription": (ctx) =>
		fetchClaudeSubscription(ctx.credentials.token, ctx.request).catch(() => null),
	"codex-subscription": (ctx) =>
		fetchCodexSubscription(ctx.credentials.token, ctx.credentials.accountId, ctx.request).catch(() => null),
	"gemini-subscription": (ctx) =>
		fetchGeminiSubscription(ctx.credentials.token, ctx.request).catch(() => null),
	"copilot-subscription": (ctx) =>
		fetchCopilotSubscription(ctx.credentials.token, ctx.credentials.githubDomain ?? "github.com", ctx.request).catch(() => null),
	"grok-subscription": (ctx) =>
		fetchGrokSubscription(ctx.credentials.token, ctx.request, ctx.userAgent).catch(() => null),
	"zhipu-quota": async (ctx) => {

		const team = ctx.credentials.zhipuTeam;
		const quota = team
			? await fetchZhipuTeamQuota(ctx.credentials.token, team.organizationId, team.projectId, ctx.request).catch(() => null)
			: await fetchZhipuQuota(ctx.baseUrl, ctx.credentials.token, ctx.request).catch(() => null);

		return quota ? { mode: "subscription", quota } : null;
	},
	"zhipu-balance": async (ctx) => {
		const amount = await fetchZhipuBalance(ctx.credentials.token, ctx.request).catch(() => null);
		return amount == null ? null : { mode: "api", balance: { amount, currency: "CNY" } };
	},
	"deepseek-balance": async (ctx) => {
		const balance = await fetchDeepSeekBalance(ctx.credentials.token, ctx.request).catch(() => null);
		return balance ? { mode: "api", balance } : null;
	},
	"volcengine-quota": async (ctx) => {
		const credentials = ctx.credentials.volcengine;
		if (!credentials) return null;
		const quota = await fetchVolcengineQuota(
			ctx.baseUrl,
			credentials.accessKeyId,
			credentials.secretAccessKey,
			ctx.request,
			ctx.kind === "volcengine-agent" ? "agent" : "coding",
		).catch(() => null);
		return quota ? { mode: "subscription", quota } : null;
	},
};

function credentialReady(source: CredentialSource, credentials: ProviderQueryCredentials): boolean {
	switch (source) {
		case "token":
			return Boolean(credentials.token);
		case "openrouter-management":
			return Boolean(credentials.openrouter?.managementKey);
		case "volcengine-aksk":
			return Boolean(credentials.volcengine?.accessKeyId && credentials.volcengine?.secretAccessKey);
		case "zhipu-team":
			return Boolean(credentials.zhipuTeam?.organizationId && credentials.zhipuTeam?.projectId);
	}
}

function jsonStepCredential(step: JsonQueryStep, credentials: ProviderQueryCredentials): string {
	return step.credential === "openrouter-management"
		? credentials.openrouter?.managementKey ?? ""
		: credentials.token;
}

function stepUrl(step: JsonQueryStep, baseUrl: string): string | null {
	if ("fixed" in step.url) return step.url.fixed;
	try {
		return `${new URL(baseUrl).origin}${step.url.originPath}`;
	} catch {
		return null;
	}
}

async function runRouteStep(step: ProviderRouteStep, ctx: QueryContext): Promise<ProviderUsage | null> {
	if (step.onlyWhen?.hostNot != null && hostIs(ctx.baseUrl, step.onlyWhen.hostNot)) return null;
	if (step.type === "connector") {
		if (!(step.requires ?? []).every((source) => credentialReady(source, ctx.credentials))) return null;
		return CONNECTORS[step.connector](ctx);
	}
	const credential = jsonStepCredential(step, ctx.credentials);
	if (!credential) return null;
	const url = stepUrl(step, ctx.baseUrl);
	if (!url) return null;
	const json = await requestJson(url, credential, ctx.request).catch(() => null);
	return JSON_PARSERS[step.parser](json, ctx);
}

export async function fetchProviderUsage(query: ProviderUsageQuery): Promise<ProviderUsage | null> {
	if (query.query) {
		return fetchConfiguredProviderUsage({
			config: query.query,
			baseUrl: query.baseUrl,
			credentials: query.credentials,
			request: query.request,
		});
	}
	const route = findProviderRoute(query.kind);
	if (!route) return null;
	const ctx: QueryContext = {
		userAgent: query.userAgent,
		kind: query.kind,
		baseUrl: query.baseUrl,
		credentials: query.credentials,
		request: query.request ?? fetch,
	};
	for (const step of route.steps) {
		const usage = await runRouteStep(step, ctx);
		if (usage) return usage;
	}
	return null;
}

function matchesConfiguredHost(hostname: string, pattern: string): boolean {
	const normalized = pattern.trim().toLowerCase();
	if (!normalized) return false;
	if (!normalized.startsWith("*.")) return hostname === normalized;
	const parent = normalized.slice(2);
	return hostname === parent || hostname.endsWith(`.${parent}`);
}

export function findProviderQueryConfig(
	baseUrl: string,
	configs: readonly ProviderQueryConfig[],
): ProviderQueryConfig | null {
	let hostname: string;
	try {
		hostname = new URL(baseUrl).hostname.toLowerCase();
	} catch {
		return null;
	}
	return (
		configs.find(
			(config) =>
				Array.isArray(config?.matchHosts) &&
				config.matchHosts.some((pattern) =>
					typeof pattern === "string" ? matchesConfiguredHost(hostname, pattern) : false,
				),
		) ?? null
	);
}

function appendQueryPath(baseUrl: string, path: string): string | null {
	try {
		const url = new URL(baseUrl);
		const basePath = url.pathname.replace(/\/+$/, "");
		const suffix = path.startsWith("/") ? path : `/${path}`;
		url.pathname = `${basePath}${suffix}`.replace(/\/{2,}/g, "/");
		url.search = "";
		url.hash = "";
		return url.toString();
	} catch {
		return null;
	}
}

function sameOrigin(left: string, right: string): boolean {
	try {
		return new URL(left).origin === new URL(right).origin;
	} catch {
		return false;
	}
}

async function requestConfiguredJson(
	url: string,
	headers: Record<string, string>,
	request: typeof fetch,
): Promise<any | null> {
	const response = await request(url, {
		headers: { Accept: "application/json", ...headers },
		signal: AbortSignal.timeout(15_000),
	});
	if (!response.ok) return null;
	return response.json().catch(() => null);
}

export async function fetchConfiguredProviderUsage(
	query: ConfiguredProviderUsageQuery,
): Promise<ProviderUsage | null> {
	const { config, credentials } = query;
	const request = query.request ?? fetch;
	const inferenceApiKey = credentials.token;
	const queryBaseUrl = String(config.baseUrl || query.baseUrl).replace(/\/+$/, "");
	try {
		if (new URL(queryBaseUrl).protocol !== "https:") return null;
	} catch {
		return null;
	}
	const providerId = String(config.id || findProviderByUrl(query.baseUrl)?.id || "relay");
	const providerLabel = String(config.displayName || providerId);

	if (config.protocol === "new-api") {
		if (!config.accessToken || !config.userId) return null;
		const url = appendQueryPath(queryBaseUrl, config.path || "/api/user/self");
		if (!url) return null;
		const json = await requestConfiguredJson(
			url,
			{
				Authorization: `Bearer ${config.accessToken}`,
				"Content-Type": "application/json",
				"New-Api-User": config.userId,
			},
			request,
		);
		if (json?.success !== true || !json?.data) return null;
		const amount = numberValue(json.data.quota);
		if (amount == null) return null;
		return {
			mode: "api",
			balance: { amount: amount / 500_000, currency: config.currency ?? "USD" },
		};
	}

	if (config.protocol === "zenmux") {
		if (!config.baseUrl) return null;
		const apiKey = config.apiKey || (sameOrigin(queryBaseUrl, query.baseUrl) ? inferenceApiKey : "");
		if (!apiKey) return null;
		const json = await requestConfiguredJson(queryBaseUrl, { Authorization: `Bearer ${apiKey}` }, request);
		const quota = parseZenMuxQuota(json);
		return quota ? { mode: "subscription", quota } : null;
	}

	const apiKey = config.apiKey || (sameOrigin(queryBaseUrl, query.baseUrl) ? inferenceApiKey : "");
	if (!apiKey) return null;

	if (config.protocol === "sub2api") {
		let protocolBase = queryBaseUrl;
		try {
			protocolBase = new URL(queryBaseUrl).origin;
		} catch {
			return null;
		}
		const url = appendQueryPath(protocolBase, config.path || "/v1/usage");
		if (!url) return null;
		const json = await requestConfiguredJson(url, { Authorization: `Bearer ${apiKey}` }, request);
		return parseSub2ApiUsage(json, providerLabel);
	}

	if (config.protocol === "generic-balance") {
		const url = appendQueryPath(queryBaseUrl, config.path || "/user/balance");
		if (!url) return null;
		const json = await requestConfiguredJson(url, { Authorization: `Bearer ${apiKey}` }, request);
		if (!json || json.is_active === false || json.isValid === false) return null;
		const amount = numberValue(json.balance ?? json?.data?.balance);
		return amount == null
			? null
			: { mode: "api", balance: { amount, currency: config.currency ?? "USD" } };
	}

	return null;
}
