// 菜单行构造：一级菜单（问题行 + 各模块顶层行，按 MODULE_GROUPS 顺序排列）与共享二级页内容（模块行集合）。
// 设计约定：SettingsList 一行只接受一个字符串，所以取值选择器回传"显示文案"，
// 这里用同一份 i18n 选项表把文案映射回规范化取值（见 fieldValueFromLabel / languageFromLabel），
// 因此语言切换后菜单重建即刷新全部显示，无需额外的显示态。
// 短选项行（布尔与枚举 schema 字段）带 values 数组，回车/空格就地循环切换（pi 原生设置同款）：
// 显示文案 → 规范化取值的反查与整行落盘由列表的统一改动入口（onChange）承担。
// 一级结构：问题行 → 每组模块的顶层行（topLevel 钩子或默认规则）；
// 需要专用编辑器的模块由 topLevel 入口行打开二级页，页内行集合由 pageId 聚合（buildPageItems）。

import type { SettingItem } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ToolkitConfig } from "../config.ts";
import {
  languageLabelKey,
  LANGUAGE_SETTINGS,
  type LanguageSetting,
  type ResolvedLanguage,
  type Translator,
} from "../../i18n/index.ts";
import {
  isBooleanField,
  MODULE_GROUPS,
  normalizeConfigValue,
  type ConfigField,
  type ModuleConfigScalar,
  type ModuleConfigValue,
  type ModuleConfigRecord,
  type ModuleDefinition,
  type RowChangeEntry,
} from "../module.ts";
import type { ActiveModule } from "../assembler.ts";
import { moduleFieldId } from "../assembler.ts";
import type { ConfigWriteHooks } from "../config-transaction.ts";
import type { ToolkitProblem } from "../toolkit.ts";
import type { ServiceRegistry } from "../services.ts";
import { ChoicePicker } from "./panels.ts";
import type { MenuTheme } from "./theme.ts";
import type { ModuleMenuContext } from "../module.ts";

/** 语言行的 id */
export const ID_LANGUAGE = "language";

export interface MenuState {
  readonly config: ToolkitConfig;
  readonly modules: readonly ActiveModule[];
  readonly problems: readonly ToolkitProblem[];
  readonly services: ServiceRegistry;
  readonly language: LanguageSetting;
  readonly resolvedLanguage: ResolvedLanguage;
}

export interface MenuBuildContext {
  readonly t: Translator;
  readonly theme: MenuTheme;
  /** 打开菜单时的扩展上下文；模块自绘子菜单需要与宿主交互时用它 */
  readonly context: ExtensionContext;
  /** pi 的配置目录：模块自写盘时用 */
  readonly agentDir: string;
  getState(): MenuState;
  getModuleConfig(moduleId: string): ModuleConfigRecord;
  /** 顶层统一改动入口（id 与显示文案） */
  onChange(id: string, value: string): void;
  /** 异步动作结束后请宿主重绘 */
  requestRender(): void;
  /** 结构化配置写入事务（工单 19）：模块菜单把补丁写进自己的配置节，重绘请求由菜单层注入 */
  saveModuleConfig(moduleId: string, patch: ModuleConfigRecord, hooks?: ConfigWriteHooks): Promise<void>;
  /** 自绘短选项行的就地切换注册（见 RowChangeEntry）：模块构造行时调用 */
  registerRowChange(id: string, entry: RowChangeEntry): void;
  /** 重建整棵菜单：语言切换后用它刷新全部文案 */
  refresh(selectId?: string): void;
}

/** 一个取值的规范化代码与本地化文案 */
export interface FieldOption {
  readonly code: string;
  readonly label: string;
}

function enumValueLabel(t: Translator, field: ConfigField, value: string): string {
  const key = field.valueLabelKeys?.[value];
  return key ? t(key) : value;
}

/** 字段的可选值：boolean 为 开/关，枚举取 schema 声明的 values */
export function fieldOptions(t: Translator, field: ConfigField): FieldOption[] {
  if (isBooleanField(field)) {
    return [
      { code: "true", label: t("common.on") },
      { code: "false", label: t("common.off") },
    ];
  }
  return (field.values ?? []).map((value) => ({ code: value, label: enumValueLabel(t, field, value) }));
}

function fieldCode(current: ModuleConfigScalar | undefined): string | undefined {
  return current === undefined ? undefined : String(current);
}

/** 当前值在菜单里显示的本地化文案 */
export function fieldDisplayValue(
  t: Translator,
  field: ConfigField,
  current: ModuleConfigScalar | undefined,
): string {
  const code = fieldCode(current);
  const option = fieldOptions(t, field).find((candidate) => candidate.code === code);
  return option?.label ?? code ?? "";
}

/** 选择器回传的显示文案 → 规范化取值；匹配不上返回 undefined */
export function fieldValueFromLabel(
  t: Translator,
  field: ConfigField,
  label: string,
): ModuleConfigScalar | undefined {
  const option = fieldOptions(t, field).find((candidate) => candidate.label === label);
  return option ? normalizeConfigValue(field, option.code) : undefined;
}

/** 语言选择项：四个设置加各自本地化文案 */
export function languageOptions(t: Translator): { setting: LanguageSetting; label: string }[] {
  return LANGUAGE_SETTINGS.map((setting) => ({ setting, label: t(languageLabelKey(setting)) }));
}

export function languageFromLabel(t: Translator, label: string): LanguageSetting | undefined {
  return languageOptions(t).find((option) => option.label === label)?.setting;
}

