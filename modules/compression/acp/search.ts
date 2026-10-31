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
import type { ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";
import { acpCoreMessagesOfProjectedEntry } from "./projection.ts";

function buildCoveredIds(state: CompressionState): Set<string> {
  const covered = new Set<string>();
  for (const block of state.blocks) {
    for (const id of block.effectiveMessageIds) covered.add(id);
  }
  return covered;
}

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

export function acpBuildSearchDocs(
  state: CompressionState,
  projected: readonly ProjectedSessionEntry[],
): SearchDoc[] {
  const covered = buildCoveredIds(state);
  const owner = buildOwnerMap(state);
  const tierByBlock = new Map(state.blocks.map((block) => [block.blockId, block.tier]));

  const messages: MessageInput[] = [];
  for (const slot of projected) {
    for (const core of acpCoreMessagesOfProjectedEntry(slot)) {
      const role = toSearchRole(core.role);
      if (!role) continue;
      if (!covered.has(core.id)) continue;
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

  readonly results: readonly SearchResult[];

  readonly blockCount: number;

  readonly messageCount: number;
}

export function acpRunSearch(
  state: CompressionState,
  projected: readonly ProjectedSessionEntry[],
  query: string,
  limit?: number,
): AcpSearchReport {
  const docs = acpBuildSearchDocs(state, projected);
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
