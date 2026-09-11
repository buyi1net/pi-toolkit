import { normalizeSubagentName } from "./names.ts";

// ── 简单 dependsOn v1:依赖/完成注册表 ─────────────────────────────────────
// 按规范化 name 为 key,登记"某名字的子代理已确定、即将启动"的 deferred
// completion promise。同一 assistant message 的 sibling tool call 由 pi 并行
// 执行(Promise.all),但各 execute 的同步前缀按数组顺序串行运行——因此
// spawn/resume 在保留名字的同一同步段里登记完成记录,后执行的依赖消费者
// 一定能找到前置 sibling 的 pending 记录并等待它,不会出现"找不到依赖"或
// 重复登记。不使用全局 running 数量猜测批次分母,等待只指向显式的完成
// promise。
//
// 终态语义:completed / failed / cancelled / handed-off 都会 settle 记录;
// launch 失败由调用方 settle 为 failed,等待者绝不永久挂起。
// 存放在 globalThis symbol 上:/reload 重载模块后 pending 记录不丢,
// 恢复路径(recoverRuntimeSubagents)完成的子代理仍能唤醒等待者。

export type DependencyOutcomeStatus = "completed" | "failed" | "cancelled" | "handed-off";

/** 依赖目标的终态结果;settle 时写入记录并广播给所有等待者。 */
export interface DependencyOutcome {
  name: string;
  status: DependencyOutcomeStatus;
  /** 完成时的最终回复文本;失败时可能为空(错误在 errorMessage)。 */
  summary?: string;
  exitCode?: number;
  sessionFile?: string;
  errorMessage?: string;
  /** 结果来源:watcher 终态 / 历史会话文件 / launch 失败 / 依赖失败连带拦截。 */
  source: "watcher" | "session-file" | "launch-failure" | "dependency-blocked";
}

export interface CompletionRecord {
  name: string;
  /** true = 交互式(演示 pane)子代理:没有可等待的硬屏障终态,消费者必须拒绝。 */
  interactive: boolean;
  /** true = 持久团队成员:无进程级终态,同样拒绝(文案区分)。 */
  member?: boolean;
  promise: Promise<DependencyOutcome>;
  settle: (outcome: DependencyOutcome) => void;
  settled: boolean;
  outcome: DependencyOutcome | null;
  settledAt: number;
  /** 本 spawn 当前正在等待的上游依赖名(环检测用;仅 pending 期间有效)。 */
  waitingOn: Set<string>;
}

// 已 settle 记录的缓存期:期间等待者直接命中缓存,不重读磁盘。终态本身
// 不可变,过期条目只为防 Map 无限增长,到期后照旧能从会话注册表兜底解析。
const SETTLED_TTL_MS = 10 * 60_000;

const COMPLETIONS_KEY = Symbol.for("pi-subagents/dependency-completions");
const completions: Map<string, CompletionRecord> =
  ((globalThis as any)[COMPLETIONS_KEY] ??= new Map<string, CompletionRecord>());

/** 名字规范化与 steer/resume/spawn 寻址同一规则。 */
export function normalizeDependencyName(name: string): string {
  return normalizeSubagentName(name ?? "", "");
}

/**
 * 名字确定、真正启动前登记完成记录(spawn/resume 在保留名字的同一同步段
 * 调用)。幂等:同名 pending 记录直接复用;已 settle 的旧记录被新记录替换
 * (同一名字再次 resume)。顺带清理过期 settled 条目防泄漏。
 */
export function announceCompletion(
  name: string,
  opts?: { interactive?: boolean; member?: boolean },
): CompletionRecord {
  const key = normalizeDependencyName(name);
  const existing = completions.get(key);
  if (existing && !existing.settled) return existing;

  let resolveOutcome!: (outcome: DependencyOutcome) => void;
  const promise = new Promise<DependencyOutcome>((resolve) => {
    resolveOutcome = resolve;
  });
  const record: CompletionRecord = {
    name: key,
    interactive: opts?.interactive ?? false,
    ...(opts?.member ? { member: true } : {}),
    promise,
    settle: () => {},
    settled: false,
    outcome: null,
    settledAt: 0,
    waitingOn: new Set<string>(),
  };
  record.settle = (outcome) => {
    if (record.settled) return;
    record.settled = true;
    record.outcome = outcome;
    record.settledAt = Date.now();
    resolveOutcome(outcome);
  };
  completions.set(key, record);

  const now = Date.now();
  for (const [entryKey, entry] of completions) {
    if (entry.settled && now - entry.settledAt > SETTLED_TTL_MS) completions.delete(entryKey);
  }
  return record;
}

export function getCompletionRecord(name: string): CompletionRecord | null {
  return completions.get(normalizeDependencyName(name)) ?? null;
}

/** settle 指定名字的完成记录;记录不存在或已 settle 时为无害 no-op。 */
export function settleCompletion(name: string, outcome: DependencyOutcome): void {
  const record = completions.get(normalizeDependencyName(name));
  record?.settle(outcome);
}

