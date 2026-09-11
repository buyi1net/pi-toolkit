import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { debugLog } from "./diagnostics.ts";
import type { ModelTier } from "./routing.ts";

export interface SessionEntry {
  type: string;
  id: string;
  parentId?: string;
  [key: string]: unknown;
}

export interface MessageEntry extends SessionEntry {
  type: "message";
  message: {
    role: "user" | "assistant" | "toolResult";
    content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  };
}

export type SeededSubagentSessionMode = "lineage-only" | "fork";

/** 当前新建 loadout 的版本;缺少该字段的快照按 legacy 兼容路径处理。 */
export const SUBAGENT_LOADOUT_VERSION = 2;

function getForkContentLines(parentSessionFile: string): string[] {
  const raw = readFileSync(parentSessionFile, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim());

  let truncateAt = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.type === "message" && entry.message?.role === "user") {
        truncateAt = i;
        break;
      }
    } catch {
      // ignore malformed lines
    }
  }

  return lines.slice(0, truncateAt).filter((line) => {
    try {
      return JSON.parse(line).type !== "session";
    } catch {
      return true;
    }
  });
}

export function seedSubagentSessionFile(params: {
  mode: SeededSubagentSessionMode;
  parentSessionFile: string;
  childSessionFile: string;
  childCwd: string;
}): void {
  const header = {
    type: "session",
    version: 3,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    cwd: params.childCwd,
    parentSession: params.parentSessionFile,
  };
  const contentLines =
    params.mode === "fork" ? getForkContentLines(params.parentSessionFile) : [];
  const lines = [JSON.stringify(header), ...contentLines];

  mkdirSync(dirname(params.childSessionFile), { recursive: true });
  writeFileSync(params.childSessionFile, lines.join("\n") + "\n", "utf8");
}

/**
 * A snapshot of everything needed to reconstruct a subagent's sandbox when its
 * session is later resumed via `subagent_message({ sessionId })`.
 *
 * Written next to the session file as `<sessionFile>.loadout.json` at spawn
 * time. Resume replays this exact snapshot so the reincarnated process gets the
 * the same tool restriction, model, identity, and spawn whitelist,
 * cwd, and config dir it originally ran with. Pi's normal extension
 * discovery remains enabled during resume, just as it is at launch.
 * Storing the resolved loadout (rather than re-deriving from the agent `.md`
 * by name) keeps
 * resume faithful even if the agent definition is later edited, moved, or
 * deleted.
 */
export interface SubagentLoadout {
  /** 新 spawn 写入的版本标记;旧快照缺少该字段,保留 legacy resume 兼容。 */
  snapshotVersion?: number;
  /** Agent profile name (for PI_SUBAGENT_AGENT); null for agentless spawns. */
  agent: string | null;
  /** The `--tools` allowlist string, or null when the spawn was unrestricted. */
  toolAllowlist: string | null;
  /** Model id (without thinking suffix), or null to use the session default. */
  model: string | null;
  /** Thinking level appended to the model as `model:level`, or null. */
  thinking: string | null;
  /** Spawn 显式指定的思考等级,优先于 frontmatter thinking 与 model 自带后缀。 */
  thinkingOverride?: string | null;
  /** How the identity text was applied: append/replace, or null. */
  systemPromptMode: "append" | "replace" | null;
  /** The system-prompt/identity text, only when it lived in the system prompt. */
  identity: string | null;
  /** Agents this subagent was allowed to spawn (for PI_SUBAGENT_ALLOWED). */
  spawnable: string[] | null;
  /** Whether the agent auto-exits (informational; resume forces autonomous). */
  autoExit: boolean;
  /** Working directory the subagent ran in, or null. */
  cwd: string | null;
  /** PI_CODING_AGENT_DIR the subagent resolved config/extensions from, or null. */
  agentDir: string | null;
  /**
   * 请求的模型档位(归一化 fast/balanced/deep),仅作记录;launch 已把 tier
   * 解析成具体 model 存入 model 字段,resume 一律用具体 model,不随配置漂移。
   */
  tier?: ModelTier | null;
  /** 仅用于展示和结果聚合的并行分组标签;resume 时随原快照继承。 */
  cohortId?: string;
  /**
   * 持久团队成员标记(member: true spawn):resume/dependsOn 跨 turn 判定
   * 用——member 无进程级终态,不可作为 dependsOn 目标;旧快照缺省为 false。
   */
  member?: boolean | null;
}

