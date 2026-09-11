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

/** 两段式 begin 阶段的身份提示：凭据异步解析完成前宿主已知的供应商信息。 */
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
// 宿主适配器识别查询能力用；供应商 kind 判定随查询入口一起暴露，避免宿主深路径直连 shared。
export { detectProviderKind };
// 查询入口：kind 路由与显式中转协议两类，凭据只经 ProviderQueryCredentials 一个通道。
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

/** 原子写缓存文件：失败只影响缓存新鲜度，不影响查询与显示。 */
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

/** 粗粒度供应商身份键：供应商 + 接入地址。begin 阶段账号指纹未知，只按供应商判隔离。 */
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

	// A provider/model label is not proof that an arbitrary relay endpoint belongs to
	// that provider. Never use it to redirect a relay credential to an official host.
	// Provider-only routing is reserved for endpoint-less OAuth identities supplied by
	// the host, where there is no inference API key to reuse across origins.
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

	/** 两段式第一段：只交身份。身份变化时立即隔离旧供应商数据，凭据就绪前旧快照不可见。 */
	begin(identity: ProviderIdentityHint | null): void {
		if (this.disposed) return;
		const identityKey = identity ? providerIdentityKey(identity) : "";
		if (identityKey === this.activeIdentityKey) return;
		this.isolate(identityKey);
	}

	/** 两段式第二段：交完整凭据发起真实查询；无凭据时保持隔离，不回放旧供应商数据。 */
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

	/** 隔离：作废在途结果并清空显示，旧供应商快照不再对新的身份可见。 */
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

/** 通用 {ts, value} 原子 JSON 文件缓存；根目录由宿主注入，读写失败静默降级。 */
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
	/** 缓存、状态与锁文件的根目录；由宿主注入，共享层不写死任何宿主路径。 */
	cacheRoot: string;
	/** 旁路刷新进程的触发方式；由宿主注入，渲染进程据状态机决策调用。 */
	spawnRefresh?: () => void;
	/** 快照缓存；默认在 cacheRoot 下按身份键分文件。 */
	snapshotCache?: UsageSnapshotCache;
	/** 失败退避时长，默认与刷新状态机一致。 */
	retryMs?: number;
	/** 孤儿锁判定阈值：超过后视为上次刷新进程已死亡，可覆盖。 */
	orphanLockMs?: number;
	/** 查询实现；默认走共享查询入口，测试可注入。 */
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
	/** 当前快照是否属于当前供应商且状态机允许用于布局。 */
	usable: boolean;
	snapshot: UsageSnapshot | null;
}

/**
 * 旁路刷新协调：面向「短生命周期渲染进程 + detached 刷新进程」的宿主（如状态栏）。
 * 渲染进程调 observe 只读缓存并推进状态机，必要时触发注入的刷新回调；
 * 刷新进程调 runRefresh 抢锁、身份复核后查询并原子提交。
 * 两个进程不共享内存，全部状态经由 cacheRoot 下的文件传递。
 */
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

	/** 渲染进程入口：读状态与快照、判定时效、必要时落盘新状态并触发旁路刷新。 */
	observe(access: ProviderAccess, options: SidelineObserveOptions): SidelineObserveResult {
		const now = this.now();
		const key = providerAccessKey(access);
		const state = this.files.read<SourceState>(SIDELINE_STATE_FILE)?.value ?? null;
		const snapshot = this.snapshotCache.read(key);
		const mode: BillingMode | null = snapshot?.billingMode ?? null;
		// 快照单一时间戳同时服务余额与额度时效判定，口径与分文件缓存时一致（同次提交同时落盘）
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

	/** 刷新进程入口：抢锁、复核身份、查询并提交；身份已被切换时弃用结果。 */
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
			// 身份复核：查询期间宿主配置可能被切换工具改写，旧供应商的结果不得提交
			const latest = resolveAccess();
			if (!latest || providerAccessKey(latest) !== target.providerKey) return;
			this.commit(target, access, result);
		} finally {
			try {
				// 查询超龄后可能已被接管，旧运行方不能释放新运行方的锁。
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
			// 文件系统时钟与注入时钟可能不同，锁龄必须使用同一时间基准。
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
				// 孤儿锁：超过阈值视为上次刷新进程死亡，覆盖
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

	/** 先写快照、最后把状态置 ready，避免渲染进程读到半套新状态。 */
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
			// 不可查询也提交一个 unknown 快照，渲染进程据此停止反复触发刷新
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

	/** 新数据源实际请求失败后才进入退避；周期刷新失败则继续显示同源旧值。 */
	private markFailure(target: SourceState): void {
		const current = this.files.read<SourceState>(SIDELINE_STATE_FILE)?.value ?? null;
		if (!current || current.providerKey !== target.providerKey) return;
		const now = this.now();
		// ready 代表已经提交过同源结果；即使快照文件缺失，也不把周期刷新失败当作首次失败。
		const lastGoodAt = current.status === "ready"
			? this.snapshotCache.read(target.providerKey)?.fetchedAt ?? now
			: null;
		const failure = planUsageFailure(lastGoodAt, Number.POSITIVE_INFINITY, this.retryMs, now);
		if (failure.status === "error") {
			this.files.write(SIDELINE_STATE_FILE, { ...current, status: "backoff", attemptTs: now }, now);
		}
	}
}
