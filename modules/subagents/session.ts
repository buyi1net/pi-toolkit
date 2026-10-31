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
import { type ModelTier } from "./routing.ts";
import { resolveAppliedThinking, type LoadoutRoutingSnapshot } from "./routing-snapshot.ts";
import type { SubagentProtocol } from "./protocol.ts";

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

export interface SubagentLoadout {

  snapshotVersion?: number;

  protocol?: SubagentProtocol;

  agent: string | null;

  toolAllowlist: string | null;

  model: string | null;

  modelIdentity?: { provider: string; id: string; api: string; baseUrl: string } | null;

  surfaceKind?: "herdr" | "tmux";

  thinking: string | null;

  thinkingOverride?: string | null;

  tierThinking?: string | null;

  parentThinking?: string | null;

  routing?: LoadoutRoutingSnapshot | null;

  systemPromptMode: "append" | "replace" | null;

  identity: string | null;

  spawnable: string[] | null;

  autoExit: boolean;

  cwd: string | null;

  agentDir: string | null;

  tier?: ModelTier | null;

  cohortId?: string;

  member?: boolean | null;
}

export function loadoutSidecarPath(sessionFile: string): string {
  return `${sessionFile}.loadout.json`;
}

export function appliedLoadoutThinking(loadout: SubagentLoadout): string | null {
  return resolveAppliedThinking(loadout).level;
}

export function writeSubagentLoadout(sessionFile: string, loadout: SubagentLoadout): void {
  try {
    writeFileSync(loadoutSidecarPath(sessionFile), JSON.stringify(loadout), "utf8");
  } catch {
    // Best-effort: a missing snapshot only means resume will refuse, never that
    // it launches unrestricted.
  }
}

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

export interface AnchoredSubagentLoadout extends SubagentLoadout {

  sessionFile: string;
}

export function anchoredLoadoutPath(artifactDir: string, sessionFile: string): string {
  return join(artifactDir, "loadouts", `${basename(sessionFile)}.loadout.json`);
}

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

const LOADOUT_SECURITY_FIELDS = [
  "snapshotVersion",
  "protocol",
  "agent",
  "toolAllowlist",
  "model",
  "modelIdentity",
  "surfaceKind",
  "thinking",
  "thinkingOverride",
  "tierThinking",

  "parentThinking",
  "systemPromptMode",
  "identity",
  "spawnable",
  "autoExit",
  "cwd",
  "agentDir",
  "tier",
  "member",
] as const;

function loadoutValuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    const unmatched = [...b];
    for (const value of a) {
      const index = unmatched.findIndex((candidate) => loadoutValuesEqual(value, candidate));
      if (index < 0) return false;
      unmatched.splice(index, 1);
    }
    return unmatched.length === 0;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const aRecord = a as Record<string, unknown>;
    const bRecord = b as Record<string, unknown>;
    const aKeys = Object.keys(aRecord).sort();
    const bKeys = Object.keys(bRecord).sort();
    return aKeys.length === bKeys.length && aKeys.every((key, index) => key === bKeys[index] && loadoutValuesEqual(aRecord[key], bRecord[key]));
  }
  return false;
}

export function diffSubagentLoadouts(
  anchored: AnchoredSubagentLoadout,
  onDisk: SubagentLoadout,
): string[] {
  const diffs: string[] = [];
  for (const field of LOADOUT_SECURITY_FIELDS) {
    const a = (anchored as unknown as Record<string, unknown>)[field];
    const b = (onDisk as unknown as Record<string, unknown>)[field];
    const same = loadoutValuesEqual(a, b);
    if (!same) diffs.push(field);
  }
  return diffs;
}

export interface NameRegistryEntry {

  sessionFile: string;

  sessionId: string | null;

  cohortId?: string;

  anchored?: boolean;
}

export type NameRegistry = Record<string, NameRegistryEntry>;

export function nameRegistryPath(artifactDir: string): string {
  return join(artifactDir, "subagent-registry.json");
}

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

    debugLog(`Could not register subagent name ${name}`, error);
  }
}

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

