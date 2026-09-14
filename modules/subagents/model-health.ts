// 候选模型运行状态（工单 25 第一版）：数据结构 + 判定推导 + 接入边界。
//
// 分层（ADR 0007 决策 3 的三类数据里的第三类——供应商适配器侧）：
//   providers 域原始观测（providers.pool-usage 句柄的 PoolUsageState）
//   → 本文件 deriveModelRuntimeStatus 推导编排判定（ModelRuntimeStatus）
//   → model-selector.selectModelCandidate 按判定过滤候选（只排除硬阻断）
//
// 判定词汇表（规格《模型编排》§7 状态摘要 + 工单 25 六态）：
//   available      可用
//   quota-blocked  额度不足（余额耗尽或额度窗口剩 0%）——硬阻断，不得继续选择
//   unstable       服务不稳定（限流/过载/错误率/延迟异常）
//   offline        模型下线——硬阻断，不得继续选择
//   unknown        状态未知——绝不阻断选择（ADR 0007 决策 4）
//   unconfigured   未配置（无凭据或该供应商没有查询路由）——不阻断
//
// 诚实边界：
// - 查询失败/无路由/目录查不到模型一律推导为 unknown / unconfigured，
//   绝不把「查不到」伪造成「额度不足」，也不无条件停摆整个编排；
// - unstable 的生产者是工单 26 的错误观测（ModelErrorJournal）：子代理
//   运行失败的临时性错误分类（限流/过载/超时/临时服务错误）写入日志，
//   网关读取时合并成 unstable 判定与信号；供应商健康端点无法用一手
//   代码确认的一律停在 unknown，不猜端点（工单 25 范围裁决）；
// - 状态数据只存在于运行态（内存句柄 + providers 的磁盘快照缓存），
//   永不写回静态模型配置（tier 候选池）——查询失败不污染配置。
//
// 依赖方向：model-health.ts → routing.ts（思考等级后缀词汇表，单向）与
// providers/api.ts（类型与常量的静态导出面）；model-selector.ts → 本文件。
// providers 模块不反向依赖本文件（它的句柄只回报原始观测）。

import { modelOwnThinkingSuffix } from "./routing.ts";
import {
  PROVIDERS_POOL_USAGE_SERVICE_NAME,
  type PoolUsageState,
  type ProvidersPoolUsageService,
  type UsageSnapshot,
} from "../providers/api.ts";

/** 判定词汇表（工单 25）：顺序即状态摘要的展示优先级，供后续工单（27/28）复用。 */
export const MODEL_RUNTIME_VERDICTS = [
  "available",
  "quota-blocked",
  "unstable",
  "offline",
  "unknown",
  "unconfigured",
] as const;

export type ModelRuntimeVerdict = (typeof MODEL_RUNTIME_VERDICTS)[number];

/**
 * 运行健康信号（规格 §5：限流、过载、错误率、延迟）。工单 26 起由错误
 * 观测日志（ModelErrorJournal）填充：近期临时故障 → rateLimited /
 * overloaded；persistent 窗口内反复临时故障 → persistentlyUnstable（规格
 * §5「持续过载不得继续选择」，选择器据此跳过）。
 */
export interface ModelHealthSignals {
  /** 限流中（运行时错误观测报告） */
  readonly rateLimited?: boolean;
  /** 服务过载 */
  readonly overloaded?: boolean;
  /** 持续不稳定：persistent 窗口内多次临时故障（选择器按规格 §5 跳过） */
  readonly persistentlyUnstable?: boolean;
  /** 最近观测窗口的错误率（0-1）；无观测为 undefined */
  readonly errorRate?: number;
  /** 最近一次探测/调用的往返延迟（毫秒） */
  readonly latencyMs?: number;
}

/** 单个候选模型的运行状态判定（编排与后续面板共用的最小单元，ADR 0007）。 */
export interface ModelRuntimeStatus {
  readonly verdict: ModelRuntimeVerdict;
  /** 信号（第一版恒为空对象；工单 26 的错误观测开始填充） */
  readonly signals?: ModelHealthSignals;
  /** 最近一次状态确认时间（epoch 毫秒）；从未成功检查为 null */
  readonly lastCheckedAt: number | null;
  /** 人可读补充（诊断与后续状态摘要展示用）；不参与阻断决策 */
  readonly detail?: string;
}