/** Path of the loadout sidecar written next to a subagent session file. */
export function loadoutSidecarPath(sessionFile: string): string {
  return `${sessionFile}.loadout.json`;
}

/** Persist a subagent's resolved sandbox loadout beside its session file. */
export function writeSubagentLoadout(sessionFile: string, loadout: SubagentLoadout): void {
  try {
    writeFileSync(loadoutSidecarPath(sessionFile), JSON.stringify(loadout), "utf8");
  } catch {
    // Best-effort: a missing snapshot only means resume will refuse, never that
    // it launches unrestricted.
  }
}

/** Read a subagent's loadout snapshot, or null if absent/unparseable. */
export function readSubagentLoadout(sessionFile: string): SubagentLoadout | null {
  try {
    const p = loadoutSidecarPath(sessionFile);
    if (!existsSync(p)) return null;
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as SubagentLoadout;
  } catch {
    return null;
  }
}

// ── 父侧锚定的 loadout 快照(resume 授权单一真源)──────────────────────
//
// 信任模型(诚实边界):子代理与扩展宿主运行在同一用户下,任何同用户进程
// 原则上都写得了双方的目录——锚定快照不提供绝对隔离。它提供的是一致性
// 交叉校验:子代理可写的 session sidecar(`.loadout.json`)与父侧锚定
// 副本必须逐字段一致,resume 才放行;以锚定副本为运行配置。篡改者必须
// 同时一致地改写两份独立位置(tree)的副本才能扩权——这堵死了“只改
// session sidecar 即可扩权”的廉价路径,并让篡改可检测(不静默放宽)。

/** 父侧锚定副本:内容同 SubagentLoadout,额外记录被锚定的 session 路径。 */
export interface AnchoredSubagentLoadout extends SubagentLoadout {
  /** 被锚定的子代理 session 文件绝对路径(containment 精确匹配基准)。 */
  sessionFile: string;
}

/** 锚定副本存放目录(父会话 artifactDir 下,父进程控制)。 */
export function anchoredLoadoutPath(artifactDir: string, sessionFile: string): string {
  return join(artifactDir, "loadouts", `${basename(sessionFile)}.loadout.json`);
}

/** 在父会话 artifactDir 写入锚定副本;返回写入路径。 */
export function writeAnchoredLoadout(
  artifactDir: string,
  sessionFile: string,
  loadout: SubagentLoadout,
): string {
  const path = anchoredLoadoutPath(artifactDir, sessionFile);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ ...loadout, sessionFile } satisfies AnchoredSubagentLoadout),
    "utf8",
  );
  return path;
}

/** 读取锚定副本;缺失/损坏返回 null,由调用方按父 registry 的 anchored 标记决定是否拒绝 legacy fallback。 */
export function readAnchoredLoadout(
  artifactDir: string,
  sessionFile: string,
): AnchoredSubagentLoadout | null {
  try {
    const p = anchoredLoadoutPath(artifactDir, sessionFile);
    if (!existsSync(p)) return null;
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    if (!parsed || typeof parsed !== "object" || typeof (parsed as any).sessionFile !== "string") {
      return null;
    }
    return parsed as AnchoredSubagentLoadout;
  } catch {
    return null;
  }
}

/**
 * 比较 session sidecar 与锚定副本的安全相关字段,返回不一致的字段名列表。
 * 这些字段共同决定 resume 时的授权面(工具白名单、繁衍白名单、身份、
 * 模型、agentDir、cwd、member 标记):任何被改动都视为篡改/损坏。
 */
const LOADOUT_SECURITY_FIELDS = [
  "snapshotVersion",
  "agent",
  "toolAllowlist",
  "model",
  "thinking",
  "thinkingOverride",
  "systemPromptMode",
  "identity",
  "spawnable",
  "autoExit",
  "cwd",
  "agentDir",
  "tier",
  "member",
] as const;

export function diffSubagentLoadouts(
  anchored: AnchoredSubagentLoadout,
  onDisk: SubagentLoadout,
): string[] {
  const diffs: string[] = [];
  for (const field of LOADOUT_SECURITY_FIELDS) {
    const a = (anchored as unknown as Record<string, unknown>)[field];
    const b = (onDisk as unknown as Record<string, unknown>)[field];
    const same = Array.isArray(a) && Array.isArray(b)
      ? a.length === b.length && [...a].sort().every((value, index) => value === [...b].sort()[index])
      : a === b;
    if (!same) diffs.push(field);
  }
  return diffs;
}

