import {
	CC_SWITCH_CLAUDE_PRESET_COUNT,
	findProviderById,
	findProviderByUrl,
	OFFICIAL_PROVIDERS,
	PROVIDER_BRANDS,
	PROVIDER_CATALOG,
	RELAY_PROVIDERS,
} from "../shared/provider-catalog.ts";
import {
	displayProviderName,
	inferModelProviderName,
} from "../shared/provider-display.ts";

// 供应商目录与品牌展示是共享领域层公开词汇，宿主不得深路径直连 shared 内部模块。
export {
	CC_SWITCH_CLAUDE_PRESET_COUNT,
	findProviderById,
	findProviderByUrl,
	OFFICIAL_PROVIDERS,
	PROVIDER_BRANDS,
	PROVIDER_CATALOG,
	RELAY_PROVIDERS,
	displayProviderName,
	inferModelProviderName,
};
import type {
	BillingMode as SharedBillingMode,
	ProviderCredentials,
	ProviderQueryConfig,
	QuotaWindow as SharedQuotaWindow,
} from "../shared/provider-contracts.ts";

export {
	parseProviderCredentials,
	parseProviderQueries,
	ProviderConfigValidationError,
} from "../shared/provider-contracts.ts";
export type {
	BalanceValue,
	ProviderCredentials,
	ProviderQueryConfig,
	QuotaInfo,
	RelayQueryProtocol,
} from "../shared/provider-contracts.ts";

export type BillingMode = SharedBillingMode;
export type UsageFreshness = "fresh" | "stale";

export interface ProviderIdentity {
	providerId: string;
	endpoint: string;
	accountFingerprint: string;
}

export interface ProviderAccess {
	identity: ProviderIdentity;
	credential: string;
	options?: ProviderAccessOptions;
}

export type ProviderQueryAccess = ProviderQueryConfig;

export interface ProviderAccessOptions {
	modelId?: string;
	authKind?: "api-key" | "oauth";
	accountId?: string;
	githubDomain?: string;
	query?: ProviderQueryAccess | null;
	credentials?: ProviderCredentials;
}

export interface Balance {
	amount: number;
	currency: "CNY" | "USD";
}

export type QuotaWindow = SharedQuotaWindow;

export interface UsageSnapshot {
	provider: {
		id: string;
		brandName: string;
	};
	billingMode: BillingMode;
	balance: Balance | null;
	windows: QuotaWindow[];
	fetchedAt: number;
	freshness: UsageFreshness;
}

export interface NormalizedUsageInput {
	providerId: string;
	brandName?: string;
	billingMode: Exclude<BillingMode, "unknown">;
	balance?: Balance;
	windows?: readonly QuotaWindow[];
	fetchedAt?: number;
}

