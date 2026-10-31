import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_PROVIDER_REFRESH_MS,
	type PiProviderAccessConfig,
	type PoolUsageEntry,
	type PoolUsageState,
	type ProviderUsageModel,
} from "./api.ts";
import { resolvePiProviderAccess, USAGE_SNAPSHOT_CACHE_ROOT, type AccessResolver } from "./provider-usage.ts";
import {
	FileUsageSnapshotCache,
	providerAccessKey,
	queryProviderUsage,
	type UsageQueryResult,
	type UsageSnapshotCache,
} from "./kernel/usage-node.ts";
import { SOURCE_RETRY_MS, type ProviderAccess } from "./kernel/usage-core.ts";

export const DEFAULT_POOL_USAGE_CACHE_ROOT = USAGE_SNAPSHOT_CACHE_ROOT;

const DEFAULT_KEEP_LAST_GOOD_MS = 10 * 60_000;

export interface PoolUsageTrackerOptions {

	ttlMs?: number | (() => number);

	retryMs?: number;

	keepLastGoodMs?: number;
	userAgent?: string;

	query?: (access: ProviderAccess) => Promise<UsageQueryResult>;
	cache?: UsageSnapshotCache;
	resolveAccess?: AccessResolver;
	now?: () => number;
}

function findPoolModel(ref: string, ctx: ExtensionContext): ProviderUsageModel | null {
	try {
		const all = ctx.modelRegistry?.getAll?.() ?? [];
		const exact = all.find((entry) => `${entry.provider}/${entry.id}` === ref);
		if (exact) return exact;
		const bare = all.filter((entry) => entry.id === ref);
		return bare.length === 1 ? bare[0] : null;
	} catch {
		return null;
	}
}

interface InFlightJob {
	readonly generation: number;
	readonly job: Promise<PoolUsageState>;
}

export class PoolUsageTracker {
	private readonly getContext: () => ExtensionContext | undefined;
	private readonly accessConfig: () => PiProviderAccessConfig;
	private readonly ttlMs: number | (() => number);
	private readonly retryMs: number;
	private readonly keepLastGoodMs: number;
	private readonly query: (access: ProviderAccess) => Promise<UsageQueryResult>;
	private readonly cache: UsageSnapshotCache;
	private readonly resolveAccess: AccessResolver;
	private readonly now: () => number;
	private readonly entries = new Map<string, PoolUsageState>();
	private readonly retryAfter = new Map<string, number>();
	private readonly inFlight = new Map<string, InFlightJob>();
	private generation = 0;

	constructor(
		getContext: () => ExtensionContext | undefined,
		accessConfig: () => PiProviderAccessConfig,
		options: PoolUsageTrackerOptions = {},
	) {
		this.getContext = getContext;
		this.accessConfig = accessConfig;
		this.ttlMs = options.ttlMs ?? DEFAULT_PROVIDER_REFRESH_MS;
		this.retryMs = options.retryMs ?? SOURCE_RETRY_MS;
		this.keepLastGoodMs = options.keepLastGoodMs ?? DEFAULT_KEEP_LAST_GOOD_MS;
		this.query = options.query ?? ((access) => queryProviderUsage(access, fetch, { userAgent: options.userAgent ?? "pi-tui" }));
		this.cache = options.cache ?? new FileUsageSnapshotCache(DEFAULT_POOL_USAGE_CACHE_ROOT);
		this.resolveAccess = options.resolveAccess ?? resolvePiProviderAccess;
		this.now = options.now ?? Date.now;
	}

	snapshot(pool: readonly string[]): PoolUsageEntry[] {
		const out: PoolUsageEntry[] = [];
		for (const ref of new Set(pool)) {
			const state = this.entries.get(ref);
			if (state) out.push({ model: ref, state });
		}
		return out;
	}

	async refresh(pool: readonly string[]): Promise<void> {
		const ctx = this.getContext();
		if (!ctx) return;
		const generation = this.generation;
		await Promise.all(
			[...new Set(pool)].map(async (ref) => {
				const model = findPoolModel(ref, ctx);
				if (!model) {

					this.setEntry(generation, ref, { kind: "unresolved", fetchedAt: this.now() });
					return;
				}
				await this.refreshRef(generation, ctx, ref, model);
			}),
		);
	}

	stop(): void {
		this.generation += 1;
		this.entries.clear();
		this.retryAfter.clear();

		this.inFlight.clear();
	}

	private async refreshRef(
		generation: number,
		ctx: ExtensionContext,
		ref: string,
		model: ProviderUsageModel,
	): Promise<void> {
		let access: ProviderAccess | null;
		try {
			access = await this.resolveAccess(ctx, model, this.accessConfig());
		} catch {
			access = null;
		}
		if (!access) {
			this.setEntry(generation, ref, { kind: "no-credential", fetchedAt: this.now() });
			return;
		}
		const key = providerAccessKey(access);
		const now = this.now();
		const retryAt = this.retryAfter.get(key);
		if (retryAt !== undefined && retryAt > now) {

			if (!this.entries.has(ref)) this.setEntry(generation, ref, { kind: "pending", fetchedAt: now });
			return;
		}
		const cached = this.cache.read(key);
		if (cached && now - cached.fetchedAt <= this.resolveTtlMs()) {
			this.setEntry(generation, ref, { kind: "ready", snapshot: cached });
			return;
		}

		let entry = this.inFlight.get(key);
		if (!entry || entry.generation !== generation) {
			const record: InFlightJob = { generation, job: this.runQuery(generation, key, access) };
			this.inFlight.set(key, record);

			record.job.then(
				() => this.releaseInFlight(key, record),
				() => this.releaseInFlight(key, record),
			);
			entry = record;
		}
		const state = await entry.job.catch(() => ({ kind: "failed" }) as PoolUsageState);
		this.setEntry(generation, ref, state);
	}

	private async runQuery(generation: number, key: string, access: ProviderAccess): Promise<PoolUsageState> {
		let result: UsageQueryResult;
		try {
			result = await this.query(access);
		} catch {
			result = { status: "failed" };
		}
		const alive = generation === this.generation;
		const now = this.now();
		if (result.status === "success") {
			if (alive) {
				this.cache.write(key, result.snapshot);
				this.retryAfter.delete(key);
			}
			return { kind: "ready", snapshot: result.snapshot };
		}
		if (result.status === "unsupported") {
			if (alive) this.retryAfter.set(key, now + this.retryMs);
			return { kind: "unsupported", fetchedAt: now };
		}

		const cached = this.cache.read(key);
		if (cached && now - cached.fetchedAt <= this.keepLastGoodMs) {
			if (alive) this.retryAfter.set(key, now + this.retryMs);
			return { kind: "ready", snapshot: cached };
		}
		if (alive) this.retryAfter.set(key, now + this.retryMs);
		return { kind: "failed", fetchedAt: now };
	}

	private setEntry(generation: number, ref: string, state: PoolUsageState): void {
		if (generation !== this.generation) return;
		this.entries.set(ref, state);
	}

	private releaseInFlight(key: string, record: InFlightJob): void {
		if (this.inFlight.get(key) === record) this.inFlight.delete(key);
	}

	private resolveTtlMs(): number {
		const value = typeof this.ttlMs === "function" ? this.ttlMs() : this.ttlMs;
		return Number.isFinite(value) && value > 0 ? value : DEFAULT_PROVIDER_REFRESH_MS;
	}
}