/** 候选池运行状态表：键 = 候选基础引用（已剥思考等级后缀）。 */
export type ModelHealthMap = ReadonlyMap<string, ModelRuntimeStatus>;

/**
 * 硬阻断判定（工单 25）：额度不足与模型下线不得继续选择。其余判定
 * （unstable/unknown/unconfigured）不排除候选——状态未知绝不能让整个
 * 模型编排无条件停摆（规格 §5、ADR 0007 决策 4）。持续过载是规格 §5
 * 明确的例外，经 signals.persistentlyUnstable 表达（工单 26），由选择器
 * 跳过，不并入本判定（单次 unstable 仍不排除）。
 */
export function isHardBlockedVerdict(verdict: ModelRuntimeVerdict): boolean {
  return verdict === "quota-blocked" || verdict === "offline";
}

// ── 错误观测日志（工单 26：unstable 判定的生产者） ───────────────────

/**
 * 可写入错误观测的临时性错误类别（route-error.ts 词汇表的子集：仅
 * retryable 的两类——限流/过载与临时服务错误）。凭据、参数、额度、上下文
 * 类错误不掺入不稳定判定：它们不是「服务不稳定」，各自有既定处理路径
 * （额度走选择期硬阻断，其余交还编排者决策）。
 */
export type ModelErrorObservationKind = "rate_limited" | "provider_error";

/** 单条错误观测（内存态，不落盘、不进静态配置）。 */
export interface ModelErrorObservation {
  readonly kind: ModelErrorObservationKind;
  readonly message: string;
  /** 观测时间（epoch 毫秒）。 */
  readonly observedAt: number;
}

/** 近期临时故障计入 transient 信号的窗口（毫秒）。 */
export const MODEL_ERROR_TRANSIENT_WINDOW_MS = 2 * 60_000;

/** 「持续不稳定」判定的统计窗口（毫秒）。 */
export const MODEL_ERROR_PERSISTENT_WINDOW_MS = 10 * 60_000;

/** persistent 窗口内的观测次数达到该阈值 → 持续不稳定（规格 §5 持续过载）。 */
export const MODEL_ERROR_PERSISTENT_THRESHOLD = 3;

/**
 * 模型错误观测日志：按候选基础引用记录最近的临时性运行错误，供网关
 * 读取合并（选择器与后续 27/28 展示共用同一状态）。纯内存、会话作用域
 * （session_shutdown 清空）；record 只收临时性类别，其余静默忽略。
 */
export interface ModelErrorJournal {
  /** 日志时钟（测试注入用）。 */
  readonly now: () => number;
  /** 记一条错误观测（非临时性类别被忽略；modelRef 可带 ":level" 后缀）。 */
  record(modelRef: string, observation: { kind: ModelErrorObservationKind; message: string; observedAt?: number }): void;
  /** 该候选的观测列表（按基础引用归档，时间升序；窗口外历史已被修剪）。 */
  observations(modelRef: string): readonly ModelErrorObservation[];
  /** 清空全部观测（会话结束）。 */
  clear(): void;
}

export function createModelErrorJournal(now: () => number = Date.now): ModelErrorJournal {
  const byModel = new Map<string, ModelErrorObservation[]>();
  return {
    now,
    record(modelRef, observation) {
      // 防御：类型之外的越界类别（如测试/未来调用方直接传 route kind）不掺入。
      if (observation.kind !== "rate_limited" && observation.kind !== "provider_error") return;
      const base = baseModelRef(modelRef);
      const at = observation.observedAt ?? now();
      const list = [...(byModel.get(base) ?? []), {
        kind: observation.kind,
        message: observation.message,
        observedAt: at,
      }];
      // 有界内存：persistent 窗口外的历史不再保留。
      const cutoff = at - MODEL_ERROR_PERSISTENT_WINDOW_MS;
      byModel.set(base, list.filter((item) => item.observedAt >= cutoff));
    },
    observations(modelRef) {
      return [...(byModel.get(baseModelRef(modelRef)) ?? [])];
    },
    clear() {
      byModel.clear();
    },
  };
}

/**
 * 错误观测 → 编排判定（纯函数）：
 * - persistent 窗口内观测达到阈值 → unstable + signals.persistentlyUnstable
 *   （规格 §5「持续过载不得继续选择」，选择器据此跳过）；
 * - 否则 transient 窗口内有观测 → unstable + rateLimited/overloaded 信号
 *   （不排除候选，选择仍按用户顺序，运行期降级由重试策略承担）；
 * - 观测全部过期 / 无观测 → null（不报告，不虚构）。
 */
