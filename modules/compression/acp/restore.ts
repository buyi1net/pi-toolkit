import * as fs from "node:fs/promises";
import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve, relative, basename, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import type { CompressionState, CoreMessage } from "acp-kernel";
import { parseBlockIdArg } from "acp-kernel";
import type { ProjectedSessionEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { isAcpToolUnavailableDetails } from "./tool-guard.ts";

const AUTO_DIR = join(homedir() || tmpdir(), ".cache", "pi", "acp-decompress");

const PREVIEW_CHARS = 600;

const MESSAGE_INLINE_THRESHOLD = 2000;

const ALLOWED_DIRS = [tmpdir(), join(homedir(), ".cache", "opencode"), join(homedir(), ".cache", "pi")];

export function acpResolveRestoreFilePath(targetPath: string): string | { error: string } {
  const expanded = targetPath.startsWith("~/") ? join(homedir(), targetPath.slice(2)) : targetPath;
  const resolved = resolve(expanded);
  let probe = resolved;
  const suffix: string[] = [];
  while (!existsSync(probe) && probe !== dirname(probe)) {
    suffix.unshift(basename(probe));
    probe = dirname(probe);
  }
  const real = existsSync(probe) ? realpathSync(probe) : probe;
  let checked = real;
  for (const part of suffix) {
    checked = join(checked, part);
    try {
      if (lstatSync(checked).isSymbolicLink()) {
        const target = readlinkSync(checked);
        checked = isAbsolute(target) ? resolve(target) : resolve(dirname(checked), target);
      }
    } catch {

    }
  }

  const allowed = ALLOWED_DIRS.map((dir) => {
    try {
      return realpathSync(dir);
    } catch {
      return dir;
    }
  });
  const isAllowed = allowed.some((dir) => {
    const rel = relative(dir, checked);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
  if (!isAllowed) {
    return {
      error: `Error: toFile path must be under ${tmpdir()}, ~/.cache/opencode, or ~/.cache/pi. Got: ${targetPath}`,
    };
  }
  return checked;
}

export function acpAutoRestoreFilePath(target: string): string {
  return join(AUTO_DIR, `${target}-${Date.now()}.txt`);
}

export async function acpWriteRestoreFile(filePath: string, text: string): Promise<void> {
  await fs.mkdir(dirname(filePath), { recursive: true }).catch(() => undefined);
  await fs.writeFile(filePath, text, "utf8");
}

export function acpHeadPreview(text: string): string {
  if (text.length <= PREVIEW_CHARS) return text;
  return `${text.slice(0, PREVIEW_CHARS)}\n\n... (truncated; use read tool for full content)`;
}

export function acpMessageFitsInline(text: string): boolean {
  return text.length < MESSAGE_INLINE_THRESHOLD;
}

export function acpFindMessageByRef(
  ref: string,
  state: CompressionState,
  coreMessages: readonly CoreMessage[],
): { text: string; role: CoreMessage["role"]; rawId: string } | null {
  const rawId = /^m\d+$/.test(ref) ? state.messageRefs.byRef[ref] : ref;
  if (!rawId) return null;
  for (const core of coreMessages) {
    if (core.id === rawId) return { text: core.text ?? "", role: core.role, rawId };
  }
  return null;
}

export function acpCanonicalTarget(arg: string, state: CompressionState): string {
  if (/^m\d+$/.test(arg)) return state.messageRefs.byRef[arg] ?? arg;
  return parseBlockIdArg(arg) ?? arg;
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

function blockIdArgOf(arguments_: unknown): string | null {
  if (!arguments_ || typeof arguments_ !== "object") {
    return typeof arguments_ === "string" ? arguments_ : null;
  }
  const value = (arguments_ as { blockId?: unknown }).blockId;
  return typeof value === "string" ? value : null;
}

export function acpFindVisibleInlineRestore(
  target: string,
  state: CompressionState,
  projected: readonly ProjectedSessionEntry[],
): { resultEntryId: string } | null {
  const canonical = acpCanonicalTarget(target, state);
  const callArgById = new Map<string, string>();
  const okResults: { toolCallId: string; entryId: string }[] = [];
  for (const slot of projected) {
    for (const message of slot.messages as {
      role?: string;
      toolName?: string;
      toolCallId?: string;
      isError?: boolean;
      details?: unknown;
      content?: unknown;
    }[]) {
      if (!message) continue;
      if (message.role === "assistant") {
        for (const call of toolCallsOf(message.content)) {
          if (call.name !== "decompress") continue;
          const arg = blockIdArgOf(call.arguments);
          if (arg !== null && acpCanonicalTarget(arg, state) === canonical) {
            callArgById.set(call.id, canonical);
          }
        }
      } else if (
        message.role === "toolResult" &&
        message.toolName === "decompress" &&
        message.isError !== true &&
        !isAcpToolUnavailableDetails(message.details)
      ) {
        if (message.toolCallId && callArgById.get(message.toolCallId) === canonical) {
          okResults.push({ toolCallId: message.toolCallId, entryId: slot.sourceEntry.id });
        }
      }
    }
  }
  if (okResults.length === 0) return null;
  const covered = new Set<string>();
  for (const block of state.blocks) {
    if (!block.active) continue;
    for (const id of block.effectiveMessageIds) covered.add(id);
  }
  const visible = okResults.find((r) => !covered.has(r.entryId));
  return visible ? { resultEntryId: visible.entryId } : null;
}

export function acpFetchMissingEntries(
  missingBaseIds: readonly string[],
  ctx: { sessionManager?: { getEntry?: (id: string) => SessionEntry | undefined } },
): SessionEntry[] {
  const fetch = ctx.sessionManager?.getEntry;
  if (typeof fetch !== "function") return [];
  const out: SessionEntry[] = [];
  for (const id of missingBaseIds) {
    const entry = fetch(id);
    if (entry) out.push(entry);
  }
  return out;
}
