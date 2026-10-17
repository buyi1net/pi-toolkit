// ACP 投影层（工单 08）：Pi 会话 entry ⇄ acp-kernel CoreMessage 的双向转换。
//
// 移植自 billion-context-pi 的 src/messages.ts（MIT，见模块 UPSTREAM.md），
// 按工单 08 的最小闭环裁剪：
// - 正向 acpEntriesToCoreMessages：把 Pi 的 SessionEntry[]（buildContextEntries
//   产出的稳定 entry id）投影成内核 CoreMessage[]。entry id 即压缩块的
//   direct/effective message id；assistant 多工具调用按 call 拆分为
//   `<entryId>#<callId>` 子 id（基 id 参与覆盖判定）。
// - 反向 acpCoreOutToAgentMessages：把内核 processTurn 的输出（已剪枝、已打
//   引用标签）重建回 Pi 的 AgentMessage[]。内核合成节点（`acp_summary_*`）
//   被过滤——摘要内容经由留在视图里的 compress 工具调用参数呈现（上游同款
//   口径）；被剪枝的消息按基 id 对不上即丢弃；内核正文改写（紧急截断等，
//   上游 messages.ts 的 body-mutation 语义）按内核正文重建，否则截断永远
//   到不了模型。
// - 引用标签（`<acp tokens="…" type="…">mNNNNN</acp>`）注入规则与上游一致：
//   user / toolResult 打标签，assistant 不打（模型会回声自己的标签）。内核
//   输出的 core.text 把标签放在正文开头；宿主视图把标签追加在正文末尾
//   （方向差异在 coreBodyOf / patchTag 各自处理）。
// - 请求视图变换（工单 11 的评审修复 F1）：acpDropCompressReasoning（丢弃
//   已闭环 compress 调用里超限的历史 thinking，上游 reasoning-drop.ts 移植）
//   与 acpStripHistoricalImages（剥离历史消息的图片载荷，内核 wire 层
//   stripHistoricalImages 的 AgentMessage 适配）都在重建视图上做纯变换，
//   只改发出请求，不改会话日志。
//
// 未移植（按需再议）：EntryProjectionCache 增量缓存、标签 token
// 计数稳定化改写、思考量计量（thinkingTokens）、图片计量、reasoning 投影。

import type { CoreMessage } from "acp-kernel";
import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";

/** Pi 的 LLM 消息类型（经 SessionMessageEntry 取型；0.85.x 未直接导出 AgentMessage） */
export type AcPAgentMessage = SessionMessageEntry["message"];

/** 内核引用标签（与 acp-kernel render-refs 的输出一致）：`<acp …>mNNNNN</acp>` */
const REF_TAG = /<acp[^>]*>\s*(m\d+)\s*<\/acp>/;

interface AnyContentBlock {
  type?: string;
  text?: string;
}

type AnyMessage = AcPAgentMessage & {
  content?: unknown;
  command?: string;
  output?: unknown;
  summary?: string;
};

/** 拼出消息的全部文本（文本块拼接；与上游 extractText 同口径） */
export function acpExtractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const b = block as AnyContentBlock;
    if (b && typeof b === "object" && b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    }
  }
  return parts.join("\n");
}

function toolCallsOf(content: unknown): { name: string; id: string; arguments?: unknown }[] {
  if (!Array.isArray(content)) return [];
  const calls: { name: string; id: string; arguments?: unknown }[] = [];
  for (const block of content) {
    const b = block as { type?: string; name?: string; id?: string; arguments?: unknown };
    if (b && typeof b === "object" && b.type === "toolCall" && b.name && b.id) {
      calls.push({ name: b.name, id: b.id, arguments: b.arguments });
    }
  }
  return calls;
}

function stringifyArgs(args: unknown): string {
  if (!args) return "";
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args) ?? "";
  } catch {
    return String(args);
  }
}