export function buildTopLevelItems(build: MenuBuildContext): SettingItem[] {
  const state = build.getState();
  const items: SettingItem[] = [];
  for (const problem of state.problems) {
    items.push(problemItem(build, problem));
  }
  for (const group of MODULE_GROUPS) {
    if (group === "general") {
      items.push(languageItem(build));
    }
    for (const active of state.modules) {
      if (active.definition.group !== group) continue;
      items.push(...moduleTopItems(build, active.definition));
    }
  }
  return items;
}

/** 模块在一级的行：topLevel 钩子优先，缺省按默认规则（schema 字段行 + menuItems 入口行） */
function moduleTopItems(build: MenuBuildContext, definition: ModuleDefinition): SettingItem[] {
  if (definition.topLevel) {
    return [...definition.topLevel(moduleMenuContext(build, definition))];
  }
  return moduleItems(build, definition);
}

/** 构造传给模块钩子的菜单上下文（menuItems / topLevel 共用） */
export function moduleMenuContext(
  build: MenuBuildContext,
  definition: ModuleDefinition,
): ModuleMenuContext {
  return {
    t: build.t,
    services: build.getState().services,
    getConfig: () => build.getModuleConfig(definition.id),
    context: build.context,
    agentDir: build.agentDir,
    theme: build.theme,
    requestRender: () => build.requestRender(),
    saveConfig: (patch, hooks) => build.saveModuleConfig(definition.id, patch, hooks),
    onChange: build.onChange,
    registerRowChange: (id, entry) => build.registerRowChange(id, entry),
    ...(definition.pageId === undefined
      ? {}
      : { pageItems: () => buildPageItems(build, definition.pageId!, definition.id) }),
  };
}

/** 共享二级页行集合：页主模块的行在前，其余同 pageId 模块按装配顺序追加 */
export function buildPageItems(
  build: MenuBuildContext,
  pageId: string,
  ownerModuleId?: string,
): SettingItem[] {
  const members = build
    .getState()
    .modules.filter((active) => active.definition.pageId === pageId);
  const ordered = [
    ...members.filter((active) => active.definition.id === ownerModuleId),
    ...members.filter((active) => active.definition.id !== ownerModuleId),
  ];
  return ordered.flatMap((active) => moduleItems(build, active.definition));
}

function problemItem(build: MenuBuildContext, problem: ToolkitProblem): SettingItem {
  return {
    id: `problem.${problem.kind}.${problem.source}`,
    label: build.t(problem.kind === "config" ? "problem.config" : "problem.module"),
    description: problem.detail,
    currentValue: problem.source,
  };
}

function languageItem(build: MenuBuildContext): SettingItem {
  const state = build.getState();
  const description =
    state.language === "auto"
      ? build.t("language.autoResolved", {
          language: build.t(languageLabelKey(state.resolvedLanguage)),
        })
      : build.t("language.description");
  return {
    id: ID_LANGUAGE,
    label: build.t("language.label"),
    description,
    currentValue: build.t(languageLabelKey(state.language)),
    submenu: (_currentValue, done) =>
      new ChoicePicker({
        title: build.t("language.label"),
        options: languageOptions(build.t).map((option) => ({
          value: option.setting,
          label: option.label,
          ...(option.setting === state.language ? { description: build.t("common.current") } : {}),
        })),
        theme: build.theme,
        t: build.t,
        onSelect: (_value, label) => done(label),
        onCancel: () => done(),
      }),
  };
}

function moduleItems(build: MenuBuildContext, definition: ModuleDefinition): SettingItem[] {
  const config = build.getModuleConfig(definition.id);
  const items: SettingItem[] = [];
  for (const [key, field] of Object.entries(definition.configSchema)) {
    items.push(fieldItem(build, definition, key, field, config[key]));
  }
  if (definition.menuItems) {
    items.push(...definition.menuItems(moduleMenuContext(build, definition)));
  }
  return items;
}

/**
 * schema 字段行的通用构造（骨架自动行与模块 topLevel 钩子共用）：
 * 全部 schema 字段都按就地切换构造（布尔 → 开/关，枚举 → schema 声明的 values），
 * 不做长度或类型筛选；行带 values 数组，回车/空格就地循环切换（pi 原生设置同款），
 * 取值经列表的统一改动入口（onChange）反查落盘；当前值在内部规范化（非法取值回落默认值），
 * label / description 缺省从字段键取。
 */
export function schemaFieldRow(options: {
  readonly t: Translator;
  readonly id: string;
  readonly field: ConfigField;
  readonly label?: string;
  readonly description?: string;
  readonly current: ModuleConfigValue;
}): SettingItem {
  const { t, field } = options;
  const current = normalizeConfigValue(field, options.current) ?? field.default;
  const label = options.label ?? t(field.labelKey);
  const description =
    options.description ?? (field.descriptionKey === undefined ? undefined : t(field.descriptionKey));
  return {
    id: options.id,
    label,
    ...(description === undefined ? {} : { description }),
    currentValue: fieldDisplayValue(t, field, current),
    values: fieldOptions(t, field).map((option) => option.label),
  };
}

function fieldItem(
  build: MenuBuildContext,
  definition: ModuleDefinition,
  key: string,
  field: ConfigField,
  current: ModuleConfigValue,
): SettingItem {
  return schemaFieldRow({
    t: build.t,
    id: moduleFieldId(definition.id, key),
    field,
    current,
  });
}
