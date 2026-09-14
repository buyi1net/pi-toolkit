// 模型与用量面板的静态导出面（工单 28 / ADR 0007）：
// 只放类型、常量与无状态纯函数；有状态能力（快照读出、终态记录）走服务注册表句柄
// `usage.snapshot` / `usage.recorder`。
//
// 数据分三类（ADR 0007 决策 3），消费方从同一份结构化快照读取：
//   1. Pi 消息提供的 Token / cost / 耗时 —— 由子代理终态结果带入统计记录；
//   2. 本地运行记录 —— 任务标识、代理、实际模型、思考等级、结果与降级信息；
//   3. 供应商适配器 —— 余额、额度与健康状态；未知一律保持 unknown，不伪造成零。
//
// 隐私口径（ADR 0007 决策 7）：统计默认只保存任务标识与截断摘要，不保存完整任务正文。

import type { ModelRuntimeStatus } from "../subagents/index.ts";

/** 模型与用量快照句柄名（读侧；编排查询接口） */
export const USAGE_SNAPSHOT_SERVICE_NAME = "usage.snapshot";
/** 子代理终态记录句柄名（写侧；只有子代理模块经它落统计） */
export const USAGE_RECORDER_SERVICE_NAME = "usage.recorder";

/** 任务标识保留的最大字符数：只保存单行摘要，永不保存完整任务正文 */
export const USAGE_TASK_LABEL_MAX = 80;
/** 错误摘要保留的最大字符数（诊断用，超出截断） */
export const USAGE_ERROR_MESSAGE_MAX = 240;
/** 快照附带展示的最近运行条数 */
export const USAGE_RECENT_LIMIT = 10;

/** 统计口径的终态结果（handed-off 不是终态，由恢复路径的真实终态取代） */
export type UsageOutcome = "completed" | "failed" | "cancelled";

/** 一次运行的 Token / 成本小计（与 session usage 的累计口径一致） */
export interface UsageRunTokens {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly costUsd: number;
}

/**
 * 子代理终态 → 统计事件的输入（由子代理模块在终态构造，usage 模块负责落盘语义）。
 * `task` 是完整任务正文，usage 模块在写入前只保留截断的单行标识。
 */
export interface UsageRunEvent {
  readonly name: string;
  readonly task: string;
  readonly sessionFile?: string | null;
  /**
   * 发起本次运行的宿主会话 id（工单 32）：由启动时快照随运行态带下来，
   * 终态落在 /reload 或新会话之后也按发起会话归属；旧调用方可不带。
   */
  readonly sessionId?: string | null;
  readonly cohortId?: string | null;
  readonly agent?: string | null;
  /** 实际调用模型的基础引用（已剥思考等级后缀） */
  readonly model?: string | null;
  readonly thinking?: string | null;
  /** 本次运行来自的档位（tier 路径）；显式 model 运行可能只有档位没有候选池 */
  readonly tier?: string | null;
  /** 候选池首选（tier 路径）：实际模型与它不同即降级 */
  readonly preferredModel?: string | null;
  readonly elapsedSeconds: number;
  readonly tokens?: UsageRunTokens | null;
  readonly toolCount?: number | null;
  readonly outcome: UsageOutcome;
  readonly exitCode: number;
  readonly routeErrorKind?: string | null;
  readonly routeErrorMessage?: string | null;
}

/** 持久化到统计日志的一条运行记录（只读；磁盘格式即本结构） */
export interface UsageRecord {
  readonly id: string;
  /** 终态时间（epoch 毫秒） */
  readonly at: number;
  /**
   * 归属会话：优先事件携带的「发起本次运行的宿主会话」，事件未携带时退回写入时刻的
   * 当前会话；宿主未绑定会话为 null（工单 32）
   */
  readonly sessionId: string | null;
  readonly sessionFile: string | null;
  readonly name: string;
  /** 单行、截断的任务标识：正文不整体落盘，≤80 字符时就是全量标识 */
  readonly taskLabel: string;
  readonly cohortId: string | null;
  readonly agent: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly thinking: string | null;
  readonly tier: string | null;
  readonly preferredModel: string | null;
  /** true=实际模型不是候选池首选；null=无法判定（显式 model / 旧记录） */
  readonly downgraded: boolean | null;
  readonly durationMs: number;
  readonly tokens: UsageRunTokens | null;
  readonly toolCount: number | null;
  readonly outcome: UsageOutcome;
  readonly exitCode: number;
  readonly routeErrorKind: string | null;
  readonly routeErrorMessage: string | null;
}