/** custom_message：Pi 原生语义里参与 LLM 上下文，投影为 user 文本消息 */
function customEntryText(entry: SessionEntry): string {
  if (entry.type !== "custom_message") return "";
  const text = acpExtractText((entry as { content?: unknown }).content);
  if (text.length > 0) return text;
  return "";
}

/** 单条 AgentMessage → CoreMessage[]（assistant 多 call 拆分；空文本丢弃） */
export function acpProjectMessage(message: AcPAgentMessage, id: string): CoreMessage[] {
  const msg = message as AnyMessage;
  if (msg.role === "user") {
    return [{ id, role: "user", contentType: "text", text: acpExtractText(msg.content) }];
  }
  if (msg.role === "toolResult") {
    const tool = msg as { toolName?: string; toolCallId?: string };
    return [
      {
        id,
        role: "tool",
        contentType: "tool-result",
        toolName: tool.toolName,
        toolCallId: tool.toolCallId,
        text: acpExtractText(msg.content),
      },
    ];
  }
  if (msg.role === "assistant") {
    const calls = toolCallsOf(msg.content);
    if (calls.length > 0) {
      const textParts = acpExtractText(msg.content);
      if (calls.length === 1) {
        const call = calls[0]!;
        const argStr = stringifyArgs(call.arguments);
        const text = argStr && textParts ? `${textParts}\n${argStr}` : argStr || textParts;
        return [
          { id, role: "assistant", contentType: "tool-call", toolName: call.name, toolCallId: call.id, text },
        ];
      }
      return calls.map((call) => {
        const argStr = stringifyArgs(call.arguments);
        return {
          id: `${id}#${call.id}`,
          role: "assistant" as const,
          contentType: "tool-call" as const,
          toolName: call.name,
          toolCallId: call.id,
          text: argStr || textParts,
        };
      });
    }
    const text = acpExtractText(msg.content);
    if (!text.trim()) return [];
    return [{ id, role: "assistant", contentType: "text", text }];
  }
  // 其它角色（custom 等）：有文本才投影
  const text = acpExtractText(msg.content);
  return text.length > 0 ? [{ id, role: "user", contentType: "text", text }] : [];
}

/** Pi SessionEntry[] → 内核 CoreMessage[]（entry id 即压缩坐标系的原点） */
export function acpEntriesToCoreMessages(entries: readonly SessionEntry[]): CoreMessage[] {
  const out: CoreMessage[] = [];
  for (const entry of entries) {
    if (entry.type === "message") {
      out.push(...acpProjectMessage((entry as { message: AcPAgentMessage }).message, entry.id));
    } else {
      const text = customEntryText(entry);
      if (text.length > 0) out.push({ id: entry.id, role: "user", contentType: "text", text });
    }
  }
  return out;
}

function peelTag(text: string): string {
  // 去掉文本尾部由上一轮注入的引用标签（标签总在末尾追加）
  const match = text.match(REF_TAG);
  if (!match) return text;
  const cut = text.lastIndexOf(match[0]);
  return (text.slice(0, cut) + text.slice(cut + match[0].length)).replace(/\n+$/, "");
}

/** 内核 core.text 的布局是「标签在前、正文在后」（renderMessage 的 prefix +
 *  cleanText）；剥掉开头标签得到正文。结构对不上（标签不在开头）返回 null。 */
function coreBodyOf(coreText: string, tag: string): string | null {
  if (!coreText.startsWith(tag)) return null;
  let bodyStart = tag.length;
  if (coreText.charAt(bodyStart) === "\n") bodyStart += 1;
  return coreText.slice(bodyStart);
}

/** 按内核正文重建消息内容（上游 rebuildBodyFromCore 语义，宿主末尾标签约定）：
 *  非文本块（图片等）保留，文本块收敛为一条「正文 + 标签」。 */
