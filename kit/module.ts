// 模块契约：每个源插件迁入 pi-toolkit 后实现为一个 ModuleDefinition。
// 装配器只负责按 enabled 开关决定是否调用 register；模块自己决定注册哪些命令/工具/钩子。

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SettingItem } from "@earendil-works/pi-tui";
import type { Translator } from "../i18n/index.ts";
import type { ConfigWriteHooks } from "./config-transaction.ts";
import type { MenuTheme } from "./menu/theme.ts";
import type { ServiceRegistry } from "./services.ts";

/** 配置节里的标量取值；schema 字段（菜单控件）只接受标量 */
export type ModuleConfigScalar = string | number | boolean | null;
/**
 * 配置节里能存的值：标量、数组与嵌套对象。
 * 嵌套结构不属于 schema 字段（菜单不渲染），模块在自己的配置解析里读取校验，
 * 例如视觉模块的 `backend.route.allowedModels` / `fixedModel`。
 */
export type ModuleConfigValue =
  | ModuleConfigScalar
  | ModuleConfigValue[]
  | { [key: string]: ModuleConfigValue };
export type ModuleConfigRecord = Record<string, ModuleConfigValue>;

/**
 * 一个配置字段。
 * - default 为 boolean：开/关字段
 * - default 为 string 且带 values：枚举字段（配置里存 values 中的规范化代码）
 * - 枚举值的显示文案从 valueLabelKeys 取；某个值没配键时直接显示该值原文
 *
 * 数值/自由文本字段等后续工单需要时再扩展控件类型，本工单不预置无用分支。
 *
 * 键字段是 string（工单 09 定案）：模块自带键表，跨模块键存在性由运行时
 * hasMessage 与三语完整性测试兜底，模块内的局部 keyof 校验在模块自己的配置里做。
 */
export interface ConfigField {
  default: ModuleConfigScalar;
  values?: readonly string[];
  labelKey: string;
  descriptionKey?: string;
  /** 枚举值 → 显示文案键，必须覆盖 values 里的每一项 */
  valueLabelKeys?: Readonly<Record<string, string>>;
}

export type ModuleConfigSchema = Record<string, ConfigField>;

/** 菜单分组：一级菜单的四个分组标题（工单 46；标题行只做视觉分隔，不响应回车、不参与搜索） */
export type ModuleGroup = "general" | "tui" | "models" | "subagents";
export const MODULE_GROUPS: readonly ModuleGroup[] = ["general", "tui", "models", "subagents"];

/** 模块总开关字段名；每个模块的 schema 必须声明它 */
export const ENABLED_FIELD = "enabled";

export function enabledField(labelKey: string, descriptionKey?: string): ConfigField {
  return { default: true, labelKey, descriptionKey };
}

export function isBooleanField(field: ConfigField): boolean {
  return typeof field.default === "boolean";
}

/** 把外部输入（菜单回传的显示文案、配置文件里的值）规范化成 schema 接受的值；不接受则返回 undefined */
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
  /** 收到 pi API 后自行注册命令、工具与钩子 */
  readonly pi: ExtensionAPI;
  readonly services: ServiceRegistry;
  readonly t: Translator;
  /** 实时读取本模块配置（已合并 schema 默认值） */
  getConfig(): ModuleConfigRecord;
  /**
   * 重新从磁盘读取整份配置文件并刷新状态中枢的内存副本。
   * 模块用自己的配置层写到盘上（如视觉路由）之后，靠它让 getConfig 跟上磁盘。
   */
  reloadConfig(): Promise<void>;
  /**
   * 写入并持久化单个配置字段，返回规范化后的值。
   * 只接受 schema 声明的字段；模块私有的结构化配置（非 schema 键）走 saveConfig。
   */
  setConfig(key: string, value: ModuleConfigScalar): Promise<ModuleConfigScalar>;
  /**
   * 结构化配置写入事务（工单 19）：把本模块配置节的补丁写盘 → 内存重载 → reapply。
   * 只允许从 kit 出去写盘，模块只提供补丁与重生效回调。
   */
  saveConfig(patch: ModuleConfigRecord, hooks?: ConfigWriteHooks): Promise<void>;
}

export interface ModuleMenuContext {
  readonly t: Translator;
  readonly services: ServiceRegistry;
  getConfig(): ModuleConfigRecord;
  /** 打开菜单时的扩展上下文：需要与宿主交互的菜单项（如视觉探测）从这里取 modelRegistry / model / signal */
  readonly context: ExtensionContext;
  /** pi 的配置目录（<agentDir>/pi-toolkit.json 就在它下面）：模块自写盘时用 */
  readonly agentDir: string;
  /** 子菜单自绘面板上色用的主题 */
  readonly theme: MenuTheme;
  /** 异步动作结束后请宿主重绘（pi 的 TUI 是按需渲染） */
  requestRender(): void;
  /**
   * 结构化配置写入事务（工单 19）：补丁 → 落盘 → 内存重载 → reapply → 菜单重绘请求。
   * 重绘请求由菜单层注入，模块只需给出补丁与 reapply。
   */
  saveConfig(patch: ModuleConfigRecord, hooks?: ConfigWriteHooks): Promise<void>;
  /** 顶层统一改动入口（id 与显示文案，工单 46）：共享二级页里 schema 字段行的取值经它落盘 */
  onChange(id: string, value: string): void;
  /**
   * 共享二级页行集合（工单 46）：与本模块同 pageId 的启用模块的行，本模块的行在前。
   * 未声明 pageId 的模块没有这一项。
   */
  pageItems?(): readonly SettingItem[];
}

export interface ModuleDefinition {
  /** 模块 id：同时是配置节名与菜单项 id 前缀 */
  readonly id: string;
  readonly labelKey: string;
  readonly descriptionKey: string;
  readonly group: ModuleGroup;
  /** 配置 schema，必须包含 enabled 字段 */
  readonly configSchema: ModuleConfigSchema;
  /** 仅在模块启用时调用 */
  readonly register: (context: ModuleContext) => void;
  /** 可选：schema 自动生成的行之外，本模块专属的菜单行；同样只在模块启用时渲染 */
  readonly menuItems?: (context: ModuleMenuContext) => readonly SettingItem[];
  /**
   * 共享二级页归属（工单 46）：同 pageId 的启用模块共用一个二级页，
   * 页面入口行由页主模块（提供 topLevel 入口行的模块）的子菜单打开。
   */
  readonly pageId?: string;
  /**
   * 顶层行钩子（工单 46）：模块在一级菜单（所在分组标题下）直接呈现的行。
   * 不提供时按默认规则生成：schema 字段行 + menuItems 的入口行。
   * 提供空数组表示本模块在一级不出现，行全部收进二级页。
   */
  readonly topLevel?: (context: ModuleMenuContext) => readonly SettingItem[];
}

const MODULE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** 装配期校验：schema 写错就当场抛出，不拖到菜单渲染时才炸 */
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