export function normalizeEndpoint(endpoint: string): string {
	const raw = endpoint.trim();
	if (!raw) return "";
	try {
		const url = new URL(raw);
		const path = url.pathname.replace(/\/+$/, "");
		return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${path}`;
	} catch {
		return raw.toLowerCase().replace(/\/+$/, "");
	}
}

export function resolveProviderMetadata(
	endpoint: string,
	providerHint = "",
	modelId = "",
): { providerId: string; brandName: string } {
	const normalizedEndpoint = normalizeEndpoint(endpoint);
	const catalog =
		(normalizedEndpoint ? findProviderByUrl(normalizedEndpoint) : undefined) ??
		(providerHint ? findProviderById(providerHint) : undefined);
	const inferredProviderId = !catalog ? inferModelProviderName(modelId) : undefined;
	const providerId = catalog?.brandId ?? inferredProviderId ?? (providerHint.trim() || "unknown");
	return {
		providerId,
		brandName: catalog?.displayName ?? (inferredProviderId ? displayProviderName(providerId) : ""),
	};
}

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, value));
}

export const MAX_QUOTA_WINDOW_LABEL_LENGTH = 24;

export function sanitizeQuotaWindowLabel(label: unknown): string {
	const safe = String(label ?? "")
		.replace(/(?:\x1b[\]PX^_]|[\u0090\u009d\u009e\u009f])[\s\S]*?(?:\x07|\x1b\\|\u009c)/g, "")
		.replace(/(?:\x1b[\]PX^_]|[\u0090\u009d\u009e\u009f])[\s\S]*$/g, "")
		.replace(/(?:\x1b\[|\u009b)[0-?]*[ -\/]*[@-~]/g, "")
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return [...(safe || "Quota")].slice(0, MAX_QUOTA_WINDOW_LABEL_LENGTH).join("");
}

export function normalizeUsageSnapshot(input: NormalizedUsageInput): UsageSnapshot {
	return {
		provider: {
			id: input.providerId,
			brandName: input.brandName ?? displayProviderName(input.providerId),
		},
		billingMode: input.billingMode,
		balance: input.balance ?? null,
		windows: (input.windows ?? []).map((window) => ({
			label: sanitizeQuotaWindowLabel(window.label),
			remainingPercent: clampPercent(window.remainingPercent),
			resetMs: window.resetMs,
		})),
		fetchedAt: input.fetchedAt ?? Date.now(),
		freshness: "fresh",
	};
}

export function markUsageSnapshotStale(snapshot: UsageSnapshot): UsageSnapshot {
	return snapshot.freshness === "stale" ? snapshot : { ...snapshot, freshness: "stale" };
}

// —— 刷新状态机与缓存时效判定（零 IO 纯函数；文件读写由查询运行层承担） ——

export interface CacheEntry<T> {
	ts: number;
	value: T;
}

/** 缓存条目是否超过 TTL；缺失视为过期。 */
export function isCacheStale<T>(entry: CacheEntry<T> | null, ttlMs: number, now = Date.now()): boolean {
	return !entry || now - entry.ts > ttlMs;
}

export interface SourceIdentity {
	providerKey: string;
}

export interface SourceState extends SourceIdentity {
	status: "pending" | "backoff" | "ready";
	/** 最近一次启动刷新进程的时间，用于失败退避 */
	attemptTs: number;
}

export interface SourceRefreshPlan {
	/** 当前缓存是否属于当前供应商，可以用于布局 */
	usable: boolean;
	/** 本轮是否启动一次旁路刷新 */
	refresh: boolean;
	/** 需要先落盘的新状态；null 表示状态不变 */
	nextState: SourceState | null;
}

export const SOURCE_RETRY_MS = 30_000;

export function usageRetryDue(retryAfter: number, now: number): boolean {
	return !(retryAfter > now);
}

export function isLastGoodUsable(
	fetchedAt: number | null,
	keepLastGoodMs: number,
	now: number,
): boolean {
	return fetchedAt !== null && now - fetchedAt <= keepLastGoodMs;
}

export interface UsageFailurePlan {
	status: "stale" | "error";
	retryAfter: number;
}

export function planUsageFailure(
	lastGoodAt: number | null,
	keepLastGoodMs: number,
	retryMs: number,
	now: number,
): UsageFailurePlan {
	return {
		status: isLastGoodUsable(lastGoodAt, keepLastGoodMs, now) ? "stale" : "error",
		retryAfter: now + retryMs,
	};
}

export interface ScopedSnapshots {
	[scopeKey: string]: string;
}

export type ModelSnapshots = ScopedSnapshots;

function recordScopedValue(
	cached: ScopedSnapshots,
	scopeKey: string,
	valueKey: string,
	maxEntries: number,
): { changed: boolean; value: ScopedSnapshots } {
	if (cached[scopeKey] === valueKey) return { changed: false, value: cached };
	const value = { ...cached };
	delete value[scopeKey];
	value[scopeKey] = valueKey;
	const keys = Object.keys(value);
	for (const key of keys.slice(0, Math.max(0, keys.length - maxEntries))) delete value[key];
	return { changed: true, value };
}

/** 按会话记录模型，避免多个并行会话使用不同模型时互相触发变化。 */
export function recordModel(
	cached: ModelSnapshots,
	scopeKey: string,
	modelKey: string,
	maxEntries = 20,
): { changed: boolean; value: ModelSnapshots } {
	return recordScopedValue(cached, scopeKey, modelKey, maxEntries);
}

/** 宿主提供稳定事件键；同一会话的同一轮结束只触发一次刷新。 */
export function recordRefreshEvent(
	cached: ScopedSnapshots,
	scopeKey: string,
	eventKey: string | null,
	maxEntries = 20,
): { changed: boolean; value: ScopedSnapshots } {
	return eventKey ? recordScopedValue(cached, scopeKey, eventKey, maxEntries) : { changed: false, value: cached };
}

/** 按计费模式判断当前所需的余额或订阅额度缓存是否超龄。 */
export function usageRefreshDue(
	mode: BillingMode | null,
	quotaStale: boolean,
	balanceStale: boolean,
): boolean {
	if (!mode) return true;
	return (
		((mode === "subscription" || mode === "hybrid") && quotaStale) ||
		((mode === "api" || mode === "hybrid") && balanceStale)
	);
}

function matches(current: SourceIdentity, cached: SourceState): boolean {
	return current.providerKey === cached.providerKey;
}

/**
 * 数据源变化时立刻隔离旧缓存；同一数据源的 TTL 过期只后台更新，继续显示旧值。
 * pending 会每秒尝试抢刷新锁；只有实际请求失败进入 backoff 后才按 retryMs 退避。
 */
export function planSourceRefresh(
	current: SourceIdentity,
	cached: SourceState | null,
	dataStale: boolean,
	now = Date.now(),
	retryMs = SOURCE_RETRY_MS,
	forceRefresh = false,
): SourceRefreshPlan {
	if (
		!cached ||
		!matches(current, cached) ||
		(cached.status !== "pending" && cached.status !== "backoff" && cached.status !== "ready")
	) {
		return {
			usable: false,
			refresh: true,
			nextState: { ...current, status: "pending", attemptTs: now },
		};
	}

	const retryDue = !Number.isFinite(cached.attemptTs) || usageRetryDue(cached.attemptTs + retryMs, now);
	if (cached.status === "pending") {
		return { usable: false, refresh: true, nextState: null };
	}

	if (cached.status === "backoff") {
		return {
			usable: false,
			refresh: retryDue,
			nextState: retryDue ? { ...cached, status: "pending", attemptTs: now } : null,
		};
	}

	if (dataStale && (forceRefresh || retryDue)) {
		return {
			usable: true,
			refresh: true,
			nextState: { ...cached, attemptTs: now },
		};
	}

	return { usable: true, refresh: false, nextState: null };
}