function rebuildBodyFromCore(original: AcPAgentMessage, coreBody: string, tag: string): AcPAgentMessage {
  const base = original as AnyMessage;
  const text = `${coreBody.replace(/\s+$/, "")}\n\n${tag}`;
  if (typeof base.content === "string") {
    return { ...(original as object), content: text } as AcPAgentMessage;
  }
  if (Array.isArray(base.content)) {
    const nonText = base.content.filter(
      (block) => (block as AnyContentBlock | null)?.type !== "text",
    );
    return { ...(original as object), content: [...nonText, { type: "text", text }] } as AcPAgentMessage;
  }
  return { ...(original as object), content: [{ type: "text", text }] } as AcPAgentMessage;
}

function contentBlocksOf(message: AnyMessage): AnyContentBlock[] {
  const raw = Array.isArray(message.content)
    ? message.content
    : typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : [];
  return raw as AnyContentBlock[];
}

/** 把内核标签打进 user / toolResult 的最后一个文本块（先剥旧标签再追加新标签） */
function patchTag(original: AcPAgentMessage, tag: string): AcPAgentMessage {
  const base = original as AnyMessage;
  if (base.role === "assistant") return original; // assistant 不打标签（上游口径）
  const blocks = contentBlocksOf(base).map((block) =>
    block && typeof block === "object" && typeof block.text === "string"
      ? { ...block, text: peelTag(block.text) }
      : block,
  );
  let injected = false;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i] as AnyContentBlock;
    if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
      const body = block.text.replace(/\n+$/, "");
      blocks[i] = { ...block, text: body.length > 0 ? `${body}\n\n${tag}` : tag };
      injected = true;
      break;
    }
  }
  if (!injected) blocks.push({ type: "text", text: tag });
  return { ...(original as object), content: blocks } as AcPAgentMessage;
}

/** 内核输出（已剪枝/已标签）→ Pi AgentMessage[]（从原始 entry 消息重建） */
export function acpCoreOutToAgentMessages(
  coreOut: readonly CoreMessage[],
  originalById: ReadonlyMap<string, AcPAgentMessage>,
): AcPAgentMessage[] {
  const out: AcPAgentMessage[] = [];
  const emittedSplit = new Set<string>();
  for (const core of coreOut) {
    // 内核合成的摘要节点不进 AgentMessage 视图：摘要内容经由留在视图里的
    // compress 工具调用参数呈现（上游 billion-context-pi 同口径）
    if (core.id.startsWith("acp_summary_")) continue;

    const hashIdx = core.id.indexOf("#");
    if (hashIdx < 0) {
      const original = originalById.get(core.id);
      if (!original) continue; // 被剪枝或非本会话消息：丢弃
      const match = core.text ? core.text.match(REF_TAG) : null;
      if (!match) {
        out.push(original);
        continue;
      }
      // 尊重内核正文改写（紧急截断等）：core.text 与原文的正文不一致时按内核
      // 正文重建——否则截断永远到不了模型（上游 messages.ts 同款语义）。
      // assistant 不走该路径（与打标签同口径：视图保持原样）。
      const base = original as AnyMessage;
      const coreBody = coreBodyOf(core.text ?? "", match[0]);
      if (
        base.role !== "assistant" &&
        coreBody !== null &&
        trimEndOf(coreBody) !== trimEndOf(acpExtractText(base.content))
      ) {
        out.push(rebuildBodyFromCore(original, coreBody, match[0]));
        continue;
      }
      out.push(patchTag(original, match[0]));
      continue;
    }

    // 多工具调用拆分出的子 id：同基 id 的存活 call 合并回一条 assistant 消息
    const baseId = core.id.slice(0, hashIdx);
    if (emittedSplit.has(baseId)) continue;
    emittedSplit.add(baseId);
    const original = originalById.get(baseId);
    if (!original) continue;
    const survivingCallIds = new Set(
      coreOut
        .filter((c) => c.id.startsWith(`${baseId}#`) && !c.id.startsWith("acp_summary_"))
        .map((c) => c.toolCallId)
        .filter((id): id is string => !!id),
    );
    const base = original as AnyMessage;
    const blocks = contentBlocksOf(base)
      .filter((block) => {
        const b = block as { type?: string; id?: string };
        if (b && typeof b === "object" && b.type === "toolCall") return survivingCallIds.has(b.id ?? "");
        return true;
      })
      .map((block) =>
        block && typeof block === "object" && typeof (block as AnyContentBlock).text === "string"
          ? { ...block, text: peelTag((block as AnyContentBlock).text!) }
          : block,
      );
    out.push({ ...(original as object), content: blocks } as AcPAgentMessage);
  }
  return out;
}

