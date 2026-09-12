// watcher 终态构造归一：pane / headless / member 三条 watcher 路径的终态结果
// 只在这里拼装，watcher 自己只负责判定终态类别（移交 / 取消 / 失败 / 完成）
// 与做进程、登记收尾。
//
// 终态类别（与 types.ts 的 SubagentResult 标志位一一对应）：
//   completed   正常结束：含提取后的摘要、退出码、可选 userClosed（pane 被
//               用户直接关闭）与 stats。
//   handed-off  /reload 移交或宿主会话关闭 detach：不是终态，进程/pane 与
//               运行记录保留给恢复路径，调用方只报「已移交」。
//   cancelled   显式停止（subagent_stop）兑出的取消终态。
//   failed      意外失败：错误摘要 + errorMessage。
//
// 成员（member）是常驻进程，终态不是 SubagentResult，而是「终止进程 + roster
// 标 offline + 移除运行态登记」三件套；takeMemberOffline 是这三件套的唯一
// 实现（重载移交 / 进程退出 / 轮次关联失败三处共用）。

import type { RuntimeRegistry } from "./registry.ts";
import type { RunningSubagent, SubagentResult } from "./types.ts";

/** /reload 移交的终态摘要（pane 与 headless 两路共用同一文案）。 */
export const HOST_RELOAD_HANDOFF_SUMMARY =
  "Subagent handed off to recovery after host reload; it is still running and " +
  "its real result will be delivered when it finishes.";

/** 宿主会话关闭/切换导致的 detach 终态摘要。 */
export const SESSION_DETACH_HANDOFF_SUMMARY =
  "Subagent detached because the host session was closed or switched away; it is " +
  "still running and its real result will be recovered when this session returns.";

/** watcher 判定出的终态。 */
export type WatcherTerminal =
  | {
      kind: "completed";
      summary: string;
      exitCode: number;
      /** 子会话 id（提取到才有）。 */
      sessionId?: string | null;
      /** 用户直接关闭 pane（仅 pane 路径）。 */
      userClosed?: boolean;
      errorMessage?: string;
      stats?: SubagentResult["stats"] | null;
    }
  | { kind: "handed-off"; reason: "host-reload" | "session-detach" }
  | { kind: "cancelled" }
  /** 意外失败；pane 路径带 sessionFile，headless 失败分支按现状不带。 */
  | { kind: "failed"; error: unknown; sessionFile?: string };

function errorText(error: unknown): string {
  // 与旧 watcher 的 err?.message ?? String(err) 逐字对齐：带 message 的对象/Error 都取 message。
  const message = (error as { message?: unknown } | null | undefined)?.message;
  return message != null ? String(message) : String(error);
}

/**
 * 构造 watcher 终态结果（唯一实现）。elapsed 由调用方传入：pane/headless 都
 * 在收尾动作（关 pane、杀子进程）之前取时刻，构造点不应重新计时。
 */
export function buildWatcherTerminal(
  running: RunningSubagent,
  terminal: WatcherTerminal,
  elapsedSeconds: number,
): SubagentResult {
  const { name, task, sessionFile } = running;
  const cohortDetails = running.cohortId ? { cohortId: running.cohortId } : {};

  switch (terminal.kind) {
    case "completed":
      return {
        name,
        task,
        summary: terminal.summary,
        sessionFile,
        ...cohortDetails,
        ...(terminal.sessionId ? { sessionId: terminal.sessionId } : {}),
        exitCode: terminal.exitCode,
        elapsed: elapsedSeconds,
        ...(terminal.userClosed ? { userClosed: true } : {}),
        ...(terminal.errorMessage ? { errorMessage: terminal.errorMessage } : {}),
        ...(terminal.stats ? { stats: terminal.stats } : {}),
      };
    case "handed-off":
      return {
        name,
        task,
        summary:
          terminal.reason === "host-reload" ? HOST_RELOAD_HANDOFF_SUMMARY : SESSION_DETACH_HANDOFF_SUMMARY,
        exitCode: 0,
        elapsed: elapsedSeconds,
        sessionFile,
        ...cohortDetails,
        handedOff: true,
      };
    case "cancelled":
      return {
        name,
        task,
        summary: "Subagent stopped.",
        exitCode: 1,
        elapsed: elapsedSeconds,
        sessionFile,
        ...cohortDetails,
        stopped: true,
      };
    case "failed":
      return {
        name,
        task,
        summary: `Subagent error: ${errorText(terminal.error)}`,
        exitCode: 1,
        elapsed: elapsedSeconds,
        ...(terminal.sessionFile !== undefined ? { sessionFile: terminal.sessionFile } : {}),
        ...cohortDetails,
        errorMessage: errorText(terminal.error),
      };
  }
}

/** 完成记录（依赖注册表）只消费这几个字段的失败载荷。 */
export function failureSettlement(
  running: RunningSubagent,
  error: unknown,
): Pick<SubagentResult, "exitCode" | "errorMessage" | "sessionFile"> {
  return {
    exitCode: 1,
    errorMessage: errorText(error),
    sessionFile: running.sessionFile,
  };
}

/** 成员终态收尾所需的外部动作（mod.ts 注入；这里只编排顺序）。 */
export interface MemberTerminalActions {
  registry: RuntimeRegistry;
  killMemberProcess(running: RunningSubagent): void;
  markMemberOffline(running: RunningSubagent, reason: string): void;
}

/**
 * 成员终态收尾（唯一实现）：终止进程（可选）→ roster 标 offline → 移除
 * 运行态登记。重载移交、进程退出、轮次关联失败三处都走这里，顺序一致。
 * 进程已死时传 kill: false，不重复杀。
 */
export function takeMemberOffline(
  running: RunningSubagent,
  reason: string,
  actions: MemberTerminalActions,
  options?: { kill?: boolean },
): void {
  if (options?.kill !== false) actions.killMemberProcess(running);
  actions.markMemberOffline(running, reason);
  actions.registry.remove(running.id);
}
