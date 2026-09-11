// pi-toolkit 统一配置文件：<agentDir>/pi-toolkit.json
// 结构：schemaVersion + language + 各模块配置节。
// 写盘沿用 pi-eyes 的安全行为：剥掉敏感键、0600 权限、临时文件 + rename 原子替换。

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isLanguageSetting, type LanguageSetting } from "./i18n.ts";
import type { ModuleConfigRecord, ModuleConfigValue } from "./module.ts";

export const TOOLKIT_CONFIG_FILENAME = "pi-toolkit.json";
export const TOOLKIT_SCHEMA_VERSION = 1;

export interface ToolkitConfig {
  readonly schemaVersion: number;
  readonly language: LanguageSetting;
  /** 模块 id → 该模块的配置节（未经 schema 校验的原始值） */
  readonly modules: Readonly<Record<string, ModuleConfigRecord>>;
}

export interface ToolkitConfigUpdate {
  readonly language?: LanguageSetting;
  readonly modules?: Readonly<Record<string, ModuleConfigRecord>>;
}

export interface LoadedToolkitConfig {
  readonly config: ToolkitConfig;
  /** 文件缺失不算问题；解析异常、取值非法逐条记录，交给菜单展示 */
  readonly problems: readonly string[];
}

export const DEFAULT_TOOLKIT_CONFIG: ToolkitConfig = {
  schemaVersion: TOOLKIT_SCHEMA_VERSION,
  language: "auto",
  modules: {},
};

export function getToolkitConfigPath(agentDir: string): string {
  return join(agentDir, TOOLKIT_CONFIG_FILENAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 配置节可存的值：标量、标量数组，或嵌套的对象/数组（模块私有结构） */
function isConfigValue(value: unknown): value is ModuleConfigValue {
  if (value === null) return true;
  const type = typeof value;
  if (type === "string" || type === "number" || type === "boolean") return true;
  if (Array.isArray(value)) return value.every(isConfigValue);
  if (isRecord(value)) return Object.values(value).every(isConfigValue);
  return false;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function parseToolkitConfig(raw: Record<string, unknown>, source: string, problems: string[]): ToolkitConfig {
  const version = typeof raw.schemaVersion === "number" ? raw.schemaVersion : TOOLKIT_SCHEMA_VERSION;
  if (version > TOOLKIT_SCHEMA_VERSION) {
    problems.push(`${source}: schemaVersion ${version} 高于当前支持的 ${TOOLKIT_SCHEMA_VERSION}，未识别的内容会原样保留`);
  }

  let language: LanguageSetting = "auto";
  if (raw.language !== undefined) {
    if (isLanguageSetting(raw.language)) {
      language = raw.language;
    } else {
      problems.push(`${source}: language 取值无效，已回退为 auto`);
    }
  }

  const modules: Record<string, ModuleConfigRecord> = {};
  if (raw.modules !== undefined && !isRecord(raw.modules)) {
    problems.push(`${source}: modules 不是对象，已忽略`);
  } else if (isRecord(raw.modules)) {
    for (const [moduleId, section] of Object.entries(raw.modules)) {
      if (!isRecord(section)) {
        problems.push(`${source}: 模块 ${moduleId} 的配置节不是对象，已忽略`);
        continue;
      }
      const record: ModuleConfigRecord = {};
      for (const [key, value] of Object.entries(section)) {
        if (isConfigValue(value)) {
          record[key] = value;
        } else {
          problems.push(`${source}: 模块 ${moduleId} 的字段 ${key} 取值类型不受支持，已忽略`);
        }
      }
      modules[moduleId] = record;
    }
  }

  return { schemaVersion: TOOLKIT_SCHEMA_VERSION, language, modules };
}

export async function loadToolkitConfig(path: string): Promise<LoadedToolkitConfig> {
  const problems: string[] = [];
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      problems.push(`${path}: 读取失败（${describeError(error)}），本次使用默认配置`);
    }
    return { config: DEFAULT_TOOLKIT_CONFIG, problems };
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) {
      problems.push(`${path}: 顶层不是对象，本次使用默认配置`);
      return { config: DEFAULT_TOOLKIT_CONFIG, problems };
    }
    return { config: parseToolkitConfig(parsed, path, problems), problems };
  } catch (error) {
    problems.push(`${path}: 解析失败（${describeError(error)}），本次使用默认配置`);
    return { config: DEFAULT_TOOLKIT_CONFIG, problems };
  }
}

function sensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    normalized === "auth" ||
    normalized === "authorization" ||
    normalized === "headers" ||
    normalized.includes("apikey") ||
    normalized.includes("token") ||
    normalized.includes("secret") ||
    normalized.includes("password") ||
    normalized.includes("credential")
  );
}

function sanitizeForWrite(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeForWrite);
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!sensitiveKey(key) && entry !== undefined) result[key] = sanitizeForWrite(entry);
  }
  return result;
}

function mergeRaw(base: Record<string, unknown>, update: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(update)) {
    if (value === undefined) continue;
    const current = result[key];
    result[key] = isRecord(current) && isRecord(value) ? mergeRaw(current, value) : value;
  }
  return result;
}

async function atomicWrite(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(temp, text, { encoding: "utf8", mode: 0o600 });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

async function readRaw(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function toRawUpdate(update: ToolkitConfigUpdate): Record<string, unknown> {
  return {
    ...(update.language !== undefined ? { language: update.language } : {}),
    ...(update.modules !== undefined ? { modules: update.modules } : {}),
  };
}

/**
 * 合并写入：保留磁盘上未识别的键（合并进现有内容），剥掉敏感键后原子替换。
 * 覆盖前把上一版内容留一份 `<path>.bak`。
 */
export async function saveToolkitConfig(path: string, update: ToolkitConfigUpdate): Promise<ToolkitConfig> {
  const existing = await readRaw(path);
  const cleanExisting = existing ? (sanitizeForWrite(existing) as Record<string, unknown>) : {};
  const merged = mergeRaw(cleanExisting, toRawUpdate(update));
  merged.schemaVersion = TOOLKIT_SCHEMA_VERSION;

  const config = parseToolkitConfig(merged, path, []);
  if (existing) {
    await atomicWrite(`${path}.bak`, `${JSON.stringify(cleanExisting, null, 2)}\n`);
  }
  await atomicWrite(path, `${JSON.stringify(merged, null, 2)}\n`);
  return config;
}
