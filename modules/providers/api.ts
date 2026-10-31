import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ProviderAccessOptions, ProviderQueryAccess, UsageSnapshot } from "./kernel/usage-core.ts";
import type { UsageRuntimeState } from "./kernel/usage-node.ts";

export { ProviderConfigValidationError, sanitizeQuotaWindowLabel } from "./kernel/usage-core.ts";
export type { ProviderAccess, ProviderAccessOptions, ProviderQueryAccess } from "./kernel/usage-core.ts";
export type { UsageRuntimeState } from "./kernel/usage-node.ts";

export type { UsageSnapshot } from "./kernel/usage-core.ts";

export const PROVIDERS_USAGE_SERVICE_NAME = "providers.usage";

export const PROVIDERS_POOL_USAGE_SERVICE_NAME = "providers.pool-usage";

export type PoolUsageState =
	| { kind: "ready"; snapshot: UsageSnapshot }
	| { kind: "unsupported"; fetchedAt: number }
	| { kind: "no-credential"; fetchedAt: number }
	| { kind: "failed"; fetchedAt: number }
	| { kind: "pending"; fetchedAt: number }
	| { kind: "unresolved"; fetchedAt: number };

export function poolUsageObservedAt(state: PoolUsageState): number {
	return state.kind === "ready" ? state.snapshot.fetchedAt : (state as { fetchedAt?: number }).fetchedAt ?? Number.NaN;
}

export interface PoolUsageEntry {

	readonly model: string;
	readonly state: PoolUsageState;
}

export interface ProvidersPoolUsageService {
	readonly id: "providers";

	snapshot(pool: readonly string[]): readonly PoolUsageEntry[];

	refresh(pool: readonly string[]): Promise<void>;
}

export type ProviderUsageModel = NonNullable<ExtensionContext["model"]>;

export interface ProvidersUsageService {
	readonly id: "providers";
	snapshot(): ProvidersUsageSnapshot | undefined;
	refresh(model?: ProviderUsageModel): Promise<void>;
}

export interface ProvidersUsageRevision {
	readonly revision: number;
}

export type ProvidersUsageSnapshot = UsageRuntimeState & ProvidersUsageRevision;

export interface PiProviderAccessConfig {
	queries?: readonly ProviderQueryAccess[];
	credentials?: ProviderAccessOptions["credentials"];
	githubDomain?: string;
}

export const PROVIDER_REFRESH_INTERVALS = [30_000, 60_000, 120_000, 300_000] as const;

export type ProviderRefreshMs = (typeof PROVIDER_REFRESH_INTERVALS)[number];

export const DEFAULT_PROVIDER_REFRESH_MS: ProviderRefreshMs = 60_000;

export function resolveProviderRefreshMs(section: Record<string, unknown>): number {
	const value = typeof section.refreshMs === "number" ? section.refreshMs : Number(section.refreshMs);
	return PROVIDER_REFRESH_INTERVALS.some((interval) => interval === value)
		? value
		: DEFAULT_PROVIDER_REFRESH_MS;
}

export const POOL_USAGE_READ_STALE_MS = DEFAULT_PROVIDER_REFRESH_MS;
