import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	futimesSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	findProviderById,
	findProviderByUrl,
	type BuiltinQueryKind,
} from "../shared/provider-catalog.ts";
import {
	detectProviderKind,
	fetchConfiguredProviderUsage,
	fetchProviderUsage,
	findProviderQueryConfig,
} from "./provider-usage.ts";
import {
	isLastGoodUsable,
	markUsageSnapshotStale,
	normalizeEndpoint,
	normalizeUsageSnapshot,
	planSourceRefresh,
	planUsageFailure,
	resolveProviderMetadata,
	usageRefreshDue,
	usageRetryDue,
	SOURCE_RETRY_MS,
	type BillingMode,
	type CacheEntry,
	type ProviderAccess,
	type ProviderAccessOptions,
	type SourceState,
	type UsageSnapshot,
} from "../usage-core/index.ts";

export type UsageQueryResult =
	| { status: "success"; snapshot: UsageSnapshot }
	| { status: "unsupported" }
	| { status: "failed" };

export type UsageRuntimeStatus =
	| "idle"
	| "loading"
	| "ready"
	| "stale"
	| "error"
	| "unsupported";

export interface UsageRuntimeState {
	status: UsageRuntimeStatus;
	provider: { id: string; brandName: string } | null;
	snapshot: UsageSnapshot | null;
}

export interface ProviderIdentityHint {
	providerId: string;
	endpoint: string;
	modelId?: string;
}

export interface CreateProviderAccessInput {
	providerId: string;
	modelId?: string;
	endpoint: string;
	credential: string;
	authKind?: "api-key" | "oauth";
	accountId?: string;
	githubDomain?: string;
	query?: ProviderAccessOptions["query"];
	credentials?: ProviderAccessOptions["credentials"];
}

export interface UsageRuntimeOptions {
	userAgent?: string;
	keepLastGoodMs?: number;
	retryBackoffMs?: number;
	query?: (access: ProviderAccess) => Promise<UsageQueryResult>;
	onChange?: (state: UsageRuntimeState) => void;
	now?: () => number;
	cache?: UsageSnapshotCache;
}

export interface UsageSnapshotCache {
	read(identityKey: string): UsageSnapshot | null;
	write(identityKey: string, snapshot: UsageSnapshot): void;
}

export { findProviderQueryConfig };

export { detectProviderKind };

export { fetchProviderUsage, fetchConfiguredProviderUsage };
export type {
	ConfiguredProviderUsageQuery,
	ProviderKind,
	ProviderUsageQuery,
} from "./provider-usage.ts";
export type { ProviderQueryCredentials } from "../shared/provider-contracts.ts";

const DEFAULT_KEEP_LAST_GOOD_MS = 10 * 60_000;
const DEFAULT_RETRY_BACKOFF_MS = 30_000;

function isUsageSnapshot(value: unknown): value is UsageSnapshot {
	if (!value || typeof value !== "object") return false;
	const snapshot = value as Partial<UsageSnapshot>;
	const balanceValid = snapshot.balance === null || (
		!!snapshot.balance &&
		Number.isFinite(snapshot.balance.amount) &&
		(snapshot.balance.currency === "CNY" || snapshot.balance.currency === "USD")
	);
	const windowsValid = Array.isArray(snapshot.windows) && snapshot.windows.every((window) => (
		typeof window?.label === "string" &&
		Number.isFinite(window?.remainingPercent) &&
		(window?.resetMs === null || Number.isFinite(window?.resetMs))
	));
	return (
		typeof snapshot.provider?.id === "string" &&
		typeof snapshot.provider?.brandName === "string" &&
		["subscription", "api", "hybrid", "unknown"].includes(snapshot.billingMode ?? "") &&
		balanceValid &&
		windowsValid &&
		typeof snapshot.fetchedAt === "number" &&
		Number.isFinite(snapshot.fetchedAt) &&
		(snapshot.freshness === "fresh" || snapshot.freshness === "stale")
	);
}