export function deriveErrorObservationStatus(
  observations: readonly ModelErrorObservation[],
  now: number,
): ModelRuntimeStatus | null {
  if (observations.length === 0) return null;
  const withinTransient = observations.filter((o) => now - o.observedAt <= MODEL_ERROR_TRANSIENT_WINDOW_MS);
  const withinPersistent = observations.filter((o) => now - o.observedAt <= MODEL_ERROR_PERSISTENT_WINDOW_MS);
  const persistentlyUnstable = withinPersistent.length >= MODEL_ERROR_PERSISTENT_THRESHOLD;
  if (withinTransient.length === 0 && !persistentlyUnstable) return null;
  const latest = observations.reduce((a, b) => (b.observedAt >= a.observedAt ? b : a));
  const rateLimited = withinTransient.some((o) => o.kind === "rate_limited");
  const overloaded = withinTransient.some((o) => /overload/i.test(o.message));
  const detail = persistentlyUnstable
    ? `${withinPersistent.length} transient failures within ` +
      `${Math.round(MODEL_ERROR_PERSISTENT_WINDOW_MS / 60_000)} min (latest: ${latest.message})`
    : `transient failure ${Math.round((now - latest.observedAt) / 1000)}s ago: ${latest.message}`;
  return {
    verdict: "unstable",
    signals: {
      ...(rateLimited ? { rateLimited: true } : {}),
      ...(overloaded ? { overloaded: true } : {}),
      ...(persistentlyUnstable ? { persistentlyUnstable: true } : {}),
    },
    lastCheckedAt: latest.observedAt,
    detail,
  };
}

/** providers 判定与错误观测合成：硬阻断（额度/下线）优先，错误信号并入；
 *  其余情形以（更新的）错误观测为准；两边都没有 → null（等价未知，不虚构）。 */
function mergeRuntimeStatuses(
  base: ModelRuntimeStatus | undefined,
  fromErrors: ModelRuntimeStatus | null,
): ModelRuntimeStatus | null {
  if (fromErrors == null) return base ?? null;
  if (base == null) return fromErrors;
  if (isHardBlockedVerdict(base.verdict)) {
    return { ...base, ...(fromErrors.signals ? { signals: fromErrors.signals } : {}) };
  }
  return fromErrors;
}

/** 候选引用的基础形态：剥掉合法的 ":thinking" 后缀（与目录查找同一口径）。 */
export function baseModelRef(ref: string): string {
  const own = modelOwnThinkingSuffix(ref);
  return own ? ref.slice(0, ref.length - own.length - 1) : ref;
}

/** 池内引用去重后的基础引用列表（保序；查询与查表共用同一套键）。 */
export function poolBaseRefs(pool: readonly string[]): string[] {
  const seen = new Set<string>();
  const refs: string[] = [];
  for (const ref of pool) {
    const base = baseModelRef(ref);
    if (!seen.has(base)) {
      seen.add(base);
      refs.push(base);
    }
  }
  return refs;
}

/**
 * 由供应商用量快照推导判定（纯函数）：
 * - 余额耗尽（amount <= 0）或任一额度窗口剩 0% → quota-blocked（窗口 0
 *   视为当前被限额挡住，resetMs 恢复信息留在 detail）；
 * - 无余额无窗口（供应商没给可判定的数据）→ unknown，不虚构；
 * - 其余 → available。
 */
function verdictFromSnapshot(snapshot: UsageSnapshot): ModelRuntimeStatus {
  const balance = snapshot.balance;
  const exhaustedWindow = snapshot.windows.find((window) => window.remainingPercent <= 0);
  const balanceBlocked = balance != null && balance.amount <= 0;
  if (balanceBlocked || exhaustedWindow) {
    const reasons: string[] = [];
    if (balanceBlocked) {
      reasons.push(`balance exhausted (${balance.amount} ${balance.currency})`);
    }
    if (exhaustedWindow) {
      reasons.push(
        `quota window "${exhaustedWindow.label}" at ${exhaustedWindow.remainingPercent}%` +
          (exhaustedWindow.resetMs != null ? ` (resets at ${new Date(exhaustedWindow.resetMs).toISOString()})` : ""),
      );
    }
    return { verdict: "quota-blocked", lastCheckedAt: snapshot.fetchedAt, detail: reasons.join("; ") };
  }
  if (balance == null && snapshot.windows.length === 0) {
    return {
      verdict: "unknown",
      lastCheckedAt: snapshot.fetchedAt,
      detail: "provider query returned no balance or quota data",
    };
  }
  return { verdict: "available", lastCheckedAt: snapshot.fetchedAt };
}

