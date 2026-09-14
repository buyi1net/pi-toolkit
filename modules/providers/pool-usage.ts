// 候选池供应商状态查询器（工单 25）：面向模型编排的多候选用量观测。
//
// 与 PiProviderUsageController（单活跃模型的周期轮询，供 tui 状态栏）平级共存：
// 本查询器不轮询、只按需刷新——编排侧（subagents 启动链）在计划 spawn 时
// fire-and-forget 触发 refresh，当轮选择读最近已知状态（snapshot，同步无网络），
// 下一轮 spawn 受益。查询完全复用既有内核，不重复造供应商查询：
//   resolvePiProviderAccess（凭据解析，与状态栏同一实现）
//   → queryProviderUsage（内核路由表 / 解析器 / 连接器，供应商端点只此一处登记）
//   → FileUsageSnapshotCache（与状态栏共用同一磁盘缓存：同一供应商身份的
//     快照只查一次网络，状态栏与候选池互相预热）
//
// 诚实边界（ADR 0007 决策 4）：查询失败、无路由、无凭据、目录查不到模型都
// 只如实回报对应状态（failed / unsupported / no-credential / unresolved），
// 绝不推断为「额度不足」——判定（verdict）由消费方（subagents/model-health.ts）
// 推导，本文件不掺编排语义。

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

/** 供应商查询快照缓存的默认根目录（与 PiProviderUsageController 同一份缓存）。 */
export const DEFAULT_POOL_USAGE_CACHE_ROOT = USAGE_SNAPSHOT_CACHE_ROOT;

/** 与内核 UsageRuntime 的默认 last-good 时限一致：失败后近期缓存仍可沿用。 */
const DEFAULT_KEEP_LAST_GOOD_MS = 10 * 60_000;

export interface PoolUsageTrackerOptions {
	/** 缓存有效期（毫秒）：未超龄的候选直接用缓存快照，不发起网络查询；传函数则每次刷新现取 */
	ttlMs?: number | (() => number);
	/** 查询失败/无路由后的退避时长（毫秒）：退避期内同供应商身份不再发起查询 */
	retryMs?: number;
	/** 查询失败后仍沿用磁盘缓存快照的时限（毫秒），语义同内核 keepLastGood */
	keepLastGoodMs?: number;
	userAgent?: string;
	/** 查询实现；默认走内核 queryProviderUsage，测试注入替身 */
	query?: (access: ProviderAccess) => Promise<UsageQueryResult>;
	cache?: UsageSnapshotCache;
	resolveAccess?: AccessResolver;
	now?: () => number;
}

/**
 * 在宿主模型目录里按引用找模型（口径与 subagents/model-selector.ts 的
 * findCatalogModel 一致：`provider/id` 精确匹配优先，裸 id 唯一命中兜底，
 * 查不到或歧义返回 null）。调用方（编排网关）传入的是已剥思考等级后缀的
 * 基础引用；本模块不认识思考等级词汇表，也不该认识。
 */
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

/** 在途查询登记：generation 决定能否跨会话复用，身份比对用于完成时清理。 */
interface InFlightJob {
	readonly generation: number;
	readonly job: Promise<PoolUsageState>;
}

/**
 * 候选池用量观测器：按候选引用维护最近一次查询状态，供编排侧同步读取。
 * 会话未绑定（session_start 前）时 refresh 是空操作；stop() 清空全部状态，
 * 在途查询的结果按代际丢弃，不会写回新会话。
 */
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

	/** 读取候选池最近已知状态（同步、无网络）；从未查询过的候选不在返回值里。 */
	snapshot(pool: readonly string[]): PoolUsageEntry[] {
		const out: PoolUsageEntry[] = [];
		for (const ref of new Set(pool)) {
			const state = this.entries.get(ref);
			if (state) out.push({ model: ref, state });
		}
		return out;
	}

	/**
	 * 触发一次候选池后台查询：逐候选解析凭据并查询；同供应商身份（凭据指纹
	 * 相同）共享一次网络查询；缓存未超龄直接命中；失败退避期内跳过。任何
	 * 单候选异常都被吞掉（状态查询失败不阻断编排，见工单 25 边界）。
	 */
	async refresh(pool: readonly string[]): Promise<void> {
		const ctx = this.getContext();
		if (!ctx) return;
		const generation = this.generation;
		await Promise.all(
			[...new Set(pool)].map(async (ref) => {
				const model = findPoolModel(ref, ctx);
				if (!model) {
					this.setEntry(generation, ref, { kind: "unresolved" });
					return;
				}
				await this.refreshRef(generation, ctx, ref, model);
			}),
		);
	}

	/** 会话结束：清空全部状态；在途查询按代际丢弃结果（不写回新会话，也不被新会话复用）。 */
	stop(): void {
		this.generation += 1;
		this.entries.clear();
		this.retryAfter.clear();
		// 在途登记一并清空；旧 job 完成时按身份比对，不会误删新代登记
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
			this.setEntry(generation, ref, { kind: "no-credential" });
			return;
		}
		const key = providerAccessKey(access);
		const now = this.now();
		const retryAt = this.retryAfter.get(key);
		if (retryAt !== undefined && retryAt > now) {
			// 退避中：保留既有状态；从未有过结果的候选标 pending（状态未知）
			if (!this.entries.has(ref)) this.setEntry(generation, ref, { kind: "pending" });
			return;
		}
		const cached = this.cache.read(key);
		if (cached && now - cached.fetchedAt <= this.resolveTtlMs()) {
			this.setEntry(generation, ref, { kind: "ready", snapshot: cached });
			return;
		}
		// 同代共享在途查询；跨代（stop() 之后的新会话）必须重新发起——旧 job 的
		// 结果按代际丢弃，不能顶替新会话自己的查询结果。
		let entry = this.inFlight.get(key);
		if (!entry || entry.generation !== generation) {
			const record: InFlightJob = { generation, job: this.runQuery(generation, key, access) };
			this.inFlight.set(key, record);
			// 清理按身份比对：旧 job 晚于新 job 结束时不得误删新登记。
			record.job.then(
				() => this.releaseInFlight(key, record),
				() => this.releaseInFlight(key, record),
			);
			entry = record;
		}
		const state = await entry.job.catch(() => ({ kind: "failed" }) as PoolUsageState);
		this.setEntry(generation, ref, state);
	}

	/** 单供应商身份的一次查询：成功落缓存；失败/无路由按 keepLastGood 沿用近期缓存。 */
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
			return { kind: "unsupported" };
		}
		// failed：近期（keepLastGood 内）缓存仍如实沿用（快照自带 fetchedAt，
		// 消费方看得见数据年龄），否则如实回报失败——绝不伪造成额度不足。
		const cached = this.cache.read(key);
		if (cached && now - cached.fetchedAt <= this.keepLastGoodMs) {
			if (alive) this.retryAfter.set(key, now + this.retryMs);
			return { kind: "ready", snapshot: cached };
		}
		if (alive) this.retryAfter.set(key, now + this.retryMs);
		return { kind: "failed" };
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