function writeCacheAtomically(root: string, target: string, payload: string): void {
	const temporary = `${target}.${process.pid}-${Date.now()}.tmp`;
	try {
		mkdirSync(root, { recursive: true });
		writeFileSync(temporary, payload, { encoding: "utf8", mode: 0o600 });
		renameSync(temporary, target);
	} catch {
		try {
			unlinkSync(temporary);
		} catch {
			// 临时文件清理失败可接受：下次写入会换新的临时文件名。
		}
	}
}

export class FileUsageSnapshotCache implements UsageSnapshotCache {
	private readonly root: string;

	constructor(root: string) {
		this.root = root;
	}

	private path(identityKey: string): string {
		const fingerprint = createHash("sha256").update(identityKey).digest("hex");
		return join(this.root, `${fingerprint}.json`);
	}

	read(identityKey: string): UsageSnapshot | null {
		try {
			const value: unknown = JSON.parse(readFileSync(this.path(identityKey), "utf8"));
			return isUsageSnapshot(value) ? value : null;
		} catch {
			return null;
		}
	}

	write(identityKey: string, snapshot: UsageSnapshot): void {
		writeCacheAtomically(this.root, this.path(identityKey), JSON.stringify(snapshot));
	}
}

export function createProviderAccess(input: CreateProviderAccessInput): ProviderAccess {
	const endpoint = normalizeEndpoint(input.endpoint);
	const metadata = resolveProviderMetadata(endpoint, input.providerId, input.modelId);
	const stableOAuthAccount = input.authKind === "oauth" && input.accountId
		? input.accountId
		: null;
	const accountFingerprint = createHash("sha256")
		.update(JSON.stringify({
			credential: stableOAuthAccount ? null : input.credential,
			modelId: input.modelId ?? null,
			query: input.query ?? null,
			credentials: input.credentials ?? null,
			accountId: stableOAuthAccount,
			githubDomain: input.githubDomain ?? null,
		}))
		.digest("hex")
		.slice(0, 16);
	return {
		identity: {
			providerId: metadata.providerId,
			endpoint,
			accountFingerprint,
		},
		credential: input.credential,
		options: input.authKind || input.query || input.credentials || input.accountId || input.githubDomain || input.modelId
			? {
				modelId: input.modelId,
				authKind: input.authKind,
				accountId: input.accountId,
				githubDomain: input.githubDomain,
				query: input.query,
				credentials: input.credentials,
			}
			: undefined,
	};
}

export function providerAccessKey(access: ProviderAccess): string {
	const identity = access.identity;
	return `${identity.providerId}:${identity.endpoint}:${identity.accountFingerprint}`;
}

function providerIdentityKey(identity: ProviderIdentityHint): string {
	const endpoint = normalizeEndpoint(identity.endpoint);
	const metadata = resolveProviderMetadata(endpoint, identity.providerId, identity.modelId ?? "");
	return `${metadata.providerId}\0${endpoint}`;
}

function resolveQueryKind(access: ProviderAccess): BuiltinQueryKind | "unknown" {
	const endpointKind =
		findProviderByUrl(access.identity.endpoint)?.queryKind ??
		detectProviderKind(access.identity.endpoint);
	if (endpointKind !== "unknown") return endpointKind;

	if (!access.identity.endpoint && access.options?.authKind === "oauth") {
		return findProviderById(access.identity.providerId)?.queryKind ?? "unknown";
	}
	return "unknown";
}

