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

export interface CacheEntry<T> {
	ts: number;
	value: T;
}

export function isCacheStale<T>(entry: CacheEntry<T> | null, ttlMs: number, now = Date.now()): boolean {
	return !entry || now - entry.ts > ttlMs;
}

export interface SourceIdentity {
	providerKey: string;
}

export interface SourceState extends SourceIdentity {
	status: "pending" | "backoff" | "ready";

	attemptTs: number;
}

export interface SourceRefreshPlan {

	usable: boolean;

	refresh: boolean;

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

export function recordModel(
	cached: ModelSnapshots,
	scopeKey: string,
	modelKey: string,
	maxEntries = 20,
): { changed: boolean; value: ModelSnapshots } {
	return recordScopedValue(cached, scopeKey, modelKey, maxEntries);
}

export function recordRefreshEvent(
	cached: ScopedSnapshots,
	scopeKey: string,
	eventKey: string | null,
	maxEntries = 20,
): { changed: boolean; value: ScopedSnapshots } {
	return eventKey ? recordScopedValue(cached, scopeKey, eventKey, maxEntries) : { changed: false, value: cached };
}

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
