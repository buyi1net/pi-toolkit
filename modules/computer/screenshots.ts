import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { computerStateDir } from "./log.ts";

export interface ComputerScreenshotSettings {
  readonly dir: string;
  readonly limitBytes: number;
}

export function computerScreenshotDir(agentDir: string): string {
  return join(computerStateDir(agentDir), "screenshots");
}

export function ensureScreenshotDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export const COMPUTER_SCREENSHOT_DIR_LIMIT_BYTES = 128 * 1024 * 1024;

export const SCREENSHOT_STEM_HASH_LENGTH = 8;

const SEGMENT_MAX_LENGTH = 40;

const SEGMENT_FALLBACK = "root";

export function screenshotStem(rootKey: string): string {
  const digest = createHash("sha1").update(rootKey).digest("hex").slice(0, SCREENSHOT_STEM_HASH_LENGTH);
  return `${sanitizeSegment(rootKey)}-${digest}`;
}

export function screenshotFileName(rootKey: string, stateId: string): string {
  return `${screenshotStem(rootKey)}--${sanitizeSegment(stateId)}.png`;
}

export function sweepScreenshots(dir: string, rootKey: string, keepPath: string, limitBytes: number): void {

  const sameStemPrefix = `${screenshotStem(rootKey)}--`;
  for (const entry of listEntries(dir)) {
    if (!entry.isFile || !entry.name.endsWith(".png") || !entry.name.startsWith(sameStemPrefix)) continue;
    if (isKeepPath(entry.path, keepPath)) continue;
    removeScreenshot(entry.path);
  }

  const shots = listEntries(dir).filter((entry) => entry.isFile && entry.name.endsWith(".png"));
  let total = shots.reduce((sum, entry) => sum + entry.size, 0);
  if (total <= limitBytes) return;
  const candidates = shots
    .filter((entry) => !isKeepPath(entry.path, keepPath))
    .sort((left, right) => left.mtimeMs - right.mtimeMs);
  for (const candidate of candidates) {
    if (total <= limitBytes) break;

    if (removeScreenshot(candidate.path)) total -= candidate.size;
  }
}

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

function listEntries(dir: string): readonly DirEntryInfo[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {

    return [];
  }
  const entries: DirEntryInfo[] = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      const info = statSync(path);
      entries.push({ name, path, isFile: info.isFile(), size: info.size, mtimeMs: info.mtimeMs });
    } catch {

      continue;
    }
  }
  return entries;
}

function isKeepPath(path: string, keepPath: string): boolean {
  return resolve(path) === resolve(keepPath);
}

function sanitizeSegment(raw: string): string {
  const cleaned = raw
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SEGMENT_MAX_LENGTH)
    // 截断可能正好切在 - 上，再收一次尾
    .replace(/^-+|-+$/g, "");
  return cleaned === "" ? SEGMENT_FALLBACK : cleaned;
}
