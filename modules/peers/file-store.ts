// peers 大内容文件通道（工单 40）：超过阈值的消息正文落共享区文件、接收端注入前
// 校验读取、按存活期（TTL）清理。
//
// 契约（规格「大内容文件契约」）：
// - 只写专用共享目录 peersSharedDir(agentDir) 下的 files 子目录，随机命名（randomUUID），
//   临时文件 + rename 原子落盘，目录 0700 / 文件 0600 限定当前用户（POSIX 语义；
//   Windows 无强制权限位，实际依赖用户 profile 目录的 ACL，与 registry.ts 同口径）；
// - sha256 必填：哈希与字节数取实际写入的字节（不是发送方声明的正文长度）；
// - 帧 file.path 语义：相对 peersSharedDir(agentDir) 的相对路径（不是相对 cwd），
//   线上统一写 `files/<name>` 正斜杠写法，接收端按同一语义解析；
// - 接收端注入前做 containment 校验（解析后必须位于 files 目录之内；拒绝绝对路径与
//   .. 越界）与完整性校验（大小、sha256）；任何失败返回拒绝结果，由调用方决定回执与
//   诊断——本模块只产出原因，不碰端点与诊断通道；
// - 清理只扫 files 目录、按 mtime 超过存活期删常规文件；目录不存在与单条失败都不抛错
//   （幂等，可挂到心跳 tick 上重复执行），不跨出 files 目录。

import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Dirent,
  type Stats,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { peersSharedDir } from "./api.ts";
import type { PeersFileRef } from "./protocol.ts";

/** 大内容文件子目录名（相对 peersSharedDir） */
export const PEERS_FILES_SUBDIR = "files";

/** 大内容文件目录：共享区下的 files 子目录（唯一落点） */
export function peersFilesDir(agentDir: string): string {
  return join(peersSharedDir(agentDir), PEERS_FILES_SUBDIR);
}

function errnoCode(error: unknown): string | undefined {
  return typeof (error as { code?: unknown } | null)?.code === "string"
    ? (error as { code: string }).code
    : undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 发送侧转文件：正文按 UTF-8 编码后原子落盘，返回帧引用（相对路径 + 实际字节数 +
 * 实际字节的 sha256）。失败（磁盘满、权限等）抛出，由调用方折成投递失败。
 */
export function storePeersLargeContent(agentDir: string, body: string): PeersFileRef {
  const bytes = Buffer.from(body, "utf8");
  const name = randomUUID();
  const dir = peersFilesDir(agentDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // 临时文件与目标同目录，保证 rename 是同卷原子替换（与 writePeerRegistration 同款写法）
  const tempFile = join(dir, `.${name}.${process.pid}.tmp`);
  const target = join(dir, name);
  try {
    writeFileSync(tempFile, bytes, { mode: 0o600 });
    renameSync(tempFile, target);
  } catch (error) {
    try {
      unlinkSync(tempFile);
    } catch {
      // 临时文件清理尽力而为，保留原写入失败
    }
    throw error;
  }
  return {
    path: `${PEERS_FILES_SUBDIR}/${name}`,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/** 接收端读取结果：成功（正文 + 实际字节数）或拒绝（原因码 + 失败类型说明） */
export type PeersLargeContentLoad =
  | { readonly ok: true; readonly content: string; readonly bytes: number }
  | { readonly ok: false; readonly reason: "rejected" | "content-too-large"; readonly detail: string };

function refused(detail: string): PeersLargeContentLoad {
  return { ok: false, reason: "rejected", detail };
}

/** containment：解析结果必须严格位于 files 目录之内（不能是 files 目录本身）。
 * 相对路径首段是 .. 即越界；isAbsolute 覆盖 Windows 跨盘符。大小写按平台语义
 * （path.relative 在 win32 上大小写不敏感、在 POSIX 上敏感）。 */
function containedInFilesDir(filesDir: string, resolved: string): boolean {
  const rel = relative(filesDir, resolved);
  if (rel === "") return false;
  if (isAbsolute(rel)) return false;
  return rel.split(sep)[0] !== "..";
}

/**
 * 接收端校验并读取大内容文件：绝对路径与 .. 越界先拒（报错比纯 containment 更直接），
 * 再做 containment、常规文件、大小与 sha256 校验。声明或实际字节数超过读取上限返回
 * content-too-large（不读入内存）；其余失败（缺失 / 非常规文件 / 大小不符 / 读取失败 /
 * 哈希不符）返回 rejected，detail 写明失败类型。
 */
export function loadPeersLargeContent(
  agentDir: string,
  ref: PeersFileRef,
  limits: { readonly maxInboundContentBytes: number },
): PeersLargeContentLoad {
  if (isAbsolute(ref.path)) {
    return refused(`引用了绝对路径 ${JSON.stringify(ref.path)}，只允许 files 目录内的相对路径`);
  }
  if (ref.path.split(/[\\/]+/).includes("..")) {
    return refused(`路径 ${JSON.stringify(ref.path)} 含 .. 越界成分`);
  }
  const resolved = resolve(peersSharedDir(agentDir), ref.path);
  if (!containedInFilesDir(peersFilesDir(agentDir), resolved)) {
    return refused(`路径 ${JSON.stringify(ref.path)} 解析后不在 files 目录内`);
  }
  if (ref.bytes > limits.maxInboundContentBytes) {
    return {
      ok: false,
      reason: "content-too-large",
      detail: `声明 ${ref.bytes} 字节超过读取上限 ${limits.maxInboundContentBytes} 字节`,
    };
  }
  let info: Stats;
  try {
    info = statSync(resolved);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return refused(`文件缺失（${ref.path}）`);
    return refused(`读取失败（${describeError(error)}）`);
  }
  if (!info.isFile()) return refused(`非常规文件（${ref.path}）`);
  if (info.size !== ref.bytes) {
    return refused(`大小不符：声明 ${ref.bytes} 字节，实际 ${info.size} 字节`);
  }
  if (info.size > limits.maxInboundContentBytes) {
    return {
      ok: false,
      reason: "content-too-large",
      detail: `实际 ${info.size} 字节超过读取上限 ${limits.maxInboundContentBytes} 字节`,
    };
  }
  let raw: Buffer;
  try {
    raw = readFileSync(resolved);
  } catch (error) {
    return refused(`读取失败（${describeError(error)}）`);
  }
  const actual = createHash("sha256").update(raw).digest("hex");
  if (actual !== ref.sha256) {
    return refused(`sha256 不符：声明 ${ref.sha256}，实际 ${actual}`);
  }
  return { ok: true, content: raw.toString("utf8"), bytes: raw.length };
}

/**
 * 按存活期清理大内容文件（幂等）：只扫 files 目录，mtime 年龄超过 ttlMs 的常规文件
 * 删除，其余不动。目录不存在（还没建过）或被占用（ENOENT / ENOTDIR）静默返回；
 * 单条删除/读信息失败跳过（下一轮重试）；其它目录级错误上抛，由挂接方上报诊断。
 */
export function cleanupPeersExpiredFiles(agentDir: string, ttlMs: number, now: number): void {
  const dir = peersFilesDir(agentDir);
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue; // 子目录与特殊文件不动（清理不得跨出常规文件面）
    const file = join(dir, entry.name);
    try {
      if (now - statSync(file).mtimeMs > ttlMs) unlinkSync(file);
    } catch {
      // 扫描期间竞争消失或被占用：跳过，下一轮重试
    }
  }
}