export async function queryProviderUsage(
	access: ProviderAccess,
	request: typeof fetch = fetch,
	options: { userAgent?: string } = {},
): Promise<UsageQueryResult> {
	const kind = resolveQueryKind(access);
	const explicitQuery = access.options?.query ?? null;
	if (!explicitQuery && kind === "unknown") return { status: "unsupported" };
	if (!explicitQuery && kind.endsWith("-subscription") && access.options?.authKind !== "oauth") {
		return { status: "unsupported" };
	}
	if (!explicitQuery && !access.credential && !kind.startsWith("volcengine-")) return { status: "unsupported" };

	const usage = await fetchProviderUsage({
		kind,
		baseUrl: access.identity.endpoint,
		credentials: {
			token: access.credential,
			accountId: access.options?.accountId,
			githubDomain: access.options?.githubDomain,
			volcengine: access.options?.credentials?.volcengine,
			zhipuTeam: access.options?.credentials?.zhipuTeam,
			openrouter: access.options?.credentials?.openrouter,
		},
		request,
		userAgent: options.userAgent,
		query: explicitQuery ?? null,
	}).catch(() => null);
	if (!usage) return { status: "failed" };

	const providerId = usage.quota?.provider ?? explicitQuery?.id ?? access.identity.providerId;
	const metadata = resolveProviderMetadata(
		access.identity.endpoint,
		providerId,
		access.options?.modelId,
	);
	return {
		status: "success",
		snapshot: normalizeUsageSnapshot({
			providerId: metadata.providerId,
			brandName: explicitQuery?.displayName ?? metadata.brandName,
			billingMode: usage.mode,
			balance: usage.balance,
			windows: usage.quota?.windows,
		}),
	};
}

export class UsageRuntime {
	private readonly keepLastGoodMs: number;
	private readonly retryBackoffMs: number;
	private readonly query: (access: ProviderAccess) => Promise<UsageQueryResult>;
	private readonly onChange: (state: UsageRuntimeState) => void;
	private readonly now: () => number;
	private readonly cache: UsageSnapshotCache | undefined;
	private readonly inFlight = new Map<string, Promise<UsageQueryResult>>();
	private readonly retryAfter = new Map<string, number>();
	private state: UsageRuntimeState = { status: "idle", provider: null, snapshot: null };
	private activeIdentityKey = "";
	private activeKey = "";
	private revision = 0;
	private disposed = false;

	constructor(options: UsageRuntimeOptions = {}) {
		this.keepLastGoodMs = options.keepLastGoodMs ?? DEFAULT_KEEP_LAST_GOOD_MS;
		this.retryBackoffMs = options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
		this.query = options.query ?? ((access) => queryProviderUsage(access, fetch, { userAgent: options.userAgent }));
		this.onChange = options.onChange ?? (() => {});
		this.now = options.now ?? Date.now;
		this.cache = options.cache;
	}

	getState(): UsageRuntimeState {
		return this.state;
	}

	private update(state: UsageRuntimeState): void {
		if (this.disposed) return;
		this.state = state;
		this.onChange(state);
	}

	begin(identity: ProviderIdentityHint | null): void {
		if (this.disposed) return;
		const identityKey = identity ? providerIdentityKey(identity) : "";
		if (identityKey === this.activeIdentityKey) return;
		this.isolate(identityKey);
	}

	async commit(access: ProviderAccess | null): Promise<void> {
		if (this.disposed) return;
		const revision = ++this.revision;
		if (!access) {
			this.isolate("");
			return;
		}

		const key = providerAccessKey(access);
		const metadata = resolveProviderMetadata(
			access.identity.endpoint,
			access.identity.providerId,
			access.options?.modelId,
		);
		const provider = { id: metadata.providerId, brandName: metadata.brandName };
		if (key !== this.activeKey) {
			this.activeKey = key;
			this.activeIdentityKey = providerIdentityKey({
				providerId: access.identity.providerId,
				endpoint: access.identity.endpoint,
				modelId: access.options?.modelId,
			});
			const cached = this.cache?.read(key);
			if (cached && isLastGoodUsable(cached.fetchedAt, this.keepLastGoodMs, this.now())) {
				const stale = markUsageSnapshotStale(cached);
				this.update({ status: "stale", provider: stale.provider, snapshot: stale });
			} else {
				this.update({ status: "loading", provider, snapshot: null });
			}
		}
		if (!usageRetryDue(this.retryAfter.get(key) ?? 0, this.now())) return;

		let pending = this.inFlight.get(key);
		if (!pending) {
			pending = this.query(access).finally(() => this.inFlight.delete(key));
			this.inFlight.set(key, pending);
		}
		const result = await pending;
		if (this.disposed || revision !== this.revision || key !== this.activeKey) return;

		if (result.status === "success") {
			this.retryAfter.delete(key);
			this.cache?.write(key, result.snapshot);
			this.update({ status: "ready", provider: result.snapshot.provider, snapshot: result.snapshot });
			return;
		}
		if (result.status === "unsupported") {
			this.retryAfter.delete(key);
			this.update({ status: "unsupported", provider, snapshot: null });
			return;
		}

		const previous = this.state.snapshot;
		const failure = planUsageFailure(
			previous?.fetchedAt ?? null,
			this.keepLastGoodMs,
			this.retryBackoffMs,
			this.now(),
		);
		this.retryAfter.set(key, failure.retryAfter);
		if (failure.status === "stale" && previous) {
			const stale = markUsageSnapshotStale(previous);
			this.update({ status: "stale", provider: stale.provider, snapshot: stale });
			return;
		}
		this.update({ status: "error", provider, snapshot: null });
	}

