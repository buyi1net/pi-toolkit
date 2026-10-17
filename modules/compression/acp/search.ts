// ACP 搜索索引与结果格式（工单 09）：把压缩块与被折叠的原始消息接入内核
// 的 searchBlocks。
//
// 移植自 billion-context-pi 的 src/search-index.ts + src/search-tool.ts 的
// 格式化段（MIT，见模块 UPSTREAM.md）：
// - 可搜索范围：全部压缩块（blockDocs，含非活动块）+ 被某个块覆盖的原始
//   消息（messageDocs）——仍在视图里的消息模型本来就能看到，不进索引；
// - 消息命中给出归属块与该块的引用跨度（startRef–endRef），模型据此直接
//   decompress 归属块取回完整上下文；
// - 空结果给出可理解反馈：命中 0 时报告搜索范围（块数 + 消息数）并给出
//   下一步建议，而不是空文本。

import {
  blockDocs,
  defaultCountTokens,
  messageDocs,
  searchBlocks,
  type CompressionState,
  type MessageInput,
  type SearchDoc,
  type SearchResult,
} from "acp-kernel";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { acpEntriesToCoreMessages } from "./projection.ts";

/** 被任一块覆盖（active 与否都算）的原始消息 id 集合 */
function buildCoveredIds(state: CompressionState): Set<string> {
  const covered = new Set<string>();
  for (const block of state.blocks) {
    for (const id of block.effectiveMessageIds) covered.add(id);
  }
  return covered;
}

/** 原始消息 id → 归属块（最早创建的块优先：最外层摘要） */
function buildOwnerMap(state: CompressionState): Map<string, string> {
  const owner = new Map<string, string>();
  for (const block of state.blocks) {
    for (const id of block.effectiveMessageIds) {
      if (!owner.has(id)) owner.set(id, block.blockId);
    }
  }
  return owner;
}

function toSearchRole(role: string): MessageInput["role"] | null {
  if (role === "user") return "user";
  if (role === "assistant") return "assistant";
  if (role === "toolResult") return "tool";
  return null;
}

/**
 * 构建搜索索引：块摘要文档 + 被折叠原始消息文档。消息文档的 ref 用内核
 * 引用（mNNNNN，与视图里的 acp 标签同坐标系）；无引用登记的老消息退化用
 * 原始 entry id（decompress 同样接受）。
 */
export function acpBuildSearchDocs(state: CompressionState, entries: readonly SessionEntry[]): SearchDoc[] {
  const covered = buildCoveredIds(state);
  const owner = buildOwnerMap(state);
  const tierByBlock = new Map(state.blocks.map((block) => [block.blockId, block.tier]));

  const messages: MessageInput[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = (entry as { message?: { role?: string } }).message;
    const role = toSearchRole(message?.role ?? "");
    if (!role) continue;
    for (const core of acpEntriesToCoreMessages([entry])) {
      if (!covered.has(core.id)) continue; // 仍可见的消息不进索引
      const text = core.text ?? "";
      if (text.trim().length < 2) continue;
      const blockId = owner.get(core.id);
      messages.push({
        ref: state.messageRefs.byRaw[core.id] ?? core.id,
        role,
        text,
        tokens: defaultCountTokens(text),
        ...(blockId === undefined ? {} : { blockId }),
        ...(blockId === undefined ? {} : { tier: tierByBlock.get(blockId) }),
      });
    }
  }
  return [...blockDocs(state), ...messageDocs(messages)];
}

export interface AcpSearchReport {
  /** 命中结果（内核排序） */
  readonly results: readonly SearchResult[];
  /** 搜索范围内的块数 */
  readonly blockCount: number;
  /** 搜索范围内的被折叠消息数 */
  readonly messageCount: number;
}

/** 执行一次搜索（空结果同样返回报告，反馈文本由 acpFormatSearchResults 生成） */
export function acpRunSearch(
  state: CompressionState,
  entries: readonly SessionEntry[],
  query: string,
  limit?: number,
): AcpSearchReport {
  const docs = acpBuildSearchDocs(state, entries);
  const blockCount = docs.filter((doc) => doc.kind === "block").length;
  const messageCount = docs.filter((doc) => doc.kind === "message").length;
  const results = query.trim().length === 0 ? [] : searchBlocks(docs, query, { limit });
  return { results, blockCount, messageCount };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function formatSize(tokens: number): string {
  if (tokens < 1000) return `${tokens}tok`;
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}K`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/** 块的引用跨度（消息命中的“原始消息范围”提示用） */
function spanOf(state: CompressionState, blockId: string): string | null {
  const block = state.blocks.find((b) => b.blockId === blockId);
  if (!block?.startRef || !block.endRef) return null;
  return `${block.startRef}–${block.endRef}`;
}

function formatResult(result: SearchResult, state: CompressionState): string {
  const size = result.tokens !== undefined ? formatSize(result.tokens) : "";
  const meta = [
    result.kind === "message" ? `message ${result.ref}` : `block ${result.ref}`,
    result.role ? `(${result.role})` : "",
    `T${result.tier}`,
    `score:${result.score.toFixed(2)}`,
    size,
  ]
    .filter(Boolean)
    .join(" ");

  const header = `${meta}  "${truncate(result.title, 50)}"`;
  const hint =
    result.kind === "block"
      ? `→ decompress({ blockId: "${result.ref}" })`
      : result.blockId
        ? `→ decompress({ blockId: "${result.blockId}" })  (block containing message ${result.ref})`
        : `(message ${result.ref} is still visible in context)`;
  const span = result.blockId ? spanOf(state, result.blockId) : null;
  const lines = [header, `  ${result.preview}`, `  ${hint}`];
  if (span && result.kind === "message") lines.push(`  covered message range: ${span}`);
  return lines.join("\n");
}

/** 搜索结果 → 模型可读文本（含空结果的可理解反馈） */
export function acpFormatSearchResults(report: AcpSearchReport, query: string, state: CompressionState): string {
  if (query.trim().length === 0) {
    return `Empty query. Provide keywords to search across ${report.blockCount} block(s) and ${report.messageCount} folded message(s), e.g. search_context({ query: "auth token" }).`;
  }
  if (report.results.length === 0) {
    return [
      `No matches for "${query}" across ${report.blockCount} block(s) and ${report.messageCount} folded message(s).`,
      "Try different keywords (topic names, file paths, error text), or decompress a likely block directly with decompress({ blockId: \"b…\" }).",
    ].join("\n");
  }
  const lines = [
    `Found ${report.results.length} match(es) for "${query}" (searched ${report.blockCount} block(s) + ${report.messageCount} folded message(s)):`,
  ];
  for (const result of report.results) lines.push("", formatResult(result, state));
  return lines.join("\n");
}
