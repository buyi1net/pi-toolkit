import * as piHost from "@earendil-works/pi-coding-agent";
import type { ProjectedSessionEntry, SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import type { CoreMessage } from "acp-kernel";

export class AcpHostProjectionUnsupportedError extends Error {
  constructor(api: string) {
    super(`Host pi-coding-agent does not provide ${api} (Pi 1.3.0+ required); ACP projection cannot continue`);
    this.name = "AcpHostProjectionUnsupportedError";
  }
}

export function resolveConvertToLlm(host: typeof piHost = piHost): typeof piHost.convertToLlm {
  const convert = host?.convertToLlm;
  if (typeof convert !== "function") throw new AcpHostProjectionUnsupportedError("convertToLlm");
  return convert;
}

export function resolveSessionEntryToContextMessages(
  host: typeof piHost = piHost,
): typeof piHost.sessionEntryToContextMessages {
  const toMessages = host?.sessionEntryToContextMessages;
  if (typeof toMessages !== "function") {
    throw new AcpHostProjectionUnsupportedError("sessionEntryToContextMessages");
  }
  return toMessages;
}

export type AcPAgentMessage = SessionMessageEntry["message"];

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
  if (msg.role === "system") {

    const text = acpExtractText(msg.content);
    return text.length > 0 ? [{ id, role: "system", contentType: "text", text }] : [];
  }
  const [llm] = resolveConvertToLlm()([message]);
  if (!llm || (llm.role !== "user" && llm.role !== "system")) return [];
  const text = acpExtractText((llm as { content?: unknown }).content);
  if (text.trim().length === 0) return [];
  return [{ id, role: llm.role, contentType: "text", text }];
}

function coreIdOfEntryMessage(entryId: string, index: number): string {
  return index === 0 ? entryId : `${entryId}@${index + 1}`;
}

export function acpCoreMessagesOfProjectedEntry(slot: ProjectedSessionEntry): CoreMessage[] {
  const out: CoreMessage[] = [];
  slot.messages.forEach((message, index) => {
    out.push(...acpProjectMessage(message as AcPAgentMessage, coreIdOfEntryMessage(slot.sourceEntry.id, index)));
  });
  return out;
}

export function acpProjectedEntriesToCoreMessages(
  projected: readonly ProjectedSessionEntry[],
): CoreMessage[] {
  const out: CoreMessage[] = [];
  for (const slot of projected) out.push(...acpCoreMessagesOfProjectedEntry(slot));
  return out;
}

export function acpExtraEntriesToCoreMessages(entries: readonly SessionEntry[]): CoreMessage[] {
  const out: CoreMessage[] = [];
  const hostEntryMessages = resolveSessionEntryToContextMessages();
  for (const entry of entries) {
    const messages = hostEntryMessages(entry);
    messages.forEach((message, index) => {
      out.push(...acpProjectMessage(message as AcPAgentMessage, coreIdOfEntryMessage(entry.id, index)));
    });
  }
  return out;
}

function peelTag(text: string): string {

  const match = text.match(REF_TAG);
  if (!match) return text;
  const cut = text.lastIndexOf(match[0]);
  return (text.slice(0, cut) + text.slice(cut + match[0].length)).replace(/\n+$/, "");
}

function coreBodyOf(coreText: string, tag: string): string | null {
  if (!coreText.startsWith(tag)) return null;
  let bodyStart = tag.length;
  if (coreText.charAt(bodyStart) === "\n") bodyStart += 1;
  return coreText.slice(bodyStart);
}

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

function taggableRole(role: unknown): boolean {
  return role === "user" || role === "toolResult" || role === "system" || role === "custom";
}

function acpLlmTextOf(message: AcPAgentMessage): string | null {
  const [llm] = resolveConvertToLlm()([message]);
  if (!llm) return null;
  return acpExtractText((llm as { content?: unknown }).content);
}

function patchTag(original: AcPAgentMessage, tag: string): AcPAgentMessage {
  const base = original as AnyMessage;
  if (!taggableRole(base.role)) return original;
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

export function acpCoreOutToAgentMessages(
  coreOut: readonly CoreMessage[],
  originalById: ReadonlyMap<string, AcPAgentMessage>,
): AcPAgentMessage[] {
  const out: AcPAgentMessage[] = [];
  const emittedSplit = new Set<string>();
  for (const core of coreOut) {

    if (core.id.startsWith("acp_summary_")) continue;

    const hashIdx = core.id.indexOf("#");
    if (hashIdx < 0) {
      const original = originalById.get(core.id);
      if (!original) continue;
      const match = core.text ? core.text.match(REF_TAG) : null;
      if (!match) {
        out.push(original);
        continue;
      }

      const base = original as AnyMessage;
      const coreBody = coreBodyOf(core.text ?? "", match[0]);
      if (base.role === "assistant") {

        out.push(original);
        continue;
      }
      if (!taggableRole(base.role)) {
        const hostText = acpLlmTextOf(original);
        if (coreBody !== null && hostText !== null && trimEndOf(coreBody) !== trimEndOf(hostText)) {
          out.push({
            role: "user",
            content: [{ type: "text", text: `${coreBody}\n\n${match[0]}` }],
            timestamp: Date.now(),
          } as AcPAgentMessage);
          continue;
        }
        out.push(original);
        continue;
      }
      if (
        coreBody !== null &&
        trimEndOf(coreBody) !== trimEndOf(acpExtractText(base.content))
      ) {
        out.push(rebuildBodyFromCore(original, coreBody, match[0]));
        continue;
      }
      out.push(patchTag(original, match[0]));
      continue;
    }

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

export function acpOriginalsOf(projected: readonly ProjectedSessionEntry[]): Map<string, AcPAgentMessage> {
  const map = new Map<string, AcPAgentMessage>();
  for (const slot of projected) {
    slot.messages.forEach((message, index) => {
      map.set(coreIdOfEntryMessage(slot.sourceEntry.id, index), message as AcPAgentMessage);
    });
  }
  return map;
}

function trimEndOf(text: string): string {
  return text.replace(/\s+$/, "");
}

export interface AcpReasoningDropConfig {
  readonly drop?: boolean;
  readonly threshold?: number;
}

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

export function acpCountThinkingChars(messages: readonly AcPAgentMessage[]): number {
  return messages.reduce((n, m) => n + reasoningLength((m as { content?: unknown }).content), 0);
}

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

export interface AcpStripImagesOptions {

  readonly enabled: boolean;

  readonly keepRecent: number;
}

export const ACP_DEFAULT_STRIP_KEEP_RECENT = 5;

const IMAGE_PLACEHOLDER = "[image]";

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