	private isolate(identityKey: string): void {
		this.revision += 1;
		this.activeIdentityKey = identityKey;
		this.activeKey = "";
		this.update({ status: "idle", provider: null, snapshot: null });
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.revision += 1;
		this.inFlight.clear();
		this.retryAfter.clear();
	}
}

export class JsonFileCache {
	private readonly root: string;

	constructor(root: string) {
		this.root = root;
	}

	read<T>(name: string): CacheEntry<T> | null {
		try {
			return JSON.parse(readFileSync(join(this.root, name), "utf8"));
		} catch {
			return null;
		}
	}

	write<T>(name: string, value: T, now = Date.now()): void {
		writeCacheAtomically(this.root, join(this.root, name), JSON.stringify({ ts: now, value }));
	}
}

const SIDELINE_STATE_FILE = "source.json";

export interface SidelineUsageOptions {
	userAgent?: string;

	cacheRoot: string;

	spawnRefresh?: () => void;

	snapshotCache?: UsageSnapshotCache;

	retryMs?: number;

	orphanLockMs?: number;

	query?: (access: ProviderAccess) => Promise<UsageQueryResult>;
	now?: () => number;
	request?: typeof fetch;
}

export interface SidelineObserveOptions {
	quotaTtlMs: number;
	balanceTtlMs: number;
	forceRefresh?: boolean;
}

export interface SidelineObserveResult {

	usable: boolean;
	snapshot: UsageSnapshot | null;
}

export class SidelineUsageStore {
	private readonly root: string;
	private readonly spawnRefresh: (() => void) | undefined;
	private readonly snapshotCache: UsageSnapshotCache;
	private readonly files: JsonFileCache;
	private readonly retryMs: number;
	private readonly orphanLockMs: number;
	private readonly query: (access: ProviderAccess) => Promise<UsageQueryResult>;
	private readonly now: () => number;
	private readonly request: typeof fetch;

	constructor(options: SidelineUsageOptions) {
		this.root = options.cacheRoot;
		this.spawnRefresh = options.spawnRefresh;
		this.snapshotCache = options.snapshotCache ?? new FileUsageSnapshotCache(options.cacheRoot);
		this.files = new JsonFileCache(options.cacheRoot);
		this.retryMs = options.retryMs ?? SOURCE_RETRY_MS;
		this.orphanLockMs = options.orphanLockMs ?? 60_000;
		this.query = options.query ?? ((access) => queryProviderUsage(access, this.request, { userAgent: options.userAgent }));
		this.now = options.now ?? Date.now;
		this.request = options.request ?? fetch;
	}

