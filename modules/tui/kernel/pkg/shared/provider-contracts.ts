export type BillingMode = 'subscription' | 'api' | 'hybrid' | 'unknown';

export interface QuotaWindow {
  label: string;
  remainingPercent: number;
  resetMs: number | null;
}

export interface QuotaInfo {
  provider: string;
  windows: QuotaWindow[];
}

export interface BalanceValue {
  amount: number;
  currency: 'CNY' | 'USD';
}

export interface ProviderUsage {
  mode: Exclude<BillingMode, 'unknown'>;
  balance?: BalanceValue;
  quota?: QuotaInfo;
}

const QUERY_PROTOCOLS = ['sub2api', 'new-api', 'generic-balance', 'zenmux'] as const;
export type RelayQueryProtocol = (typeof QUERY_PROTOCOLS)[number];

/** 不猜中转接口；查询与推理地址不同源时须显式提供查询凭据，避免跨域复用推理 Key。 */
export interface ProviderQueryConfig {
  id: string;
  displayName?: string;
  matchHosts: string[];
  protocol: RelayQueryProtocol;
  baseUrl?: string;
  path?: string;
  apiKey?: string;
  accessToken?: string;
  userId?: string;
  currency?: 'CNY' | 'USD';
}

export interface ProviderCredentials {
  volcengine?: {
    accessKeyId: string;
    secretAccessKey: string;
  };
  zhipuTeam?: {
    organizationId: string;
    projectId: string;
  };
  openrouter?: {
    managementKey: string;
  };
}

type ProviderConfigRule = 'object' | 'array' | 'nonEmptyArray' | 'nonEmptyString' | 'choice';

/** 不携带输入原文，避免宿主输出诊断时泄露凭据；宿主按规则码选择自己的文案。 */
export class ProviderConfigValidationError extends Error {
	readonly field: string;
	readonly rule: ProviderConfigRule;

	constructor(field: string, rule: ProviderConfigRule) {
		super(`${field}: ${rule}`);
		this.name = 'ProviderConfigValidationError';
		this.field = field;
		this.rule = rule;
	}
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new ProviderConfigValidationError(field, 'object');
	}
	return value as Record<string, unknown>;
}

function optionalString(value: unknown, field: string, secret = false): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== 'string' || !(secret ? value : value.trim())) {
		throw new ProviderConfigValidationError(field, 'nonEmptyString');
	}
	return secret ? value : value.trim();
}

function requiredString(value: unknown, field: string, secret = false): string {
	const parsed = optionalString(value, field, secret);
	if (parsed === undefined) throw new ProviderConfigValidationError(field, 'nonEmptyString');
	return parsed;
}

/** 缺省保留 undefined；普通字符串裁边，凭据原样保留，未知字段丢弃，以兼容既有配置。 */
export function parseProviderQueries(value: unknown, field: string): ProviderQueryConfig[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new ProviderConfigValidationError(field, 'array');
	return value.map((item, index) => {
		const path = `${field}[${index}]`;
		const query = requireRecord(item, path);
		const id = requiredString(query.id, `${path}.id`);
		if (!Array.isArray(query.matchHosts) || query.matchHosts.length === 0) {
			throw new ProviderConfigValidationError(`${path}.matchHosts`, 'nonEmptyArray');
		}
		const matchHosts = query.matchHosts.map((host, hostIndex) => requiredString(host, `${path}.matchHosts[${hostIndex}]`));
		if (typeof query.protocol !== 'string' || !QUERY_PROTOCOLS.includes(query.protocol as RelayQueryProtocol)) {
			throw new ProviderConfigValidationError(`${path}.protocol`, 'choice');
		}
		if (query.currency !== undefined && query.currency !== 'CNY' && query.currency !== 'USD') {
			throw new ProviderConfigValidationError(`${path}.currency`, 'choice');
		}
		const result: ProviderQueryConfig = { id, matchHosts, protocol: query.protocol as RelayQueryProtocol };
		for (const key of ['displayName', 'baseUrl', 'path', 'apiKey', 'accessToken', 'userId'] as const) {
			const parsed = optionalString(query[key], `${path}.${key}`, key === 'apiKey' || key === 'accessToken');
			if (parsed !== undefined) result[key] = parsed;
		}
		if (query.currency !== undefined) result.currency = query.currency;
		return result;
	});
}

/** 缺省视为空凭据；仅校验显式配置的已知供应商，不要求同时配置所有供应商。 */
export function parseProviderCredentials(value: unknown, field: string): ProviderCredentials {
	const credentials = value === undefined ? {} : requireRecord(value, field);
	const volcengine = credentials.volcengine === undefined
		? undefined : requireRecord(credentials.volcengine, `${field}.volcengine`);
	const zhipuTeam = credentials.zhipuTeam === undefined
		? undefined : requireRecord(credentials.zhipuTeam, `${field}.zhipuTeam`);
	const openrouter = credentials.openrouter === undefined
		? undefined : requireRecord(credentials.openrouter, `${field}.openrouter`);
	return {
		...(volcengine ? { volcengine: {
			accessKeyId: requiredString(volcengine.accessKeyId, `${field}.volcengine.accessKeyId`, true),
			secretAccessKey: requiredString(volcengine.secretAccessKey, `${field}.volcengine.secretAccessKey`, true),
		} } : {}),
		...(zhipuTeam ? { zhipuTeam: {
			organizationId: requiredString(zhipuTeam.organizationId, `${field}.zhipuTeam.organizationId`),
			projectId: requiredString(zhipuTeam.projectId, `${field}.zhipuTeam.projectId`),
		} } : {}),
		...(openrouter ? { openrouter: {
			managementKey: requiredString(openrouter.managementKey, `${field}.openrouter.managementKey`, true),
		} } : {}),
	};
}

/** 查询入口的唯一凭据通道：调用方只交凭据，具体字段用不用由路由表按供应商决定。 */
export interface ProviderQueryCredentials extends ProviderCredentials {
  /** 主凭据：API Key 或 OAuth Access Token，按供应商协议充当对应角色 */
  token: string;
  accountId?: string;
  githubDomain?: string;
}
