import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isLanguageSetting, type LanguageSetting } from "../i18n/index.ts";
import type { ModuleConfigRecord, ModuleConfigValue } from "./module.ts";

export const TOOLKIT_CONFIG_FILENAME = "pi-toolkit.json";

export const TOOLKIT_SCHEMA_VERSION = 2;

export interface ToolkitConfig {
  readonly schemaVersion: number;
  readonly language: LanguageSetting;

  readonly modules: Readonly<Record<string, ModuleConfigRecord>>;
}

export interface ToolkitConfigUpdate {
  readonly language?: LanguageSetting;
  readonly modules?: Readonly<Record<string, ModuleConfigRecord>>;
}

export interface LoadedToolkitConfig {
  readonly config: ToolkitConfig;

  readonly problems: readonly string[];

  readonly migrated: boolean;
}

export interface ParsedToolkitConfig {
  readonly config: ToolkitConfig;

  readonly migrated: boolean;
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

export function parseToolkitConfig(
  raw: Record<string, unknown>,
  source: string,
  problems: string[],
): ParsedToolkitConfig {
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

  const migrated = migrateLegacySections(modules);

  return { config: { schemaVersion: TOOLKIT_SCHEMA_VERSION, language, modules }, migrated };
}

export interface LoadToolkitConfigOptions {

  readonly writeBackLegacyMigration?: boolean;
}

export async function loadToolkitConfig(
  path: string,
  options: LoadToolkitConfigOptions = {},
): Promise<LoadedToolkitConfig> {
  const problems: string[] = [];
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      problems.push(`${path}: 读取失败（${describeError(error)}），本次使用默认配置`);
    }
    return { config: DEFAULT_TOOLKIT_CONFIG, problems, migrated: false };
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) {
      problems.push(`${path}: 顶层不是对象，本次使用默认配置`);
      return { config: DEFAULT_TOOLKIT_CONFIG, problems, migrated: false };
    }
    const result = parseToolkitConfig(parsed, path, problems);
    if (result.migrated && options.writeBackLegacyMigration !== false) {

      try {
        await saveToolkitConfig(path, { language: result.config.language, modules: result.config.modules });
      } catch (error) {
        problems.push(`${path}: 旧配置迁移写回失败（${describeError(error)}），本次仍按迁移后的取值工作`);
      }
    }
    return { config: result.config, problems, migrated: result.migrated };
  } catch (error) {
    problems.push(`${path}: 解析失败（${describeError(error)}），本次使用默认配置`);
    return { config: DEFAULT_TOOLKIT_CONFIG, problems, migrated: false };
  }
}

function migrateLegacySections(modules: Record<string, unknown>): boolean {
  let migrated = false;

  const eyes = modules.eyes;
  if (isRecord(eyes)) {
    const target = modules.vision;
    const vision: Record<string, unknown> = isRecord(target) ? target : (modules.vision = {});
    for (const [key, value] of Object.entries(eyes)) {
      if (vision[key] === undefined) vision[key] = value;
    }
    delete modules.eyes;
    migrated = true;
  }

  const tui = modules.tui;
  if (isRecord(tui)) {
    if (moveLegacySubsection(modules, tui, "data", {
      providerRefreshMs: ["providers", "refreshMs"],
      providerAccess: ["providers", "providerAccess"],
      telemetry: ["status", "telemetry"],
    })) migrated = true;
    if (moveLegacySubsection(modules, tui, "status", {
      preset: ["status", "preset"],
      segments: ["status", "segments"],
    })) migrated = true;
  }

  return migrated;
}

function moveLegacySubsection(
  modules: Record<string, unknown>,
  parent: Record<string, unknown>,
  subsection: string,
  moves: Readonly<Record<string, readonly [string, string]>>,
): boolean {
  const legacy = parent[subsection];
  if (!isRecord(legacy)) return false;
  let moved = false;
  for (const [oldKey, [targetId, newKey]] of Object.entries(moves)) {
    if (!(oldKey in legacy)) continue;
    const existing = modules[targetId];
    const target: Record<string, unknown> = isRecord(existing) ? existing : (modules[targetId] = {});
    if (target[newKey] === undefined) target[newKey] = legacy[oldKey];
    delete legacy[oldKey];
    moved = true;
  }
  if (!moved) return false;
  if (Object.keys(legacy).length === 0) delete parent[subsection];
  return true;
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

export async function saveToolkitConfig(path: string, update: ToolkitConfigUpdate): Promise<ToolkitConfig> {
  const existing = await readRaw(path);
  const cleanExisting = existing ? (sanitizeForWrite(existing) as Record<string, unknown>) : {};
  const merged = mergeRaw(cleanExisting, toRawUpdate(update));

  const mergedModules = merged.modules;
  if (isRecord(mergedModules)) migrateLegacySections(mergedModules);
  merged.schemaVersion = TOOLKIT_SCHEMA_VERSION;

  const { config } = parseToolkitConfig(merged, path, []);
  if (existing) {
    await atomicWrite(`${path}.bak`, `${JSON.stringify(cleanExisting, null, 2)}\n`);
  }
  await atomicWrite(path, `${JSON.stringify(merged, null, 2)}\n`);
  return config;
}