/**
 * providers 域原始观测 → 编排判定（工单 25 的判定推导入口）：
 * - ready：按快照推导（额度耗尽/窗口 0% → quota-blocked；有数据 → available）；
 * - unsupported / no-credential：unconfigured（该供应商没有可行查询路径）；
 * - failed / pending / unresolved / 无记录：unknown——查询失败、在途、目录
 *   查不到模型都不是「不可用」，绝不阻断选择。
 */
export function deriveModelRuntimeStatus(state: PoolUsageState | undefined): ModelRuntimeStatus {
  if (!state) {
    return { verdict: "unknown", lastCheckedAt: null, detail: "no status recorded" };
  }
  switch (state.kind) {
    case "ready":
      return verdictFromSnapshot(state.snapshot);
    case "unsupported":
      return { verdict: "unconfigured", lastCheckedAt: null, detail: "no query route for provider" };
    case "no-credential":
      return { verdict: "unconfigured", lastCheckedAt: null, detail: "no credentials resolved for provider" };
    case "failed":
      return { verdict: "unknown", lastCheckedAt: null, detail: "provider query failed" };
    case "pending":
      return { verdict: "unknown", lastCheckedAt: null, detail: "provider query in flight" };
    case "unresolved":
      return {
        verdict: "unknown",
        lastCheckedAt: null,
        detail: "model not in host catalog; provider status unobservable",
      };
  }
}

/**
 * 模型健康网关（编排侧的接入边界，工单 25）：启动链经它同步读最近已知
 * 状态、fire-and-forget 触发后台刷新。read 永不抛错、永不做网络请求；
 * 句柄缺席（providers 模块禁用）时返回空表——全员状态未知，选择行为
 * 与没有本工单完全一致（状态未知不停摆）。
 */
export interface ModelHealthGateway {
  /** 读取候选池最近已知状态（同步、无网络；未查询过的候选不在表内 = unknown） */
  read(pool: readonly string[]): ModelHealthMap;
  /** 触发后台刷新（异步 fire-and-forget；任何失败静默吞掉） */
  refresh(pool: readonly string[]): void;
}

/**
 * 把服务注册表里的 `providers.pool-usage` 句柄适配成编排网关。句柄查找是
 * 延迟的（providers 在 subagents 之后装配，且可能被禁用）：每次 read /
 * refresh 现取，缺席即空表/空操作。工单 26 起可挂错误观测日志：read 把
 * providers 判定与错误观测合成（见 mergeRuntimeStatuses），同一日志供
 * 工具层失败时写入（record），选择与观测读同一份状态（ADR 0007）。
 */
export function createProvidersHealthGateway(
  services: { get<T>(name: string): T | undefined },
  journal?: ModelErrorJournal,
): ModelHealthGateway {
  const resolve = () => services.get<ProvidersPoolUsageService>(PROVIDERS_POOL_USAGE_SERVICE_NAME);
  return {
    read(pool) {
      const refs = poolBaseRefs(pool);
      const map = new Map<string, ModelRuntimeStatus>();
      const service = resolve();
      if (!service && !journal) return map;
      const known = new Map(
        (service ? service.snapshot(refs) : []).map((entry) => [entry.model, entry.state] as const),
      );
      for (const ref of refs) {
        // 只对 providers 报告过状态的候选推导判定（工单 25 语义：从未查询过
        // 的候选不在表内 = 未知）；错误观测独立成条（日志有记录即有状态）。
        const state = known.get(ref);
        const base = state !== undefined ? deriveModelRuntimeStatus(state) : undefined;
        const fromErrors = journal
          ? deriveErrorObservationStatus(journal.observations(ref), journal.now())
          : null;
        const merged = mergeRuntimeStatuses(base, fromErrors);
        if (merged) map.set(ref, merged);
      }
      return map;
    },
    refresh(pool) {
      const service = resolve();
      if (!service) return;
      void service.refresh(poolBaseRefs(pool)).catch(() => {});
    },
  };
}