/**
 * 从 watcher/launch 的结果映射终态并 settle:exitCode≠0 或带 errorMessage →
 * failed;handedOff → handed-off;调用方可用 status 覆盖(如硬屏障取消)。
 * 各条路径(spawn/resume/reload 恢复)共用,避免映射逻辑漂移。
 */
export function settleCompletionFromResult(
  name: string,
  result: { exitCode: number; summary?: string; sessionFile?: string; errorMessage?: string; handedOff?: boolean },
  opts?: { status?: DependencyOutcomeStatus; source?: DependencyOutcome["source"] },
): void {
  const status: DependencyOutcomeStatus =
    opts?.status ??
    (result.handedOff
      ? "handed-off"
      : result.exitCode !== 0 || !!result.errorMessage
        ? "failed"
        : "completed");
  settleCompletion(name, {
    name,
    status,
    ...(result.summary ? { summary: result.summary } : {}),
    exitCode: result.exitCode,
    ...(result.sessionFile ? { sessionFile: result.sessionFile } : {}),
    ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
    source: opts?.source ?? "watcher",
  });
}

/**
 * 等待指定名字到达终态。settled 记录直接返回缓存结果;pending 记录等待其
 * completion promise。signal 中止时以 Error reject(调用方转结构化异常),
 * 不影响记录本身的后续 settle。
 */
export async function waitForCompletion(
  name: string,
  signal?: AbortSignal,
): Promise<DependencyOutcome> {
  const record = getCompletionRecord(name);
  if (!record) throw new Error(`No completion record registered for "${name}"`);
  if (record.settled && record.outcome) return record.outcome;
  if (signal?.aborted) throw new Error(`Aborted before waiting for dependency "${record.name}"`);
  if (!signal) return record.promise;

  let onAbort: () => void;
  const abortPromise = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error(`Aborted while waiting for dependency "${record.name}"`));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([record.promise, abortPromise]);
  } finally {
    signal.removeEventListener("abort", onAbort!);
  }
}

/** 测试钩子:清空注册表,测试之间互不残留。 */
export function resetCompletions(): void {
  completions.clear();
}

// ── 同消息 sibling 互相 dependsOn 的环检测 ───────────────────────────────
// 每条 pending 记录携带 waitingOn(它正在等的上游名);等待前先从目标名沿
// pending 记录的 waitingOn 边回溯,能回到自己即成环——两条(或多条)sibling
// 互等会在硬屏障里永久悬挂,必须在等待前结构化失败。settled 记录不再等待
// 任何上游,不构成环的节点。

/** 从 firstDep 沿 pending 记录的 waitingOn 边搜索,回到 ownName 时返回环路径。 */
export function findDependencyCycle(ownName: string, firstDep: string): string[] | null {
  const visited = new Set<string>();
  const queue: Array<{ name: string; path: string[] }> = [
    { name: firstDep, path: [ownName, firstDep] },
  ];
  while (queue.length > 0) {
    const { name, path } = queue.shift()!;
    if (name === ownName) return path;
    if (visited.has(name)) continue;
    visited.add(name);
    const record = completions.get(name);
    if (!record || record.settled) continue;
    for (const next of record.waitingOn) {
      queue.push({ name: next, path: [...path, next] });
    }
  }
  return null;
}

// ── 依赖异常结构化(route_exception 同款 details 风格)──────────────────────

export type DependencyExceptionKind =
  | "self_dependency"
  | "unknown_dependency"
  | "interactive_dependency"
  | "member_dependency"
  | "dependency_cycle"
  | "dependency_failed"
  | "dependency_cancelled"
  | "dependency_handed_off"
  | "running_without_waiter"
  | "aborted";

export interface DependencyException {
  kind: DependencyExceptionKind;
  /** 触发异常的规范化依赖名。 */
  dependency: string;
  message: string;
  /** 上游结果细节(失败/取消时可带,便于编排者决定重试或放弃)。 */
  upstream?: {
    exitCode?: number;
    errorMessage?: string;
    sessionFile?: string;
  };
}

/**
 * 把依赖终态映射为异常 kind:非 completed 的 outcome 都不允许下游启动。
 * handed-off(reload 移交)没有可等待的真实结果,同样拒绝。
 */
export function exceptionKindForOutcome(status: DependencyOutcomeStatus): DependencyExceptionKind {
  if (status === "failed") return "dependency_failed";
  if (status === "cancelled") return "dependency_cancelled";
  return "dependency_handed_off";
}

/** 依赖异常 → 模型可读的 tool result(content + details),不启动任何进程。 */
export function dependencyExceptionResult(exception: DependencyException): {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
} {
  return {
    content: [{ type: "text", text: exception.message }],
    details: { error: "dependency_exception", dependencyException: exception },
  };
}
