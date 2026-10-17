// ACP 解压辅助（工单 09）：目标解析、文件落点安全、重复插入判定。
//
// 移植自 billion-context-pi 的 src/decompress-tool.ts（MIT，见模块 UPSTREAM.md），
// 按本仓口径裁剪：
// - 路径安全：toFile 只允许落在系统临时目录 / ~/.cache/opencode / ~/.cache/pi
//   之下（含符号链接逃逸检查），模型给的任意路径一律拒绝；
// - 自动落点：未指定 toFile 且不适合内联时，写 <~/.cache/pi>/acp-decompress/
//   <块或消息>-<时间戳>.txt（重复解压不互相覆盖）；
// - 消息定位：按引用（mNNNNN 或原始 entry id）在会话日志里找原文——块的
//   direct/effective ids 存的是原始 entry id，原文只在日志里；
// - 重复插入判定：同一目标的内联解压结果仍留在当前视图（未被后续压缩块
//   覆盖）时，再次内联解压只返回提示不重复插入，避免同一块内容两份占用
//   上下文（上游靠模型自觉 + K2 原地重折叠，本仓把判定做进引擎）。
//
// 未移植（留工单 10/11）：祖先会话日志回溯（parentSession 继承链）、live-*
// 引用桥接（omp 宿主专用）、omp live tail 合并。

import * as fs from "node:fs/promises";
import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve, relative, basename, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import type { CompressionState, CoreMessage } from "acp-kernel";
import { parseBlockIdArg } from "acp-kernel";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { acpEntriesToCoreMessages } from "./projection.ts";

/** 自动解压输出的目录（与上游 billion-context-pi 同落点） */
const AUTO_DIR = join(homedir() || tmpdir(), ".cache", "pi", "acp-decompress");

/** 文件模式结果里附带的内容头预览长度 */
const PREVIEW_CHARS = 600;

/** 单条消息内联阈值：超过该长度的“单消息解压”也转文件，避免上下文膨胀 */
const MESSAGE_INLINE_THRESHOLD = 2000;

/** toFile 允许的根目录（含符号链接解析后的比较） */
const ALLOWED_DIRS = [tmpdir(), join(homedir(), ".cache", "opencode"), join(homedir(), ".cache", "pi")];

/**
 * 解析 toFile 路径：展开 ~，检查是否落在允许目录之下。返回绝对路径或错误
 * 文本。符号链接逐段解析（已存在的最长祖先先 realpath，悬空链接用 lstat/
 * readlink 跟踪），允许目录内的符号链接目录不得成为逃逸通道。
 */
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
      // 不可 stat 或不是链接：按字面分量继续
    }
  }
  // 根目录也 realpath（macOS /var → /private/var），字符串形态不误伤
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

/** 自动生成解压输出文件路径（时间戳后缀：同一块重复解压不互相覆盖） */
export function acpAutoRestoreFilePath(target: string): string {
  return join(AUTO_DIR, `${target}-${Date.now()}.txt`);
}

/** 写解压输出文件（自动建目录）；调用方负责路径已通过安全解析 */
export async function acpWriteRestoreFile(filePath: string, text: string): Promise<void> {
  await fs.mkdir(dirname(filePath), { recursive: true }).catch(() => undefined);
  await fs.writeFile(filePath, text, "utf8");
}

/** 文件模式结果里的头预览（截断提示模型用 read 工具看全文） */
export function acpHeadPreview(text: string): string {
  if (text.length <= PREVIEW_CHARS) return text;
  return `${text.slice(0, PREVIEW_CHARS)}\n\n... (truncated; use read tool for full content)`;
}

/** 单条消息是否适合内联返回（小消息内联，大消息转文件） */
export function acpMessageFitsInline(text: string): boolean {
  return text.length < MESSAGE_INLINE_THRESHOLD;
}

/**
 * 按引用在会话日志里找单条消息原文：接受内核引用（mNNNNN，经 byRef 换回
 * 原始 id）或原始 entry id（含 `entryId#callId` 拆分形态）。找不到返回 null。
 */
export function acpFindMessageByRef(
  ref: string,
  state: CompressionState,
  entries: readonly SessionEntry[],
): { text: string; role: CoreMessage["role"]; rawId: string } | null {
  const rawId = /^m\d+$/.test(ref) ? state.messageRefs.byRef[ref] : ref;
  if (!rawId) return null;
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    for (const core of acpEntriesToCoreMessages([entry])) {
      if (core.id === rawId) return { text: core.text ?? "", role: core.role, rawId };
    }
  }
  return null;
}

/** 引用参数的规范化形态：m 引用换回原始 entry id，块 id 归一到 bN 形态，
 *  其余原样——同一目标的不同写法（b1 / 1 / m 引用）判定为同一目标 */
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

/**
 * 同一目标的内联解压结果是否仍在当前视图（未压缩掉）：
 * 扫描会话日志里成功的 decompress 调用（参数 blockId 与目标一致），其
 * toolResult 条目未被任何活动块覆盖时即“仍可见”。reload / resume / fork 后
 * 照样成立（日志是事实源）；结果被压缩回收后返回 null，允许重新插入。
 */
export function acpFindVisibleInlineRestore(
  target: string,
  state: CompressionState,
  entries: readonly SessionEntry[],
): { resultEntryId: string } | null {
  const canonical = acpCanonicalTarget(target, state);
  const callArgById = new Map<string, string>();
  const okResults: { toolCallId: string; entryId: string }[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = (entry as { message?: { role?: string; toolName?: string; toolCallId?: string; isError?: boolean; content?: unknown } }).message;
    if (!message) continue;
    if (message.role === "assistant") {
      for (const call of toolCallsOf(message.content)) {
        if (call.name !== "decompress") continue;
        const arg = blockIdArgOf(call.arguments);
        if (arg !== null && acpCanonicalTarget(arg, state) === canonical) {
          callArgById.set(call.id, canonical);
        }
      }
    } else if (message.role === "toolResult" && message.toolName === "decompress" && message.isError !== true) {
      if (message.toolCallId && callArgById.get(message.toolCallId) === canonical) {
        okResults.push({ toolCallId: message.toolCallId, entryId: entry.id });
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

/** 块覆盖区的原始消息在会话日志条目里缺席时的补充来源（树导航/分支切换） */
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
