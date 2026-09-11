// 声明式供应商查询路由表：每家供应商一条记录，新增供应商只需加一行。
// 表内只放数据：解析器与专用连接器以字符串标识登记在查询运行层（usage-node），
// 本文件因此保持零 IO，安全归属共享领域层。

import type { BuiltinQueryKind } from "../shared/provider-catalog.ts";

/** 查询步骤可依赖的凭据来源；任一缺失时该步骤被跳过，不发请求。 */
export type CredentialSource =
	| "token"
	| "openrouter-management"
	| "volcengine-aksk"
	| "zhipu-team";

/** 步骤执行条件；不满足时跳过该步骤（与凭据缺失同样视为不可执行）。 */
export interface StepCondition {
	/** baseUrl 的主机名不等于该值时才执行。 */
	hostNot?: string;
}

interface RouteStepBase {
	onlyWhen?: StepCondition;
}

/** 简单 JSON 查询步骤：运行层按声明构造请求，把响应交给绑定解析器。 */
export interface JsonQueryStep extends RouteStepBase {
	type: "json";
	/** 固定端点，或取 baseUrl 的 origin 拼接路径。 */
	url: { fixed: string } | { originPath: string };
	/** Bearer 鉴权使用的凭据来源；为空时跳过该步骤。 */
	credential: "token" | "openrouter-management";
	/** 响应解析器标识；具体实现登记在查询运行层。 */
	parser: JsonParserId;
}

/** 专用连接器步骤：OAuth 订阅、HMAC 签名、gRPC 等复杂协议由运行层连接器执行。 */
export interface ConnectorStep extends RouteStepBase {
	type: "connector";
	/** 连接器标识；具体实现登记在查询运行层。 */
	connector: ConnectorId;
	/** 全部就绪才执行该步骤的凭据来源。 */
	requires?: readonly CredentialSource[];
}

export type ProviderRouteStep = JsonQueryStep | ConnectorStep;

export interface ProviderRouteRecord {
	kind: BuiltinQueryKind;
	/** 依次尝试的回退链：前一步成功即返回，全部失败返回 null。 */
	steps: readonly ProviderRouteStep[];
}

/** 简单 JSON 端点的解析器标识；登记处见 usage-node/provider-usage.ts。 */
export type JsonParserId =
	| "stepfun-balance"
	| "siliconflow-balance"
	| "openrouter-balance"
	| "novita-balance"
	| "kimi-balance"
	| "kimi-quota"
	| "minimax-quota"
	| "sub2api-usage";

/** 专用协议连接器标识；登记处见 usage-node/provider-usage.ts。 */
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
			// 国际站没有已确认的余额接口；不能把国际站 Key 发送到国内 bigmodel.cn
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
			// Kimi Code 与开放平台是两套计费产品：套餐接口返回有效窗口即展示订阅，
			// 失败时同一 Key 仍可能有普通余额，依次尝试开放平台余额接口。
			{ type: "json", url: { fixed: "https://api.kimi.com/coding/v1/usages" }, credential: "token", parser: "kimi-quota" },
			{ type: "json", url: { fixed: "https://api.moonshot.cn/v1/users/me/balance" }, credential: "token", parser: "kimi-balance" },
		],
	},
	{
		kind: "minimax-cn",
		steps: [
			// Token Plan 新接口优先；保留旧 Coding Plan 路径兼容仍使用旧版接口的账户
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
			// 余额只使用独立 Management Key，不复用推理 Key
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
