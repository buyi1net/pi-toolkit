import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface RuntimeStamp {
  readonly version: string;
  readonly entryMtimeMs: number;
  readonly entrySize: number;
}

const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url));

export const PACKAGE_ROOT = resolve(SUBAGENTS_DIR, "..", "..");

export function readRuntimeStamp(root: string = PACKAGE_ROOT): RuntimeStamp | null {
  try {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown };
    const stat = statSync(join(root, "index.ts"));
    return {
      version: typeof manifest.version === "string" ? manifest.version : "unknown",
      entryMtimeMs: Math.round(stat.mtimeMs),
      entrySize: stat.size,
    };
  } catch {
    return null;
  }
}

export function runtimeStampsDiffer(loaded: RuntimeStamp | null, current: RuntimeStamp | null): boolean {
  if (loaded === null || current === null) return false;
  return loaded.entryMtimeMs !== current.entryMtimeMs || loaded.entrySize !== current.entrySize;
}
