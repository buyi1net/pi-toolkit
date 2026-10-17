// ACP 工具的统一拒绝结构（工单 01）：三个工具在注册期就存在，运行时若模块被关闭或
// 当前模型没有路由到 ACP 模式，一律返回规格固定的标准 AgentToolResult——
// details.toolUnavailable 给机读原因，文案走三语键（module.compression.acp.toolUnavailable），
// isError 按规格固定结构置 true。
// 这一层同时是「不创建引擎」的旁路：调用方在取用 Lazy engine 代理之前先问 isAcpActive。

import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { Translator } from "../../../i18n/index.ts";

/** 规格固定的机读原因（模块关闭或当前非 ACP 模式） */
export const TOOL_UNAVAILABLE_REASON = "compression_disabled_or_not_acp";

export interface AcpToolUnavailableDetails {
  readonly toolUnavailable: typeof TOOL_UNAVAILABLE_REASON;
}

/** 标准拒绝结果：模块未启用或当前模型未路由至 ACP 模式 */
export interface AcpToolUnavailableResult extends AgentToolResult<AcpToolUnavailableDetails> {
  /**
   * 失败标记（规格固定结构）。本仓编译目标 pi-coding-agent 0.85.x 的 AgentToolResult
   * 类型里没有这个字段，宿主也只按 execute 是否抛错判定 isError（`agent-loop` 里
   * execute 正常 resolve 就记为成功），所以这个字段在本宿主上不改变日志里的
   * isError；它按规格结构输出，给读 isError 的宿主版本用。会话日志侧的识别不要
   * 依赖它，要看 details.toolUnavailable。
   */
  readonly isError: boolean;
}

export function acpToolUnavailable(t: Translator): AcpToolUnavailableResult {
  return {
    content: [{ type: "text", text: t("module.compression.acp.toolUnavailable") }],
    isError: true,
    details: { toolUnavailable: TOOL_UNAVAILABLE_REASON },
  };
}

/**
 * 一条已落盘的 toolResult details 是不是上面的标准拒绝结构（工单 06）：
 * 0.85.x 宿主只按 execute 是否抛错记 isError，拒绝结果在会话日志里以「成功」
 * 形态出现；读日志的地方（压缩历史判定、内联解压去重）必须按 details 跳过，
 * 否则一次拒绝就会被当成一次真正的压缩 / 解压。
 */
export function isAcpToolUnavailableDetails(details: unknown): boolean {
  if (typeof details !== "object" || details === null) return false;
  return (details as { toolUnavailable?: unknown }).toolUnavailable === TOOL_UNAVAILABLE_REASON;
}
