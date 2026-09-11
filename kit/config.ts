// pi-toolkit 统一配置文件：<agentDir>/pi-toolkit.json
// 结构：schemaVersion + language + 各模块配置节。
// 写盘沿用 pi-eyes 的安全行为：剥掉敏感键、0600 权限、临时文件 + rename 原子替换。

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isLanguageSetting, type LanguageSetting } from "../i18n/index.ts";
import type { ModuleConfigRecord, ModuleConfigValue } from "./module.ts";

export const TOOLKIT_CONFIG_FILENAME = "pi-toolkit.json";
/**
 * 配置结构版本。工单 07 定案 4：三组旧键迁移一次落地，1 升 2。
 * 迁移在 load 时执行（见 migrateLegacySections）：读到旧节就转换并写回，读不到旧节不写盘。
 */
export const TOOLKIT_SCHEMA_VERSION = 2;

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
  /** 本次读取是否把旧节迁移成了新节（写回已在 load 内完成，这里供调用方与自测观察） */
  readonly migrated: boolean;
}

export interface ParsedToolkitConfig {
  readonly config: ToolkitConfig;
  /** 本次解析是否搬动过旧节（true = 旧键还在输入对象里，读盘方应当写回清理） */
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
  /**
   * 读到旧节时是否把迁移结果写回磁盘（默认 true：全局配置由本扩展自己维护）。
   * 项目层配置（`<cwd>/.pi/pi-toolkit.json`）按约定只读，那里传 false：只做内存迁移、不碰文件。
   */
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
      // 定案 4：旧节在 load 时写回（mergeRaw 保未知键语义的例外在 saveToolkitConfig 里收口）。
      // 写不进去也不改变本次生效取值，只补一条问题；下一次带旧节的读取会再试。
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

/**
 * 旧键迁移（工单 07 定案 4：TOOLKIT_SCHEMA_VERSION 1→2，三组一次迁移）。
 *
 * - 旧 `modules.eyes` → `modules.vision`（工单 12：eyes 正名，已安装用户配置不丢）
 * - tui 节 `data.providerRefreshMs` → `modules.providers.refreshMs`（工单 10 拆出的模块键，
 *   键名取模块实际读取的 `refreshMs`，否则旧值搬过去也不生效）
 * - tui 节 `data.providerAccess` → `modules.providers.providerAccess`（原值原样保留）
 * - tui 节 `data.telemetry` → `modules.status.telemetry`（工单 11 自定案：遥测归 status）
 * - tui 节 `status.preset` / `status.segments` → `modules.status.*`（工单 11）
 *
 * 规则：目标键已存在时保留新值，旧键一律删除；旧子节搬空即删除，仍有未知键时保留子节本身
 * （不替用户丢数据）。返回是否真的搬动过——没读到旧节时调用方不产生写入。
 * 判定按字段而非 schemaVersion：老文件缺版本号时同样能读旧配置。
 */
function migrateLegacySections(modules: Record<string, unknown>): boolean {
  let migrated = false;

  // ① eyes → vision：整节搬移
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

  // ②③ tui 节里的旧子节 → providers / status 模块节
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

/** 把一个旧子节里的字段按映射搬进目标模块节（目标键已存在则保留新值），旧字段删除 */
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

/**
 * 合并写入：保留磁盘上未识别的键（合并进现有内容），剥掉敏感键后原子替换。
 * 覆盖前把上一版内容留一份 `<path>.bak`。
 */
export async function saveToolkitConfig(path: string, update: ToolkitConfigUpdate): Promise<ToolkitConfig> {
  const existing = await readRaw(path);
  const cleanExisting = existing ? (sanitizeForWrite(existing) as Record<string, unknown>) : {};
  const merged = mergeRaw(cleanExisting, toRawUpdate(update));
  // 写入前也做一次旧节迁移：mergeRaw 保未知键，会把盘上的旧键一并留下，
  // 这里按定案 4 开例外——旧键先搬进新节再从写入内容里删除。
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
