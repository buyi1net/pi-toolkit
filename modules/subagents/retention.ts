import { existsSync, rmSync } from "node:fs";
import { debugLog } from "./diagnostics.ts";

/**
 * 会话保留策略(spawn 参数 retention):
 * - "auto"(默认):headless 自动子代理成功终态后清理本次会话工件;失败/
 *   取消/handed-off 保留,主代理可用 subagent_message resume;
 * - "preserve":永不清理(pane/演示子代理无论参数如何恒为 preserve);
 * - "discard":headless 自动子代理到达非 handed-off 终态后一律清理
 *   (含失败/取消),显式声明"不需要 resume"。
 */
export type RetentionPolicy = "auto" | "preserve" | "discard";

export interface RetentionInput {
  policy: RetentionPolicy;
  /** 交互式演示子代理(可见 pane 归用户操作)。 */
  interactive: boolean;
  /** 运行载体;缺省(旧 mock/记录)按可见 pane 对待:未显式声明 headless 就不删。 */
  kind?: "pane" | "headless";
  cancelled: boolean;
  failed: boolean;
  handedOff: boolean;
}

export type RetentionDecision =
  | { action: "preserve"; reason: string }
  | { action: "delete"; reason: string };

/**
 * 纯决策函数:给定策略与终态,判定是否清理会话工件。
 * 恒 preserve 的边界(优先级从高到低):handed-off(进程仍在跑,交给恢复
 * 路径)、pane/演示/未声明 headless 的运行(可见会话归用户;载体未知时
 * 保守不删)。discard 只跳过这几类,失败/取消也清理——显式声明不需要
 * resume。auto 在失败/取消时保留以便 resume。
 */
export function resolveRetentionDecision(input: RetentionInput): RetentionDecision {
  if (input.handedOff) return { action: "preserve", reason: "handed-off" };
  if (input.interactive || input.kind !== "headless") {
    return { action: "preserve", reason: "pane" };
  }
  if (input.policy === "preserve") return { action: "preserve", reason: "policy=preserve" };
  if (input.policy === "discard") return { action: "delete", reason: "policy=discard" };
  if (input.cancelled) return { action: "preserve", reason: "cancelled" };
  if (input.failed) return { action: "preserve", reason: "failed" };
  return { action: "delete", reason: "auto-success" };
}

/** 待处理 ask_question 的 sidecar;存在即表示还有未投递的问题。 */
export function pendingAskSidecarPath(sessionFile: string): string {
  return `${sessionFile}.ask`;
}

/** subagent-done 错误路径写入的退出 sidecar。 */
export function exitSidecarPath(sessionFile: string): string {
  return `${sessionFile}.exit`;
}

export interface RetentionCleanupTarget {
  /** 子代理会话 JSONL(清理主体)。 */
  sessionFile: string;
  /** 活动快照文件(artifactDir/subagent-activity/<id>.json)。 */
  activityFile?: string;
  /** 本次 spawn 写入父会话 artifactDir/context/ 的任务与系统提示文件。 */
  contextFiles?: string[];
}

export interface RetentionCleanupResult {
  /** 实际删除的文件路径。 */
  removed: string[];
  /** 因待处理 .ask 而保留的文件路径(此时 removed 必为空)。 */
  skipped: string[];
  /** 删除失败的文件路径与原因;只能 debug,不覆盖子代理结果。 */
  errors: Array<{ path: string; error: string }>;
}

/**
 * 删除一次 headless 自动子代理的全部会话工件:会话 JSONL、.loadout.json、
 * .exit sidecar、activity 快照与 context 任务/系统提示文件。
 * 存在待处理 .ask(未投递的问题)时整体跳过——不能删除运行中/待处理的
 * 提问信号。单个文件删除失败只收集不抛出,由调用方 debug 上报。
 */
export function cleanupSubagentArtifacts(target: RetentionCleanupTarget): RetentionCleanupResult {
  const askPath = pendingAskSidecarPath(target.sessionFile);
  if (existsSync(askPath)) {
    debugLog(`Subagent artifact cleanup skipped (pending ask sidecar): ${askPath}`);
    return { removed: [], skipped: [askPath], errors: [] };
  }

  const removed: string[] = [];
  const errors: RetentionCleanupResult["errors"] = [];
  const candidates = [
    target.sessionFile,
    `${target.sessionFile}.loadout.json`,
    exitSidecarPath(target.sessionFile),
    ...(target.activityFile ? [target.activityFile] : []),
    ...(target.contextFiles ?? []),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      rmSync(path, { force: true });
      removed.push(path);
    } catch (error: any) {
      errors.push({ path, error: error?.message ?? String(error) });
    }
  }
  if (errors.length > 0) {
    debugLog(
      `Subagent artifact cleanup partially failed for ${target.sessionFile}`,
      errors.map((item) => `${item.path}: ${item.error}`).join("; "),
    );
  }
  return { removed, skipped: [], errors };
}