// ── Name registry ────────────────────────────────────────────────────────────
// Each spawner session (the top-level pi session, or a worker that spawns its
// own children) gets a registry mapping a subagent's display name to the
// session file it ran in. Names are unique per spawner session and persist on
// disk, so `subagent_message({ name })` can steer a running subagent or resume
// a finished one by the same handle — even across a pi restart. The registry
// lives in the spawner's own artifact dir, which is directly addressable from
// the spawner's session id (no sessions-tree scan, so resume stays fast).

export interface NameRegistryEntry {
  /** Absolute path to the subagent's session .jsonl file. */
  sessionFile: string;
  /** Canonical session header id (kept for display/lineage). */
  sessionId: string | null;
  /** 仅用于展示和结果聚合的并行分组标签。 */
  cohortId?: string;
  /**
   * True when the parent wrote an anchored loadout for this spawn. This marker
   * lives in the parent registry so deleting the anchor cannot silently turn a
   * new snapshot into a legacy resume.
   */
  anchored?: boolean;
}

export type NameRegistry = Record<string, NameRegistryEntry>;

/** Path of the name registry for a given spawner session's artifact dir. */
export function nameRegistryPath(artifactDir: string): string {
  return join(artifactDir, "subagent-registry.json");
}

/** Read a spawner session's name registry, or {} if absent/corrupt. */
export function readNameRegistry(artifactDir: string): NameRegistry {
  try {
    const p = nameRegistryPath(artifactDir);
    if (!existsSync(p)) return {};
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as NameRegistry;
  } catch {
    return {};
  }
}

/**
 * Register (or overwrite) a name → session mapping for a spawner session.
 * Writes atomically (temp file + rename) so a concurrent reader never sees a
 * partial registry.
 */
// 同一进程内的串行化队列:并发 spawn 的 registerName 是 read-modify-write,
// 无队列时后写会覆盖先写,导致某个名字无法 resume。