/** 从 entry 列表建「基 id → 原始消息」索引（反向投影的原料） */
export function acpOriginalsOf(entries: readonly SessionEntry[]): Map<string, AcPAgentMessage> {
  const map = new Map<string, AcPAgentMessage>();
  for (const entry of entries) {
    if (entry.type === "message") map.set(entry.id, (entry as { message: AcPAgentMessage }).message);
  }
  return map;
}

function trimEndOf(text: string): string {
  return text.replace(/\s+$/, "");
}

// ─────────────────────────────────────────────────────────────
// 请求视图变换（评审修复 F1：reasoning / stripImages 的投影期消费）
// ─────────────────────────────────────────────────────────────

/** reasoning 处理配置（AcpCompressOverrides.reasoning 的形状；默认值对齐上游） */
export interface AcpReasoningDropConfig {
  readonly drop?: boolean;
  readonly threshold?: number;
}

/** 解析 reasoning 配置：drop 缺省 true、threshold 缺省 2048 字符（上游
 *  billion-context-pi 的 DEFAULT_COMPRESS_REASONING 同值）；非法 threshold
 *  静默回退默认（不猜测）。 */
export const ACP_DEFAULT_REASONING_DROP: Required<AcpReasoningDropConfig> = { drop: true, threshold: 2048 };

export function acpResolveReasoningDrop(cfg?: AcpReasoningDropConfig): Required<AcpReasoningDropConfig> {
  const thresholdRaw = cfg?.threshold;
  const threshold =
    typeof thresholdRaw === "number" && Number.isFinite(thresholdRaw) && thresholdRaw >= 0
      ? Math.floor(thresholdRaw)
      : ACP_DEFAULT_REASONING_DROP.threshold;
  return { drop: cfg?.drop !== false, threshold };
}

function isThinking(part: unknown): part is { type: "thinking"; thinking: string } {
  const p = part as { type?: string; thinking?: unknown } | null;
  return !!p && typeof p === "object" && p.type === "thinking" && typeof p.thinking === "string";
}

function hasCompressCall(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    const b = part as { type?: string; name?: string } | null;
    return !!b && b.type === "toolCall" && b.name === "compress";
  });
}

function compressCallIds(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((part) => {
      const b = part as { type?: string; name?: string } | null;
      return !!b && b.type === "toolCall" && b.name === "compress";
    })
    .map((part) => (part as { id?: unknown }).id)
    .filter((id): id is string => typeof id === "string");
}

/** toolCallId → 其 toolResult 消息的下标（Pi 的 toolResult 是独立消息） */
function resultIndexByCallId(messages: readonly AcPAgentMessage[]): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] as { role?: string; toolCallId?: unknown } | null;
    if (!msg || msg.role !== "toolResult" || typeof msg.toolCallId !== "string") continue;
    if (!map.has(msg.toolCallId)) map.set(msg.toolCallId, i);
  }
  return map;
}

function reasoningLength(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  return content.reduce((n, part) => (isThinking(part) ? n + part.thinking.length : n), 0);
}

/** 视图里 thinking 部分的总字符数（诊断与测试观察） */
export function acpCountThinkingChars(messages: readonly AcPAgentMessage[]): number {
  return messages.reduce((n, m) => n + reasoningLength((m as { content?: unknown }).content), 0);
}

