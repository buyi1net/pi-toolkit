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

export const PEERS_FILES_SUBDIR = "files";

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

export function storePeersLargeContent(agentDir: string, body: string): PeersFileRef {
  const bytes = Buffer.from(body, "utf8");
  const name = randomUUID();
  const dir = peersFilesDir(agentDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

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

export type PeersLargeContentLoad =
  | { readonly ok: true; readonly content: string; readonly bytes: number }
  | { readonly ok: false; readonly reason: "rejected" | "content-too-large"; readonly detail: string };

function refused(detail: string): PeersLargeContentLoad {
  return { ok: false, reason: "rejected", detail };
}

function containedInFilesDir(filesDir: string, resolved: string): boolean {
  const rel = relative(filesDir, resolved);
  if (rel === "") return false;
  if (isAbsolute(rel)) return false;
  return rel.split(sep)[0] !== "..";
}

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
    if (!entry.isFile()) continue;
    const file = join(dir, entry.name);
    try {
      if (now - statSync(file).mtimeMs > ttlMs) unlinkSync(file);
    } catch {
      // 扫描期间竞争消失或被占用：跳过，下一轮重试
    }
  }
}