// 注:registerName 是全同步函数(无 await),JS 单线程下天然串行,并行 spawn
// 不会造成 read-modify-write 交错覆盖(2026-08-30 审查复核结论)。
export function registerName(
  artifactDir: string,
  name: string,
  entry: NameRegistryEntry,
): void {
  try {
    mkdirSync(artifactDir, { recursive: true });
    const registry = readNameRegistry(artifactDir);
    registry[name] = entry;
    const p = nameRegistryPath(artifactDir);
    const tmp = `${p}.tmp-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
    writeFileSync(tmp, JSON.stringify(registry, null, 2), "utf8");
    renameSync(tmp, p);
  } catch (error) {
    // Best-effort: a failed registration only means resume-by-name won't find
    // this subagent later; it never breaks the spawn itself.
    debugLog(`Could not register subagent name ${name}`, error);
  }
}

/** Resolve a name to its registry entry within a spawner session, or null. */
export function resolveNameInRegistry(
  artifactDir: string,
  name: string,
): NameRegistryEntry | null {
  const entry = readNameRegistry(artifactDir)[name];
  return entry && typeof entry.sessionFile === "string" ? entry : null;
}

function readEntries(sessionFile: string): SessionEntry[] {
  const raw = readFileSync(sessionFile, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as SessionEntry);
}

/**
 * Return the id of the last entry in the session file (current branch point / leaf).
 */
export function getLeafId(sessionFile: string): string | null {
  const entries = readEntries(sessionFile);
  return entries.length > 0 ? entries[entries.length - 1].id : null;
}

/**
 * Read the canonical session id from a session file's header.
 *
 * pi's `--session <id>` flag resolves against this header `id` (exact match,
 * then prefix), NOT the filename — so this is the value to hand back to the
 * orchestrator for follow-ups.
 */
/**
 * Read only the first line of a file without loading the whole thing into
 * memory. Session files grow to many MB, but the header we need is always the
 * first JSON line, so reading a small prefix keeps header lookups cheap — this
 * is what makes scanning a large session tree fast enough to avoid blocking the
 * event loop. Returns the first line (sans trailing newline), or null.
 */
function readFirstLine(path: string, maxBytes = 65536): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.allocUnsafe(maxBytes);
    const bytes = readSync(fd, buf, 0, maxBytes, 0);
    if (bytes <= 0) return null;
    const nl = buf.indexOf(0x0a); // '\n'
    const end = nl === -1 || nl >= bytes ? bytes : nl;
    return buf.toString("utf8", 0, end);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

export function getSessionId(sessionFile: string): string | null {
  return readHeaderId(sessionFile);
}

function readHeaderId(sessionFile: string): string | null {
  const firstLine = readFirstLine(sessionFile)?.trim();
  if (!firstLine) return null;
  try {
    const entry = JSON.parse(firstLine) as { type?: string; id?: string };
    return entry.type === "session" && typeof entry.id === "string" ? entry.id : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a session id (or id prefix) to a session file path by scanning every
 * `*.jsonl` under `sessionsRoot` and matching the header `id`. Mirrors pi's own
 * resolution order: exact match first, then prefix match. Most recently
 * modified file wins on ties. Returns null when nothing matches.
 */
/**
 * In-process index of session id → session file, per sessions root.
 *
 * Resolving a session id naively walks every `.jsonl` under the sessions tree
 * and reads each header. With a few thousand sessions that is thousands of
 * synchronous open/read/stat syscalls — on the extension host's single thread
 * that blocks the entire terminal UI for many seconds (measured ~67s on a
 * 2010-file tree). To avoid that, we build the index once per root and cache
 * it; subsequent lookups are O(1). The cache is validated cheaply (a directory
 * listing plus statSync-only mtime checks) on every call, so new sessions are
 * picked up without re-reading unchanged headers and without ever freezing the
 * UI again.
 */
interface SessionIndex {
  idToFile: Map<string, { path: string; mtime: number }>;
  /** file path → mtime when indexed (staleness detection). */
  files: Map<string, number>;
  /** top-level dir signature used to detect newly added cwd dirs. */
  topSig: string;
}
const sessionIndexCache = new Map<string, SessionIndex>();

function topLevelSignature(root: string): string {
  const parts: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return "";
  }
  for (const e of entries) {
    const full = join(root, e.name);
    if (e.isDirectory()) {
      let m = 0;
      try {
        m = statSync(full).mtimeMs;
      } catch {
        /* ignore */
      }
      parts.push(`d:${e.name}:${m}`);
    } else if (e.isFile() && e.name.endsWith(".jsonl")) {
      parts.push(`f:${e.name}`);
    }
  }
  parts.sort();
  return parts.join("|");
}

/** Recursively index new/changed .jsonl files under dir into idx. */
function indexDir(dir: string, idx: SessionIndex): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      indexDir(full, idx);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      let mtime = 0;
      try {
        mtime = statSync(full).mtimeMs;
      } catch {
        continue;
      }
      const known = idx.files.get(full);
      if (known !== undefined && known === mtime) continue; // unchanged
      const id = readHeaderId(full); // only read headers for new/changed files
      idx.files.set(full, mtime);
      if (!id) continue;
      const prev = idx.idToFile.get(id);
      if (!prev || mtime >= prev.mtime) {
        idx.idToFile.set(id, { path: full, mtime });
      }
    }
  }
}

function getSessionIndex(sessionsRoot: string): SessionIndex {
  let idx = sessionIndexCache.get(sessionsRoot);
  const sig = topLevelSignature(sessionsRoot);
  if (!idx) {
    idx = { idToFile: new Map(), files: new Map(), topSig: sig };
    sessionIndexCache.set(sessionsRoot, idx);
    indexDir(sessionsRoot, idx); // first build: full scan, once per process
  } else if (idx.topSig !== sig) {
    idx.topSig = sig;
    indexDir(sessionsRoot, idx); // a cwd dir was added/changed: incremental rescan
  } else {
    indexDir(sessionsRoot, idx); // cheap: stats files, reads only new/changed headers
  }
  return idx;
}

export function resolveSessionFileById(sessionId: string, sessionsRoot: string): string | null {
  if (!sessionId || !existsSync(sessionsRoot)) return null;
  const idx = getSessionIndex(sessionsRoot);
  return lookupSessionIndex(idx, sessionId);
}

function lookupSessionIndex(
  idx: { idToFile: Map<string, { path: string; mtime: number }> },
  sessionId: string,
): string | null {
  // Exact match first.
  const exact = idx.idToFile.get(sessionId);
  if (exact && existsSync(exact.path)) return exact.path;

  // Prefix match: most recently modified wins (ids are unique in practice, so
  // this is only a convenience for hand-typed short prefixes).
  let best: { path: string; mtime: number } | null = null;
  for (const [id, rec] of idx.idToFile) {
    if (!id.startsWith(sessionId)) continue;
    if (!existsSync(rec.path)) continue;
    if (!best || rec.mtime > best.mtime) best = rec;
  }
  return best ? best.path : null;
}

/**
 * Async variant used by the interactive resume path. Index building/refresh is
 * synchronous I/O, which can take many seconds on a cold OS page cache with a
 * few thousand sessions; running it synchronously would block the extension
 * host's single thread and freeze the terminal UI. Deferring to a macrotask
 * keeps the event loop responsive. The heavy work only happens on the first
 * resolution per process (and incrementally thereafter); warm lookups are ~50ms.
 */
export async function resolveSessionFileByIdAsync(
  sessionId: string,
  sessionsRoot: string,
): Promise<string | null> {
  if (!sessionId || !existsSync(sessionsRoot)) return null;
  // Let the event loop breathe (and the UI repaint) before the sync scan.
  await new Promise<void>((r) => setImmediate(r));
  const idx = getSessionIndex(sessionsRoot);
  return lookupSessionIndex(idx, sessionId);
}

/** Test hook: drop the cached session index so tests start clean. */
export function resetSessionIndexCache(): void {
  sessionIndexCache.clear();
}

/**
 * Count the number of entry lines in a session file without parsing each line
 * into an object. Used by the resume path, which only needs the *count* of
 * pre-existing entries (so it can later slice out the new ones). Parsing every
 * line of a large resumed transcript synchronously at resume time would block
 * the UI; counting newlines is dramatically cheaper.
 */
export function countSessionEntryLines(sessionFile: string): number {
  let fd = -1;
  try {
    fd = openSync(sessionFile, "r");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let count = 0;
    let hasContent = false;

    for (;;) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      for (let i = 0; i < bytesRead; i++) {
        const byte = buffer[i];
        if (byte === 0x0a) {
          if (hasContent) count++;
          hasContent = false;
        } else if (byte !== 0x0d && byte !== 0x20 && byte !== 0x09) {
          hasContent = true;
        }
      }
    }
    if (hasContent) count++;
    return count;
  } catch {
    return 0;
  } finally {
    if (fd !== -1) {
      try { closeSync(fd); } catch {}
    }
  }
}

function parseSessionLines(raw: string, afterLine: number): SessionEntry[] {
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .slice(afterLine)
    .map((line) => JSON.parse(line) as SessionEntry);
}

export function getNewEntries(sessionFile: string, afterLine: number): SessionEntry[] {
  return parseSessionLines(readFileSync(sessionFile, "utf8"), afterLine);
}

export async function getNewEntriesAsync(sessionFile: string, afterLine: number): Promise<SessionEntry[]> {
  return parseSessionLines(await readFile(sessionFile, "utf8"), afterLine);
}

/** 最后一个有意义的 assistant 回合及其终态错误。 */
export interface LastAssistantOutcome {
  /** 最后回复中的文本;错误回合也可能带部分文本。 */
  summary: string | null;
  /** stopReason=error 时的原始错误;没有字段时使用明确的兜底文案。 */
  errorMessage: string | null;
}

/**
 * 读取最后一个 assistant 回合的结构化结果。
 *
 * 错误回合必须先于文本摘要被识别:provider 在生成部分文本后仍可能以
 * stopReason=error 结束,不能因为存在部分文本就把失败上游当作成功。
 */
export function findLastAssistantOutcome(entries: SessionEntry[]): LastAssistantOutcome {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    const msg = entry as MessageEntry;
    if (!msg.message || msg.message.role !== "assistant") continue;

    const content = Array.isArray(msg.message.content) ? msg.message.content : [];
    const texts = content
      .filter(
        (block) =>
          block && block.type === "text" && typeof block.text === "string" && block.text.trim() !== "",
      )
      .map((block) => block.text as string);
    const summary = texts.length > 0 && texts.join("").trim() ? texts.join("\n") : null;
    const stopReason = (msg.message as { stopReason?: unknown }).stopReason;
    if (stopReason === "error") {
      const rawError = (msg.message as { errorMessage?: unknown }).errorMessage;
      const errorMessage = typeof rawError === "string" && rawError.trim()
        ? rawError.trim()
        : "Subagent agent loop ended with stopReason=error (no errorMessage field).";
      return {
        summary: summary ?? (typeof rawError === "string" && rawError.trim()
          ? `Subagent error: ${rawError.trim()}`
          : null),
        errorMessage,
      };
    }
    if (summary != null) return { summary, errorMessage: null };
  }
  return { summary: null, errorMessage: null };
}

/** 保留历史调用方的文本接口;错误回合的兼容摘要格式不变。 */
export function findLastAssistantMessage(entries: SessionEntry[]): string | null {
  return findLastAssistantOutcome(entries).summary;
}

/**
 * Append a branch_summary entry to the session file.
 * Returns the new entry's id.
 */
export function appendBranchSummary(
  sessionFile: string,
  branchPointId: string,
  fromId: string | null,
  summary: string,
): string {
  const id = randomBytes(4).toString("hex");
  const entry = {
    type: "branch_summary",
    id,
    parentId: branchPointId,
    timestamp: new Date().toISOString(),
    fromId: fromId ?? branchPointId,
    summary,
  };
  appendFileSync(sessionFile, JSON.stringify(entry) + "\n", "utf8");
  return id;
}

/**
 * Copy the session file to destDir for parallel worker isolation.
 * Returns the path of the copy.
 */
export function copySessionFile(sessionFile: string, destDir: string): string {
  const id = randomBytes(4).toString("hex");
  const dest = join(destDir, `subagent-${id}.jsonl`);
  copyFileSync(sessionFile, dest);
  return dest;
}

/**
 * Read new entries from sourceFile (after afterLine), append them to targetFile.
 * Returns the appended entries.
 */
export function mergeNewEntries(
  sourceFile: string,
  targetFile: string,
  afterLine: number,
): SessionEntry[] {
  const entries = getNewEntries(sourceFile, afterLine);
  for (const entry of entries) {
    appendFileSync(targetFile, JSON.stringify(entry) + "\n", "utf8");
  }
  return entries;
}

export interface SessionStats {
  model: string | null;
  toolCount: number;
  /** Cumulative token usage across all assistant turns. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Current context size: the last assistant turn's totalTokens. */
  contextTokens: number;
  /** Cumulative cost in USD across all assistant turns. */
  cost: number;
}

/**
 * Parse a completed subagent session JSONL into aggregate stats for display:
 * model, tool-call count, cumulative token usage + cost, and current context
 * size. Cumulative usage fields are summed across every assistant turn; the
 * context size is taken from the last assistant turn's `totalTokens` (the live
 * context window occupancy). Returns null if the file can't be read.
 */
function summarizeEntries(entries: SessionEntry[]): SessionStats {
  const stats: SessionStats = {
    model: null,
    toolCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    contextTokens: 0,
    cost: 0,
  };

  for (const entry of entries) {
    if (entry.type === "model_change") {
      const modelId = (entry as { modelId?: unknown }).modelId;
      if (typeof modelId === "string" && modelId) stats.model = modelId;
      continue;
    }
    if (entry.type !== "message") continue;
    const msg = (entry as MessageEntry).message;
    if (msg.role !== "assistant") continue;

    const model = (msg as { model?: unknown }).model;
    if (typeof model === "string" && model) stats.model = model;
    for (const block of msg.content) {
      if (block.type === "toolCall") stats.toolCount++;
    }

    const usage = (msg as { usage?: Record<string, unknown> }).usage;
    if (usage && typeof usage === "object") {
      const num = (value: unknown): number =>
        typeof value === "number" && Number.isFinite(value) ? value : 0;
      stats.inputTokens += num(usage.input);
      stats.outputTokens += num(usage.output);
      stats.cacheReadTokens += num(usage.cacheRead);
      stats.cacheWriteTokens += num(usage.cacheWrite);
      const total = num(usage.totalTokens);
      if (total > 0) stats.contextTokens = total;
      const cost = usage.cost;
      if (cost && typeof cost === "object") stats.cost += num((cost as Record<string, unknown>).total);
    }
  }
  return stats;
}

export function summarizeSessionStats(sessionFile: string): SessionStats | null {
  try {
    return summarizeEntries(readEntries(sessionFile));
  } catch {
    return null;
  }
}

export async function summarizeSessionStatsAsync(sessionFile: string): Promise<SessionStats | null> {
  try {
    return summarizeEntries(parseSessionLines(await readFile(sessionFile, "utf8"), 0));
  } catch {
    return null;
  }
}
