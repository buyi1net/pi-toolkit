import { closeSync, openSync, readdirSync, readSync, statSync, type Stats } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

const HEAD_WINDOW_BYTES = 64 * 1024;

const TAIL_WINDOW_BYTES = 128 * 1024;

export function peersSessionsRoot(agentDir: string): string {
  return join(agentDir, "sessions");
}

export function peersProjectDirName(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

export interface PeersDiskSession {
  readonly sessionId: string;

  readonly cwd: string | null;
  readonly sessionFile: string;

  readonly modifiedAt: number;

  readonly name: string | null;
}

export interface PeersDiskScanStats {

  readonly filesSeen: number;

  readonly sessionsFound: number;

  readonly filesParsed: number;
  readonly cacheHits: number;

  readonly bytesRead: number;
}

export interface PeersDiskScanOutput {

  readonly sessions: readonly PeersDiskSession[];

  readonly truncated: boolean;
  readonly stats: PeersDiskScanStats;
}

export interface PeersDiskScanner {

  scan(request?: { readonly limit?: number }): PeersDiskScanOutput;
}

interface SessionHead {
  readonly sessionId: string;
  readonly cwd: string | null;
}

interface CacheRecord {
  readonly mtimeMs: number;
  readonly size: number;

  readonly session: PeersDiskSession | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errnoCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

const SKIPPABLE_FILE_CODES = new Set(["ENOENT", "ENOTDIR", "EACCES", "EPERM", "EBUSY"]);

function isSkippableFileError(error: unknown): boolean {
  const code = errnoCode(error);
  return code !== undefined && SKIPPABLE_FILE_CODES.has(code);
}

function parseEntryLine(line: string): unknown {
  const text = line.trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function headerCandidate(line: string): SessionHead | null | undefined {
  const entry = parseEntryLine(line);
  if (entry === undefined) return undefined;
  if (!isRecord(entry) || entry.type !== "session" || typeof entry.id !== "string" || entry.id === "") {
    return null;
  }
  const cwd = typeof entry.cwd === "string" && entry.cwd !== "" ? entry.cwd : null;
  return { sessionId: entry.id, cwd };
}

function sessionIdFromFileName(fileName: string): string | null {
  const marker = fileName.lastIndexOf("_");
  if (marker < 0) return null;
  const candidate = fileName.slice(marker + 1).replace(/\.jsonl$/, "");
  if (candidate.length < 8 || candidate.length > 64) return null;
  return /^[0-9a-f]+(?:-[0-9a-f]+)+$/.test(candidate) ? candidate : null;
}

function readSessionHead(filePath: string, stats: { bytesRead: number }): SessionHead | null {
  const fd = openSync(filePath, "r");
  try {
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.allocUnsafe(HEAD_WINDOW_BYTES);
    let pending = "";
    let remaining = HEAD_WINDOW_BYTES;
    let sawEof = false;
    while (remaining > 0) {
      const readBytes = readSync(fd, buffer, 0, Math.min(buffer.length, remaining), null);
      if (readBytes === 0) {
        sawEof = true;
        break;
      }
      stats.bytesRead += readBytes;
      remaining -= readBytes;
      pending += decoder.write(buffer.subarray(0, readBytes));
      let lineStart = 0;
      let newlineIndex = pending.indexOf("\n", lineStart);
      while (newlineIndex !== -1) {
        const candidate = headerCandidate(pending.slice(lineStart, newlineIndex));
        if (candidate !== undefined) return candidate;
        lineStart = newlineIndex + 1;
        newlineIndex = pending.indexOf("\n", lineStart);
      }
      pending = pending.slice(lineStart);
    }
    pending += decoder.end();

    return sawEof ? (headerCandidate(pending) ?? null) : null;
  } finally {
    closeSync(fd);
  }
}

function readSessionName(filePath: string, size: number, stats: { bytesRead: number }): string | null {
  const length = Math.min(size, TAIL_WINDOW_BYTES);
  const position = size - length;
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    const readBytes = readSync(fd, buffer, 0, length, position);
    if (readBytes === 0) return null;
    stats.bytesRead += readBytes;
    const raw = buffer.subarray(0, readBytes);
    let text: string;
    if (position > 0) {
      const firstNewline = raw.indexOf(10);
      if (firstNewline === -1) return null;
      text = raw.subarray(firstNewline + 1).toString("utf8");
    } else {
      text = raw.toString("utf8");
    }
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const entry = parseEntryLine(lines[i]);
      if (entry === undefined) continue;
      if (isRecord(entry) && entry.type === "session_info") {
        const name = entry.name;
        return typeof name === "string" && name.trim() !== "" ? name.trim() : null;
      }
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

const EMPTY_STATS: PeersDiskScanStats = Object.freeze({
  filesSeen: 0,
  sessionsFound: 0,
  filesParsed: 0,
  cacheHits: 0,
  bytesRead: 0,
});

export function createPeersDiskScanner(options: { readonly agentDir: string }): PeersDiskScanner {
  const cache = new Map<string, CacheRecord>();

  const scan = (request?: { limit?: number }): PeersDiskScanOutput => {
    const root = peersSessionsRoot(options.agentDir);
    let rootStat: Stats;
    try {
      rootStat = statSync(root);
    } catch (error) {
      if (errnoCode(error) === "ENOENT") {

        cache.clear();
        return { sessions: [], truncated: false, stats: EMPTY_STATS };
      }
      throw error;
    }
    if (!rootStat.isDirectory()) {
      cache.clear();
      throw new Error(`会话文件树根不是目录：${root}`);
    }

    const stats = { filesSeen: 0, sessionsFound: 0, filesParsed: 0, cacheHits: 0, bytesRead: 0 };
    const sessions: PeersDiskSession[] = [];
    const seen = new Set<string>();

    for (const projectEntry of readdirSync(root, { withFileTypes: true })) {
      if (!projectEntry.isDirectory() && !projectEntry.isSymbolicLink()) continue;
      const projectPath = join(root, projectEntry.name);
      let files: string[];
      try {
        files = readdirSync(projectPath);
      } catch (error) {
        const code = errnoCode(error);

        if (code === "ENOENT" || code === "ENOTDIR") continue;
        throw error;
      }
      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        const filePath = join(projectPath, file);
        stats.filesSeen += 1;
        seen.add(filePath);

        let fileStat: Stats;
        try {
          fileStat = statSync(filePath);
        } catch (error) {
          if (isSkippableFileError(error)) continue;
          throw error;
        }

        const cached = cache.get(filePath);
        if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
          stats.cacheHits += 1;
          if (cached.session) {
            sessions.push(cached.session);
            stats.sessionsFound += 1;
          }
          continue;
        }

        stats.filesParsed += 1;
        let session: PeersDiskSession | null = null;
        try {
          const head = readSessionHead(filePath, stats);
          const fallbackSessionId = head === null ? sessionIdFromFileName(file) : null;
          if (head !== null || fallbackSessionId !== null) {
            session = {
              sessionId: head !== null ? head.sessionId : fallbackSessionId!,
              cwd: head !== null ? head.cwd : null,
              sessionFile: filePath,
              modifiedAt: fileStat.mtimeMs,
              name: readSessionName(filePath, fileStat.size, stats),
            };
          }
          cache.set(filePath, { mtimeMs: fileStat.mtimeMs, size: fileStat.size, session });
        } catch (error) {
          if (isSkippableFileError(error)) continue;
          throw error;
        }
        if (session) {
          sessions.push(session);
          stats.sessionsFound += 1;
        }
      }
    }

    for (const path of cache.keys()) {
      if (!seen.has(path)) cache.delete(path);
    }

    sessions.sort((a, b) => b.modifiedAt - a.modifiedAt);
    const limit = request?.limit;
    const truncated = limit !== undefined && sessions.length > limit;
    return {
      sessions: truncated ? sessions.slice(0, limit) : sessions,
      truncated,
      stats,
    };
  };

  return { scan };
}