export function getLeafId(sessionFile: string): string | null {
  const entries = readEntries(sessionFile);
  return entries.length > 0 ? entries[entries.length - 1].id : null;
}

function readFirstLine(path: string, maxBytes = 65536): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.allocUnsafe(maxBytes);
    const bytes = readSync(fd, buf, 0, maxBytes, 0);
    if (bytes <= 0) return null;
    const nl = buf.indexOf(0x0a);
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

interface SessionIndex {
  idToFile: Map<string, { path: string; mtime: number }>;

  files: Map<string, number>;

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
      if (known !== undefined && known === mtime) continue;
      const id = readHeaderId(full);
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
    indexDir(sessionsRoot, idx);
  } else if (idx.topSig !== sig) {
    idx.topSig = sig;
    indexDir(sessionsRoot, idx);
  } else {
    indexDir(sessionsRoot, idx);
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

  const exact = idx.idToFile.get(sessionId);
  if (exact && existsSync(exact.path)) return exact.path;

  let best: { path: string; mtime: number } | null = null;
  for (const [id, rec] of idx.idToFile) {
    if (!id.startsWith(sessionId)) continue;
    if (!existsSync(rec.path)) continue;
    if (!best || rec.mtime > best.mtime) best = rec;
  }
  return best ? best.path : null;
}

export async function resolveSessionFileByIdAsync(
  sessionId: string,
  sessionsRoot: string,
): Promise<string | null> {
  if (!sessionId || !existsSync(sessionsRoot)) return null;

  await new Promise<void>((r) => setImmediate(r));
  const idx = getSessionIndex(sessionsRoot);
  return lookupSessionIndex(idx, sessionId);
}

export function resetSessionIndexCache(): void {
  sessionIndexCache.clear();
}

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

export interface LastAssistantOutcome {

  summary: string | null;

  errorMessage: string | null;
}

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

export function findLastAssistantMessage(entries: SessionEntry[]): string | null {
  return findLastAssistantOutcome(entries).summary;
}

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

export function copySessionFile(sessionFile: string, destDir: string): string {
  const id = randomBytes(4).toString("hex");
  const dest = join(destDir, `subagent-${id}.jsonl`);
  copyFileSync(sessionFile, dest);
  return dest;
}

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

  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;

  contextTokens: number;

  cost: number;
}

function usageNum(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function accumulateUsage(stats: SessionStats, usage: Record<string, unknown>): void {
  stats.inputTokens += usageNum(usage.input);
  stats.outputTokens += usageNum(usage.output);
  stats.cacheReadTokens += usageNum(usage.cacheRead);
  stats.cacheWriteTokens += usageNum(usage.cacheWrite);
  const cost = usage.cost;
  if (cost && typeof cost === "object") stats.cost += usageNum((cost as Record<string, unknown>).total);
}

function entryUsage(entry: SessionEntry): Record<string, unknown> | undefined {
  const usage = (entry as { usage?: unknown }).usage;
  return usage && typeof usage === "object" ? (usage as Record<string, unknown>) : undefined;
}

function messageUsage(msg: MessageEntry["message"]): Record<string, unknown> | undefined {
  const usage = (msg as { usage?: unknown }).usage;
  return usage && typeof usage === "object" ? (usage as Record<string, unknown>) : undefined;
}

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

    if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") {
      const usage = entryUsage(entry);
      if (usage) accumulateUsage(stats, usage);
      continue;
    }
    if (entry.type !== "message") continue;
    const msg = (entry as MessageEntry).message;
    if (msg.role === "toolResult") {

      const usage = messageUsage(msg);
      if (usage) accumulateUsage(stats, usage);
      continue;
    }
    if (msg.role !== "assistant") continue;

    const model = (msg as { model?: unknown }).model;
    if (typeof model === "string" && model) stats.model = model;
    for (const block of msg.content) {
      if (block.type === "toolCall") stats.toolCount++;
    }

    const usage = messageUsage(msg);
    if (usage) {
      accumulateUsage(stats, usage);
      const total = usageNum(usage.totalTokens);
      if (total > 0) stats.contextTokens = total;
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
