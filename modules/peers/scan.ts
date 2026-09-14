// peers 会话文件树的磁盘层扫描（工单 34）：跨项目目录发现会话 + 修改时间缓存。
//
// 布局依据（实测本机 ~/.pi/agent/sessions/ 与宿主文档 session-format.md）：
//   <agentDir>/sessions/--<编码后的项目目录>/<时间戳>_<会话id>.jsonl
// 项目目录名 = "--" + cwd（去首斜杠、/ \ : 全替换为 -）+ "--"；会话元信息在首行
// session 头（id、cwd），会话名取结尾窗口内最新的 session_info 条目（空名清除）。
//
// 不依赖宿主的会话列举接口：SessionManager.listAll 逐行读全文件、异常静默返回空数组，
// 两个缺点规格都点名排除。本扫描自行计算并校验树根，逐文件只读首部与结尾两个定长窗口，
// 结果按「mtime + 字节数」指纹缓存，指纹变化即失效；损坏文件按尽力而为跳过并负缓存，
// 目录级不可读/树根结构异常按扫描失败上抛（进发现状态的 scan-failed，不伪装成空清单）。

import { closeSync, openSync, readdirSync, readSync, statSync, type Stats } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

/** 首部窗口：session 头总在第一行，64KB 远超正常头部尺寸 */
const HEAD_WINDOW_BYTES = 64 * 1024;
/** 结尾窗口：会话名取窗口内最新 session_info；超大文件尾部取不到就留空（规格「名字权威」） */
const TAIL_WINDOW_BYTES = 128 * 1024;

/** 会话文件树根：自行计算，不依赖宿主全局会话列举接口的默认行为 */
export function peersSessionsRoot(agentDir: string): string {
  return join(agentDir, "sessions");
}

/** 项目目录名编码：与宿主一致——去首斜杠后把 / \ : 全替换为 -，两侧包 -- */
export function peersProjectDirName(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** 磁盘层会话条目：一个 .jsonl 会话文件的解析结果 */
export interface PeersDiskSession {
  readonly sessionId: string;
  /** session 头首行的 cwd；缺失或为空串时为 null（不从目录名反推） */
  readonly cwd: string | null;
  readonly sessionFile: string;
  /** 文件修改时间（epoch ms）：排序、截断与缓存失效的依据 */
  readonly modifiedAt: number;
  /** 尽力获取的会话名（结尾窗口内最新 session_info；取不到为 null） */
  readonly name: string | null;
}

/** 单轮扫描的可观测量：缓存与读取字节是「未变更不重解析」「只读头尾」的证据面 */
export interface PeersDiskScanStats {
  /** 遍历到的 .jsonl 文件数 */
  readonly filesSeen: number;
  /** 解析出会话的文件数（含缓存命中） */
  readonly sessionsFound: number;
  /** 实际读文件解析的次数（缓存未命中） */
  readonly filesParsed: number;
  readonly cacheHits: number;
  /** 本次扫描从会话文件实际读出的字节数（首部 + 结尾窗口） */
  readonly bytesRead: number;
}

export interface PeersDiskScanOutput {
  /** 按修改时间倒序；limit 截断后保留最新的 */
  readonly sessions: readonly PeersDiskSession[];
  /** 会话总数超出 limit 时为 true（规格「扫描策略」截断标记） */
  readonly truncated: boolean;
  readonly stats: PeersDiskScanStats;
}

export interface PeersDiskScanner {
  /** 全量扫描会话文件树；同指纹文件复用缓存，树根缺失视为成功空扫描 */
  scan(request?: { readonly limit?: number }): PeersDiskScanOutput;
}

interface SessionHead {
  readonly sessionId: string;
  readonly cwd: string | null;
}

interface CacheRecord {
  readonly mtimeMs: number;
  readonly size: number;
  /** null = 已判定不是 pi 会话（负缓存：损坏文件不反复读取） */
  readonly session: PeersDiskSession | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errnoCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

/** 单文件可忽略的错误：竞争性消失与权限/占用类，尽力而为跳过；
 * 其余（EISDIR/EMFILE/ENFILE/EIO 等系统级故障）上抛进 scan-failed，不伪装成成功空清单 */
const SKIPPABLE_FILE_CODES = new Set(["ENOENT", "ENOTDIR", "EACCES", "EPERM", "EBUSY"]);

function isSkippableFileError(error: unknown): boolean {
  const code = errnoCode(error);
  return code !== undefined && SKIPPABLE_FILE_CODES.has(code);
}

/** 解析一行 JSON：空行与损坏行返回 undefined（尽力而为，跳过继续找） */
function parseEntryLine(line: string): unknown {
  const text = line.trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** 会话头候选：undefined=继续找下一行；null=首条可解析条目不是 session 头（不是 pi 会话） */
function headerCandidate(line: string): SessionHead | null | undefined {
  const entry = parseEntryLine(line);
  if (entry === undefined) return undefined;
  if (!isRecord(entry) || entry.type !== "session" || typeof entry.id !== "string" || entry.id === "") {
    return null;
  }
  const cwd = typeof entry.cwd === "string" && entry.cwd !== "" ? entry.cwd : null;
  return { sessionId: entry.id, cwd };
}

/**
 * 只读首部窗口找 session 头，读满窗口上限即停（长首行/连续损坏行不退化成整文件读取）。
 * 返回 null 表示该文件不是 pi 会话（空文件、损坏或首条可解析条目非 session 头）。
 */
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
    // 只有 EOF 后的末段才能当完整行；读满上限仍未见可解析头则按损坏跳过
    // （合法 session 头必然在首行且远小于窗口）
    return sawEof ? (headerCandidate(pending) ?? null) : null;
  } finally {
    closeSync(fd);
  }
}

/** 结尾窗口内最新的 session_info 条目名（空名条目清除 → null）；窗口截在行中间时丢弃首行 */
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
      if (firstNewline === -1) return null; // 窗口内没有完整行
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
        // agentDir 下还没有 sessions 树（从未开过会话）：一次成功的空扫描，不是失败。
        // 树根消失期间同路径可能被整体重建，清空缓存避免旧记录命中。
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
        // 扫描期间目录消失（清理竞争、悬空链接）属正常churn；其余（不可读等）按扫描失败上抛
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
          if (isSkippableFileError(error)) continue; // 单文件竞争/权限：尽力而为跳过
          throw error;
        }

        // 缓存指纹 = mtime + 字节数（工单口径「修改时间缓存」）：同指纹的内容改写理论上
        // 漏检，属尽力而为语义；文件系统时间戳粒度（NTFS 100ns）下实际窗口极小。
        // 树根消失/结构异常时缓存整体作废（见上方 cache.clear）。

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
          if (head) {
            session = {
              sessionId: head.sessionId,
              cwd: head.cwd,
              sessionFile: filePath,
              modifiedAt: fileStat.mtimeMs,
              name: readSessionName(filePath, fileStat.size, stats),
            };
          }
          cache.set(filePath, { mtimeMs: fileStat.mtimeMs, size: fileStat.size, session });
        } catch (error) {
          if (isSkippableFileError(error)) continue; // 单文件不可读：跳过且不缓存
          throw error;
        }
        if (session) {
          sessions.push(session);
          stats.sessionsFound += 1;
        }
      }
    }

    // 修剪缓存：本轮没见到的文件（已删除/改名）不再占缓存
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
