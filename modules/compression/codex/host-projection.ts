// Codex checkpoint 的宿主投影接缝（工单 09 建立；工单 02 升级规格批次 B 收口）。
//
// 目标契约：Pi 1.3.0 的 buildSessionProjection（已核验 1.3.0 宿主实际发行件
// dist/core/session-manager.{js,d.ts}）：context_edit 条目先收集后应用（null
// replacement 把目标整体剔出模型上下文、内容替换只改 content 保消息元数据、
// 同目标多次编辑后写覆盖），产出 entries（sourceEntry → messages 的条目映射）
// 与 messages（扁平化模型上下文）；保留区间剔除 system 消息，older compaction
// 落在新保留区间内时被抑制。宿主的 buildSessionContext 就是这份投影的 messages。
//
// 升级工单 02（单向升级）：本仓唯一支持目标就是 Pi 1.3.0。这里不再保留旧版
// baseline projection、运行期版本探测或缺 API fallback——宿主缺
// buildSessionProjection（低于 1.3.0）时按升级规格直接报「宿主不支持」并停止
// Codex 压缩功能（CodexHostProjectionUnsupportedError → owner 的明确诊断），
// 不静默降级、不切换第二套投影语义。检测只区分「可用 / 明确不支持」两态，
// 不在两套投影实现间分支。

import * as piHost from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { CodexAgentMessage } from "./checkpoint.ts";

/** Pi 1.3.0 ProjectedSessionEntry 的接缝形状：条目映射（sourceEntry → 模型消息） */
export interface HostProjectionEntry {
  readonly sourceEntry: SessionEntry;
  readonly messages: readonly CodexAgentMessage[];
}

/** Pi 1.3.0 SessionProjection 的接缝形状（thinkingLevel / model 与消息投影无关，不进接缝） */
export interface HostSessionProjection {
  readonly entries: readonly HostProjectionEntry[];
  readonly messages: readonly CodexAgentMessage[];
}

// 消息形状假设：宿主投影产出的消息即本仓 CodexAgentMessage（Context 事件同款）。
// 已在 1.3.0 发行件上核验成立；若未来宿主消息形状演进，这里不会在类型层报警，
// 而是下游指纹 / 回放校验对不上 → 保护路径（失败方向安全）。

/**
 * 宿主投影函数：session entries（含 context_edit）+ leafId → 宿主实际投影。
 * canonical context messages、retained entries 与 checkpoint 指纹共用这一份
 * 已投影序列（规格：任何一步重读未经编辑的原始 entries 即投影口径错误）。
 */
export type SessionProjectionFn = (entries: readonly SessionEntry[], leafId: string | null) => HostSessionProjection;

/**
 * 宿主缺 Pi 1.3.0 buildSessionProjection 的显式失败（单向升级：只报不支持，
 * 不回退旧口径）。owner 捕获后进入「宿主不支持」诊断并停止 Codex 压缩功能。
 */
export class CodexHostProjectionUnsupportedError extends Error {
  constructor() {
    super("Host pi-coding-agent does not provide buildSessionProjection (Pi 1.3.0+ required)");
    this.name = "CodexHostProjectionUnsupportedError";
  }
}

/**
 * Pi 1.3.0 宿主投影（唯一直达接缝）：直接消费官方 buildSessionProjection。
 * 测试与独立装载经 owner 的 hostProjection 参数注入替身；生产路径缺 API 时
 * 抛 CodexHostProjectionUnsupportedError。
 */
export function hostSessionProjection(entries: readonly SessionEntry[], leafId: string | null): HostSessionProjection {
  const build = piHost.buildSessionProjection;
  if (typeof build !== "function") throw new CodexHostProjectionUnsupportedError();
  const projection = build([...entries], leafId);
  return {
    entries: projection.entries.map((slot) => ({ sourceEntry: slot.sourceEntry, messages: [...slot.messages] })),
    messages: [...projection.messages],
  };
}
