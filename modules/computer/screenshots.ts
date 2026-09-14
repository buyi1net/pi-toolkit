// computer 截图基础设施（工单 19）：带图观察的落盘目录、确定性文件名与旧图回收。
//
// 落点与动作日志同一套约定：<agentDir>/pi-computer/screenshots/（log.ts 写 <agentDir>/pi-computer/actions.jsonl）。
// 文件名 <清洗后的 rootKey>-<sha1(rootKey) 前 8 位>--<清洗后的 stateId>.png：
// - 清洗把 [A-Za-z0-9._-] 之外的字符折叠成 -，rootKey 里的 : \ 中文、甚至 "../" 都逃不出截图目录；
// - rootKey 的 hash 防止清洗后撞名（"a:b" 与 "a?b" 都洗成 "a-b"）导致两张图互相覆盖或误回收；
// - stateId 由状态层预先生成（state.ts 的 nextStateId），工具层先命名再 observe，图与快照严格一对一。
//
// 回收策略：本次采集先删同根旧图（保留 keepPath），再按目录总量上限淘汰最旧的 *.png。
// 全部 best-effort——目录不存在、条目读不到、文件删不掉都不抛：留旧图只是占盘，
// 不能反过来让一次采集失败（失败会让模型丢掉整个观察，代价远大于多留几张旧图）。

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { computerStateDir } from "./log.ts";

/** 截图落盘设置：装配层注入（工单 19）；工具层不自己取 agentDir，测试才能把图落到临时目录 */
export interface ComputerScreenshotSettings {
  readonly dir: string;
  readonly limitBytes: number;
}

/** 截图落点：<agentDir>/pi-computer/screenshots/（与动作日志同一套约定，见 log.ts 的 computerStateDir） */
export function computerScreenshotDir(agentDir: string): string {
  return join(computerStateDir(agentDir), "screenshots");
}

/**
 * 建好截图目录（含中间层级）。与 sweep 的容错语义不同：这里失败必须抛给调用方——
 * 采集前目录建不出来，后面原生层写 PNG 一定失败，早报错比透传 write_failed 更准确。
 */
export function ensureScreenshotDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/** 截图目录总量上限：超过就按 mtime 淘汰最旧的图，防止长期会话把盘写满 */
export const COMPUTER_SCREENSHOT_DIR_LIMIT_BYTES = 128 * 1024 * 1024;

/** 文件名里 rootKey 的 sha1 截断长度（hex 位数）：实现与测试共用，改长度只需改这一处 */
export const SCREENSHOT_STEM_HASH_LENGTH = 8;

/** 清洗后片段的最大长度：再长也只会给文件名添麻烦 */
const SEGMENT_MAX_LENGTH = 40;
/** 清洗后什么都不剩时的回落片段 */
const SEGMENT_FALLBACK = "root";

/**
 * 截图文件名前缀：<清洗后的 rootKey>-<sha1(rootKey) 前 8 位 hex>。
 * 同 rootKey 稳定；不同 rootKey 即便清洗后同名，也因 hash 不同而分开。
 */
export function screenshotStem(rootKey: string): string {
  const digest = createHash("sha1").update(rootKey).digest("hex").slice(0, SCREENSHOT_STEM_HASH_LENGTH);
  return `${sanitizeSegment(rootKey)}-${digest}`;
}

/** 截图文件名：<stem>--<清洗后的 stateId>.png；stateId 按同一规则清洗，防意外字符逃出目录 */
export function screenshotFileName(rootKey: string, stateId: string): string {
  return `${screenshotStem(rootKey)}--${sanitizeSegment(stateId)}.png`;
}

/**
 * 回收截图，best-effort（任何一步失败都不抛）：
 * 1. 同根回收：删掉目录里所有 `<rootKey 的 stem>--*.png`，但保留 keepPath（本次刚写好的图）；
 * 2. 总量淘汰：统计目录里全部 `*.png`（keepPath 计入总量），超过 limitBytes 就按 mtime 从旧到新删，
 *    直到总量达标；keepPath 永不入选淘汰候选，宁可暂时超限也不删刚采的图。
 * 收 rootKey 而不是现成的 stem：前缀只在本函数里派生一次，调用点没机会把两处算岔。
 */
export function sweepScreenshots(dir: string, rootKey: string, keepPath: string, limitBytes: number): void {
  // 第一步：同根旧图下线，只留本次的图
  const sameStemPrefix = `${screenshotStem(rootKey)}--`;
  for (const entry of listEntries(dir)) {
    if (!entry.isFile || !entry.name.endsWith(".png") || !entry.name.startsWith(sameStemPrefix)) continue;
    if (isKeepPath(entry.path, keepPath)) continue;
    removeScreenshot(entry.path);
  }

  // 第二步：重新读目录再算总量，同根回收已删掉的文件不再计入
  const shots = listEntries(dir).filter((entry) => entry.isFile && entry.name.endsWith(".png"));
  let total = shots.reduce((sum, entry) => sum + entry.size, 0);
  if (total <= limitBytes) return;
  const candidates = shots
    .filter((entry) => !isKeepPath(entry.path, keepPath))
    .sort((left, right) => left.mtimeMs - right.mtimeMs);
  for (const candidate of candidates) {
    if (total <= limitBytes) break;
    // 删成功才减账：删不掉就留给下一轮，不假装账已平
    if (removeScreenshot(candidate.path)) total -= candidate.size;
  }
}

/** 删掉单张截图，best-effort；采集失败后清理刚落盘的文件用，返回是否删成 */
export function removeScreenshot(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

interface DirEntryInfo {
  readonly name: string;
  readonly path: string;
  readonly isFile: boolean;
  readonly size: number;
  readonly mtimeMs: number;
}

/** 读目录并逐个 stat；目录不存在/读不到、条目在读取间隙被删掉都只是跳过，交给调用方当没这张图 */
function listEntries(dir: string): readonly DirEntryInfo[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    // 目录不存在、权限不够、路径不是目录：没有可回收的旧图，不抛也不顺手建目录
    return [];
  }
  const entries: DirEntryInfo[] = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      const info = statSync(path);
      entries.push({ name, path, isFile: info.isFile(), size: info.size, mtimeMs: info.mtimeMs });
    } catch {
      // 竞态：readdir 列到之后文件被删/移走；坏条目不能打断整轮回收
      continue;
    }
  }
  return entries;
}

/** 两张路径指向同一文件：解析成绝对路径再比，避免 dir 与 keepPath 写法不同导致误删刚采的图 */
function isKeepPath(path: string, keepPath: string): boolean {
  return resolve(path) === resolve(keepPath);
}

/** 清洗成安全文件名片段：合法字符原样保留，其余折叠成一个 -，去首尾 -，截断到 40 字符，空串回落 root */
function sanitizeSegment(raw: string): string {
  const cleaned = raw
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SEGMENT_MAX_LENGTH)
    // 截断可能正好切在 - 上，再收一次尾
    .replace(/^-+|-+$/g, "");
  return cleaned === "" ? SEGMENT_FALLBACK : cleaned;
}
