import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SettingItem } from "@earendil-works/pi-tui";
import type { Translator } from "../i18n/index.ts";
import type { ConfigWriteHooks } from "./config-transaction.ts";
import type { MenuTheme } from "./menu/theme.ts";
import type { ServiceRegistry } from "./services.ts";

export type ModuleConfigScalar = string | number | boolean | null;

export type ModuleConfigValue =
  | ModuleConfigScalar
  | ModuleConfigValue[]
  | { [key: string]: ModuleConfigValue };
export type ModuleConfigRecord = Record<string, ModuleConfigValue>;

export interface ConfigField {
  default: ModuleConfigScalar;
  values?: readonly string[];
  labelKey: string;
  descriptionKey?: string;

  valueLabelKeys?: Readonly<Record<string, string>>;
}

export type ModuleConfigSchema = Record<string, ConfigField>;

export type ModuleGroup = "general" | "tui" | "models" | "subagents";
export const MODULE_GROUPS: readonly ModuleGroup[] = ["general", "tui", "models", "subagents"];

export const ENABLED_FIELD = "enabled";

export function enabledField(labelKey: string, descriptionKey?: string): ConfigField {
  return { default: true, labelKey, descriptionKey };
}

export function isBooleanField(field: ConfigField): boolean {
  return typeof field.default === "boolean";
}

export function normalizeConfigValue(field: ConfigField, value: unknown): ModuleConfigScalar | undefined {
  if (typeof field.default === "boolean") {
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
    return undefined;
  }
  if (typeof field.default === "number") {
    if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
  }
  if (typeof value !== "string") return undefined;
  if (field.values && !field.values.includes(value)) return undefined;
  return value;
}

export interface ModuleContext {
  readonly moduleId: string;

  readonly pi: ExtensionAPI;
  readonly services: ServiceRegistry;
  readonly t: Translator;

  getConfig(): ModuleConfigRecord;

  reloadConfig(): Promise<void>;

  setConfig(key: string, value: ModuleConfigScalar): Promise<ModuleConfigScalar>;

  saveConfig(patch: ModuleConfigRecord, hooks?: ConfigWriteHooks): Promise<void>;
}

export interface RowChangeEntry {

  read(): string;

  change(label: string): Promise<boolean>;
}

export interface ModuleMenuContext {
  readonly t: Translator;
  readonly services: ServiceRegistry;
  getConfig(): ModuleConfigRecord;

  readonly context: ExtensionContext;

  readonly agentDir: string;

  readonly theme: MenuTheme;

  requestRender(): void;

  saveConfig(patch: ModuleConfigRecord, hooks?: ConfigWriteHooks): Promise<void>;

  onChange(id: string, value: string): void;

  registerRowChange(id: string, entry: RowChangeEntry): void;

  pageItems?(): readonly SettingItem[];
}

export interface ModuleDefinition {

  readonly id: string;
  readonly labelKey: string;
  readonly descriptionKey: string;
  readonly group: ModuleGroup;

  readonly configSchema: ModuleConfigSchema;

  readonly alwaysAssemble?: boolean;

  readonly register: (context: ModuleContext) => void;

  readonly menuItems?: (context: ModuleMenuContext) => readonly SettingItem[];

  readonly pageId?: string;

  readonly topLevel?: (context: ModuleMenuContext) => readonly SettingItem[];
}

const MODULE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export function assertModuleDefinition(definition: ModuleDefinition): void {
  if (!MODULE_ID_PATTERN.test(definition.id)) {
    throw new Error(`模块 id 不合法：${JSON.stringify(definition.id)}`);
  }
  if (!MODULE_GROUPS.includes(definition.group)) {
    throw new Error(`模块 ${definition.id} 的菜单分组不合法：${String(definition.group)}`);
  }
  if (definition.topLevel !== undefined && typeof definition.topLevel !== "function") {
    throw new Error(`模块 ${definition.id} 的 topLevel 必须是函数`);
  }
  if (definition.pageId !== undefined && (typeof definition.pageId !== "string" || definition.pageId === "")) {
    throw new Error(`模块 ${definition.id} 的 pageId 必须是非空字符串`);
  }
  if (definition.alwaysAssemble !== undefined && typeof definition.alwaysAssemble !== "boolean") {
    throw new Error(`模块 ${definition.id} 的 alwaysAssemble 必须是布尔值`);
  }
  const enabled = definition.configSchema[ENABLED_FIELD];
  if (!enabled || !isBooleanField(enabled)) {
    throw new Error(`模块 ${definition.id} 的 schema 必须包含 enabled 开/关字段`);
  }
  for (const [key, field] of Object.entries(definition.configSchema)) {
    if (isBooleanField(field)) continue;
    if (!field.values || field.values.length === 0) {
      throw new Error(`模块 ${definition.id} 的字段 ${key} 需要 values 才能生成菜单控件`);
    }
    if (field.values.length !== new Set(field.values).size) {
      throw new Error(`模块 ${definition.id} 的字段 ${key} 含重复 values`);
    }
    if (field.valueLabelKeys) {
      for (const value of field.values) {
        if (!field.valueLabelKeys[value]) {
          throw new Error(`模块 ${definition.id} 的字段 ${key} 缺少取值 ${value} 的显示文案键`);
        }
      }
    }
  }
}