	observe(access: ProviderAccess, options: SidelineObserveOptions): SidelineObserveResult {
		const now = this.now();
		const key = providerAccessKey(access);
		const state = this.files.read<SourceState>(SIDELINE_STATE_FILE)?.value ?? null;
		const snapshot = this.snapshotCache.read(key);
		const mode: BillingMode | null = snapshot?.billingMode ?? null;

		const age = snapshot ? now - snapshot.fetchedAt : Number.POSITIVE_INFINITY;
		const forceRefresh = options.forceRefresh === true;
		const dataStale = forceRefresh || usageRefreshDue(
			mode,
			age > options.quotaTtlMs,
			age > options.balanceTtlMs,
		);
		const plan = planSourceRefresh(
			{ providerKey: key },
			state,
			dataStale,
			now,
			this.retryMs,
			forceRefresh,
		);
		if (plan.nextState) this.files.write(SIDELINE_STATE_FILE, plan.nextState, now);
		if (plan.refresh) this.spawnRefresh?.();
		return { usable: plan.usable, snapshot: plan.usable ? snapshot : null };
	}

	async runRefresh(resolveAccess: () => ProviderAccess | null): Promise<void> {
		const target = this.files.read<SourceState>(SIDELINE_STATE_FILE)?.value ?? null;
		if (!target) return;
		const lock = this.lockPath(target.providerKey);
		const owner = randomUUID();
		if (!this.acquireLock(lock, owner)) return;
		try {
			const access = resolveAccess();
			if (!access || providerAccessKey(access) !== target.providerKey) return;
			const result = await this.query(access);

			const latest = resolveAccess();
			if (!latest || providerAccessKey(latest) !== target.providerKey) return;
			this.commit(target, access, result);
		} finally {
			try {

				if (readFileSync(lock, "utf8") === owner) unlinkSync(lock);
			} catch {
				// 锁已不在或不可读时，不冒险删除其它运行方的锁。
			}
		}
	}

	private lockPath(providerKey: string): string {
		const fingerprint = createHash("sha256").update(providerKey).digest("hex").slice(0, 16);
		return join(this.root, `.refresh-${fingerprint}.lock`);
	}

	private createLock(lock: string, owner: string): void {
		const fd = openSync(lock, "wx");
		try {
			writeFileSync(fd, owner, "utf8");

			const now = this.now() / 1_000;
			futimesSync(fd, now, now);
		} finally {
			closeSync(fd);
		}
	}

	private acquireLock(lock: string, owner: string): boolean {
		try {
			mkdirSync(this.root, { recursive: true });
			this.createLock(lock, owner);
			return true;
		} catch {
			try {

				if (this.now() - statSync(lock).mtimeMs > this.orphanLockMs) {
					unlinkSync(lock);
					this.createLock(lock, owner);
					return true;
				}
			} catch {
				// 覆盖失败
			}
			return false;
		}
	}

	private commit(target: SourceState, access: ProviderAccess, result: UsageQueryResult): void {
		const current = this.files.read<SourceState>(SIDELINE_STATE_FILE)?.value ?? null;
		if (!current || current.providerKey !== target.providerKey) return;
		if (result.status === "failed") {
			this.markFailure(target);
			return;
		}
		if (result.status === "success") {
			this.snapshotCache.write(target.providerKey, result.snapshot);
		} else {

			const metadata = resolveProviderMetadata(
				access.identity.endpoint,
				access.identity.providerId,
				access.options?.modelId,
			);
			this.snapshotCache.write(target.providerKey, {
				provider: { id: metadata.providerId, brandName: metadata.brandName },
				billingMode: "unknown",
				balance: null,
				windows: [],
				fetchedAt: this.now(),
				freshness: "fresh",
			});
		}
		this.files.write(SIDELINE_STATE_FILE, { ...current, status: "ready", attemptTs: this.now() }, this.now());
	}

	private markFailure(target: SourceState): void {
		const current = this.files.read<SourceState>(SIDELINE_STATE_FILE)?.value ?? null;
		if (!current || current.providerKey !== target.providerKey) return;
		const now = this.now();

		const lastGoodAt = current.status === "ready"
			? this.snapshotCache.read(target.providerKey)?.fetchedAt ?? now
			: null;
		const failure = planUsageFailure(lastGoodAt, Number.POSITIVE_INFINITY, this.retryMs, now);
		if (failure.status === "error") {
			this.files.write(SIDELINE_STATE_FILE, { ...current, status: "backoff", attemptTs: now }, now);
		}
	}
}