/** 请求期丢弃已闭环 compress 调用里的超限 thinking（上游 reasoning-drop.ts
 *  移植，MIT）：只动满足全部条件的 assistant 消息——
 *  1. 闭环：消息里每个 compress toolCall 的结果都已到达且之后还有消息（在途
 *     轮次绝不碰；合成 nudge 在本变换之后注入，不能追溯闭环一轮）；
 *  2. 选择器：消息带 compress toolCall（compress 结果是块摘要的锚，硬豁免
 *     压缩，其 thinking 是每次请求都随行的不可回收底座）；
 *  3. 尺寸：该消息的 reasoning 总长（按消息内累计，不跨消息）严格超过阈值。
 *  纯函数：不改入参、幂等、出错原样返回。 */
export function acpDropCompressReasoning(
  messages: readonly AcPAgentMessage[],
  cfg?: AcpReasoningDropConfig,
): AcPAgentMessage[] {
  const { drop, threshold } = acpResolveReasoningDrop(cfg);
  if (!drop || messages.length === 0) return [...messages];
  try {
    const last = messages.length - 1;
    const resultAt = resultIndexByCallId(messages);
    let changed = false;
    const out = messages.slice();
    for (let i = 0; i <= last; i++) {
      const msg = messages[i] as { role?: string; content?: unknown } | null;
      if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
      if (!hasCompressCall(msg.content)) continue;
      const ids = compressCallIds(msg.content);
      const closed =
        ids.length > 0 &&
        ids.every((id) => {
          const ri = resultAt.get(id);
          return ri !== undefined && ri > i && ri < last;
        });
      if (!closed) continue;
      if (reasoningLength(msg.content) <= threshold) continue;
      out[i] = {
        ...(msg as object),
        content: (msg.content as unknown[]).filter((part) => !isThinking(part)),
      } as AcPAgentMessage;
      changed = true;
    }
    return changed ? out : [...messages];
  } catch {
    return [...messages];
  }
}

/** 图片剥离配置（stripImages / stripImagesKeepRecent 的解析结果） */
export interface AcpStripImagesOptions {
  /** 是否启用剥离（默认关：与上游一致 opt-in） */
  readonly enabled: boolean;
  /** 最近 N 条消息保留图片（默认 5，上游同值） */
  readonly keepRecent: number;
}

export const ACP_DEFAULT_STRIP_KEEP_RECENT = 5;

/** 只剩图片的消息塌缩成的占位文本（内核 wire 层同款，保持消息数与角色顺序） */
const IMAGE_PLACEHOLDER = "[image]";

/** 请求期剥离历史图片（内核 wire 层 stripHistoricalImages 的 AgentMessage
 *  适配）：最近 keepRecent 条消息保持原样，更早的消息剔除 `type: "image"`
 *  内容块；整条消息只剩图片时塌缩成 `[image]` 文本占位（消息数与角色顺序
 *  不变）。纯函数：不改入参；未启用或无事可做时返回原数组副本。 */
export function acpStripHistoricalImages(
  messages: readonly AcPAgentMessage[],
  options: AcpStripImagesOptions,
): { messages: AcPAgentMessage[]; removed: number } {
  if (!options.enabled) return { messages: [...messages], removed: 0 };
  const keepRecent = Math.max(0, Math.floor(options.keepRecent));
  const cutoff = messages.length - keepRecent;
  if (cutoff <= 0) return { messages: [...messages], removed: 0 };
  let removed = 0;
  let touched = false;
  const out = messages.map((message, i) => {
    if (i >= cutoff) return message;
    const content = (message as AnyMessage).content;
    if (!Array.isArray(content)) return message;
    if (!content.some((block) => (block as AnyContentBlock | null)?.type === "image")) return message;
    const kept = content.filter((block) => (block as AnyContentBlock | null)?.type !== "image");
    removed += content.length - kept.length;
    touched = true;
    const nextContent: unknown[] = kept.length > 0 ? kept : [{ type: "text", text: IMAGE_PLACEHOLDER }];
    return { ...(message as object), content: nextContent } as AcPAgentMessage;
  });
  return touched ? { messages: out, removed } : { messages: [...messages], removed: 0 };
}
