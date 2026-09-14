// computer 动作日志（工单 06）：派发到原生层的动作逐条记本地 JSONL，给 P8 的审计与审批留底。
//
// 落点（工单 06 定案）：<agentDir>/pi-computer/actions.jsonl，一行一条、按行追加。
// 只记“真正派发出去的动作”：被校验拦下（一个都没发）的调用不写；后端执行失败照记，
// outcome 记错误码、detail 记原生层原文。审计级留存（轮转、保留窗口、加密）留到 P8。
// 写失败由工具层兜住并在结果文本里如实标注，不反过来改变动作本身的结果。

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ComputerBackendTarget } from "./backend.ts";
import type { ComputerAction, ComputerErrorCode, ComputerStateId, RootRef } from "./contract.ts";

export interface ComputerActionLogEntry {
  /** ISO 8601 时间戳（UTC） */
  readonly time: string;
  readonly stateId: ComputerStateId;
  /** 目标根的稳定身份：@rN 只在本会话有效，跨会话排查靠 key */
  readonly rootKey: string;
  readonly rootRef: RootRef;
  /** 派发到原生层的动作：坐标类动作的 x/y/toX/toY 已按采集记录换成桌面物理像素，其余字段与原样一致 */
  readonly command: ComputerAction;
  /** 派发到后端的目标：结构路径 + 观察时看到的语义身份 */
  readonly target?: ComputerBackendTarget;
  /** 整批动作的结果；一条失败即整批失败 */
  readonly outcome: "ok" | ComputerErrorCode;
  readonly detail?: string;
}

/** 动作日志 sink：生产用文件实现（createFileActionLog），测试注入内存实现 */
export type ComputerActionLogSink = (entries: readonly ComputerActionLogEntry[]) => void | Promise<void>;

/** computer 模块的状态目录：<agentDir>/pi-computer（动作日志与截图的共同落点，工单 19 收到一处） */
export function computerStateDir(agentDir: string): string {
  return join(agentDir, "pi-computer");
}

/** 动作日志落点：<agentDir>/pi-computer/actions.jsonl */
export function computerActionLogPath(agentDir: string): string {
  return join(computerStateDir(agentDir), "actions.jsonl");
}

/**
 * 追加写 JSONL；目录不存在就建，写失败抛给调用方（工具层会在结果里标注）。
 * 同步写：一批动作合并成一次 append，写入顺序就是派发顺序，也避免并发调用把行写串。
 */
export function createFileActionLog(path: string): ComputerActionLogSink {
  return (entries) => {
    if (entries.length === 0) return;
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  };
}
