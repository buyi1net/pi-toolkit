import type { BuiltinQueryKind } from "../shared/provider-catalog.ts";

export type CredentialSource =
	| "token"
	| "openrouter-management"
	| "volcengine-aksk"
	| "zhipu-team";

export interface StepCondition {

	hostNot?: string;
}

interface RouteStepBase {
	onlyWhen?: StepCondition;
}

export interface JsonQueryStep extends RouteStepBase {
	type: "json";

	url: { fixed: string } | { originPath: string };

	credential: "token" | "openrouter-management";

	parser: JsonParserId;
}

export interface ConnectorStep extends RouteStepBase {
	type: "connector";

	connector: ConnectorId;

	requires?: readonly CredentialSource[];
}

export type ProviderRouteStep = JsonQueryStep | ConnectorStep;

export interface ProviderRouteRecord {
	kind: BuiltinQueryKind;

	steps: readonly ProviderRouteStep[];
}

export type JsonParserId =
	| "stepfun-balance"
	| "siliconflow-balance"
	| "openrouter-balance"
	| "novita-balance"
	| "kimi-balance"
	| "kimi-quota"
	| "minimax-quota"
	| "sub2api-usage";

export type ConnectorId =
	| "claude-subscription"
	| "codex-subscription"
	| "gemini-subscription"
	| "copilot-subscription"
	| "grok-subscription"
	| "zhipu-quota"
	| "zhipu-balance"
	| "deepseek-balance"
	| "volcengine-quota";

export const PROVIDER_ROUTES: readonly ProviderRouteRecord[] = [
	{
		kind: "claude-subscription",
		steps: [{ type: "connector", connector: "claude-subscription", requires: ["token"] }],
	},
	{
		kind: "codex-subscription",
		steps: [{ type: "connector", connector: "codex-subscription", requires: ["token"] }],
	},
	{
		kind: "gemini-subscription",
		steps: [{ type: "connector", connector: "gemini-subscription", requires: ["token"] }],
	},
	{
		kind: "copilot-subscription",
		steps: [{ type: "connector", connector: "copilot-subscription", requires: ["token"] }],
	},
	{
		kind: "grok-subscription",
		steps: [{ type: "connector", connector: "grok-subscription", requires: ["token"] }],
	},
	{
		kind: "zhipu",
		steps: [
			{ type: "connector", connector: "zhipu-quota", requires: ["token"] },

			{ type: "connector", connector: "zhipu-balance", requires: ["token"], onlyWhen: { hostNot: "api.z.ai" } },
		],
	},
	{
		kind: "kimi-api",
		steps: [
			{ type: "json", url: { originPath: "/v1/users/me/balance" }, credential: "token", parser: "kimi-balance" },
		],
	},
	{
		kind: "kimi-coding",
		steps: [

			{ type: "json", url: { fixed: "https://api.kimi.com/coding/v1/usages" }, credential: "token", parser: "kimi-quota" },
			{ type: "json", url: { fixed: "https://api.moonshot.cn/v1/users/me/balance" }, credential: "token", parser: "kimi-balance" },
		],
	},
	{
		kind: "minimax-cn",
		steps: [

			{ type: "json", url: { fixed: "https://www.minimaxi.com/v1/token_plan/remains" }, credential: "token", parser: "minimax-quota" },
			{ type: "json", url: { fixed: "https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains" }, credential: "token", parser: "minimax-quota" },
		],
	},
	{
		kind: "minimax-en",
		steps: [
			{ type: "json", url: { fixed: "https://www.minimax.io/v1/token_plan/remains" }, credential: "token", parser: "minimax-quota" },
			{ type: "json", url: { fixed: "https://api.minimax.io/v1/api/openplatform/coding_plan/remains" }, credential: "token", parser: "minimax-quota" },
		],
	},
	{
		kind: "deepseek",
		steps: [{ type: "connector", connector: "deepseek-balance", requires: ["token"] }],
	},
	{
		kind: "stepfun",
		steps: [
			{ type: "json", url: { fixed: "https://api.stepfun.com/v1/accounts" }, credential: "token", parser: "stepfun-balance" },
		],
	},
	{
		kind: "siliconflow-cn",
		steps: [
			{ type: "json", url: { fixed: "https://api.siliconflow.cn/v1/user/info" }, credential: "token", parser: "siliconflow-balance" },
		],
	},
	{
		kind: "siliconflow-en",
		steps: [
			{ type: "json", url: { fixed: "https://api.siliconflow.com/v1/user/info" }, credential: "token", parser: "siliconflow-balance" },
		],
	},
	{
		kind: "openrouter",
		steps: [

			{ type: "json", url: { fixed: "https://openrouter.ai/api/v1/credits" }, credential: "openrouter-management", parser: "openrouter-balance" },
		],
	},
	{
		kind: "novita",
		steps: [
			{ type: "json", url: { fixed: "https://api.novita.ai/openapi/v1/billing/balance/detail" }, credential: "token", parser: "novita-balance" },
		],
	},
	{
		kind: "sub2api",
		steps: [
			{ type: "json", url: { originPath: "/v1/usage" }, credential: "token", parser: "sub2api-usage" },
		],
	},
	{
		kind: "volcengine-agent",
		steps: [{ type: "connector", connector: "volcengine-quota", requires: ["volcengine-aksk"] }],
	},
	{
		kind: "volcengine-coding",
		steps: [{ type: "connector", connector: "volcengine-quota", requires: ["volcengine-aksk"] }],
	},
];

export function findProviderRoute(kind: string): ProviderRouteRecord | null {
	return PROVIDER_ROUTES.find((route) => route.kind === kind) ?? null;
}