export interface UsageBalanceView {
  readonly amount: number;
  readonly currency: string;
}

export interface UsageQuotaWindowView {
  readonly label: string;
  readonly remainingPercent: number;
  readonly resetMs: number | null;
}

/** 供应商侧原始观测的种类；unrecorded=从未查询过（未知，不是零） */
export type UsageObservationKind =
  | "ready"
  | "unsupported"
  | "no-credential"
  | "failed"
  | "pending"
  | "unresolved"
  | "unrecorded";

/** 一个时间窗口（或一个维度分组）的用量总计 */
export interface UsageTotals {
  readonly runs: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalTokens: number;
  readonly costUsd: number;
  readonly durationMs: number;
}

/** 维度分组（模型 / 供应商 / 代理 / 任务）总计 */
export interface UsageBreakdown extends UsageTotals {
  readonly key: string;
}

/** 一个时间窗口的聚合：总量 + 四个维度排行（ADR 0007 决策 6） */
export interface UsageWindowView extends UsageTotals {
  readonly byModel: readonly UsageBreakdown[];
  readonly byProvider: readonly UsageBreakdown[];
  readonly byAgent: readonly UsageBreakdown[];
  readonly byTask: readonly UsageBreakdown[];
}

/** 快照里的单个候选模型：候选池范围 + 运行状态 + 用量 */
export interface UsageModelView {
  readonly model: string;
  readonly provider: string | null;
  /** 该模型当前出现在哪些档位的候选池里 */
  readonly tiers: readonly string[];
  /** 编排判定（工单 25/26 网关口径，含错误观测）；没有数据为 unknown */
  readonly health: ModelRuntimeStatus;
  /** 供应商原始观测种类（余额/额度未知的诚实来源） */
  readonly observation: UsageObservationKind;
  /** null=未知（查询失败/无凭据/无路由/从未查询），绝不伪造成 0 */
  readonly balance: UsageBalanceView | null;
  /** null=未知；空数组=供应商确实没有额度窗口 */
  readonly quota: readonly UsageQuotaWindowView[] | null;
  /** 供应商快照时间；无快照为 null */
  readonly fetchedAt: number | null;
  /** 最近一次状态确认时间（含错误观测） */
  readonly lastCheckedAt: number | null;
  /** 历史累计（仅当前候选池范围内的记录） */
  readonly totals: UsageTotals;
}

export interface UsageWindowSet {
  readonly current: UsageWindowView;
  readonly today: UsageWindowView;
  readonly week: UsageWindowView;
  readonly history: UsageWindowView;
}

/**
 * 模型与用量共享快照（只读）。用户面板与模型编排都从这里读取，
 * 编排逻辑不解析 TUI 文本（工单 28 验收）。
 */
export interface UsageSnapshotView {
  readonly generatedAt: number;
  /** 内容变化序号（内容变才递增），供重绘节奏使用 */
  readonly revision: number;
  readonly sessionId: string | null;
  /** 当前子代理候选池的基础模型引用（去重）；快照只统计这些模型 */
  readonly pool: readonly string[];
  readonly models: readonly UsageModelView[];
  readonly windows: UsageWindowSet;
  /** 最近运行（按终态时间倒序，最多 USAGE_RECENT_LIMIT 条）：实际模型/思考/结果/降级口径的逐条读面 */
  readonly recent: readonly UsageRecord[];
}

export interface UsageSnapshotQuery {
  /** tier 配置解析用的工作目录（项目级 pi-subagents.json 覆盖） */
  readonly cwd?: string;
  /** 测试注入时钟 */
  readonly now?: number;
}

/** 只读编排查询接口 + 尽力而为的后台刷新 */
export interface UsageSnapshotService {
  readonly id: "usage";
  snapshot(query?: UsageSnapshotQuery): UsageSnapshotView;
  /** 触发候选池供应商状态刷新（fire-and-forget 语义，可 await 等结果） */
  refresh(query?: UsageSnapshotQuery): Promise<void>;
}

/** 终态统计记录写入接口（子代理模块在终态调用） */
export interface UsageRecorderService {
  readonly id: "usage";
  /** 落一条统计记录；写盘失败返回 null（统计不阻断子代理终态） */
  record(event: UsageRunEvent): UsageRecord | null;
}

/** `provider/model` 引用 → 供应商前缀；没有斜杠时返回 null（不虚构供应商）。 */
export function deriveProvider(model: string | null | undefined): string | null {
  if (!model) return null;
  const separator = model.indexOf("/");
  if (separator <= 0) return null;
  return model.slice(0, separator);
}
