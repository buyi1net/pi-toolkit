// 菜单行构造：顶层两组 + 分组页内容（语言、占位行、模块行）。
// 设计约定：SettingsList 一行只接受一个字符串，所以取值选择器回传"显示文案"，
// 这里用同一份 i18n 选项表把文案映射回规范化取值（见 fieldValueFromLabel / languageFromLabel），
// 因此语言切换后菜单重建即刷新全部显示，无需额外的显示态。

import type { SettingItem } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ToolkitConfig } from "../config.ts";
import {
  languageLabelKey,
  LANGUAGE_SETTINGS,
  type LanguageSetting,
  type MessageKey,
  type ResolvedLanguage,
  type Translator,
} from "../i18n.ts";
import {
  isBooleanField,
  MODULE_GROUPS,
  normalizeConfigValue,
  type ConfigField,
  type ModuleConfigScalar,
  type ModuleConfigRecord,
  type ModuleDefinition,
  type ModuleGroup,
} from "../module.ts";
import type { ActiveModule } from "../assembler.ts";
import { moduleFieldId } from "../assembler.ts";
import type { ToolkitProblem } from "../toolkit.ts";
import type { ServiceRegistry } from "../services.ts";
import { ChoicePicker, SettingsPanel } from "./panels.ts";
import type { MenuTheme } from "./theme.ts";

/** 语言行的 id */
export const ID_LANGUAGE = "language";

const GROUP_ID_PREFIX = "group.";

export function groupItemId(group: ModuleGroup): string {
  return `${GROUP_ID_PREFIX}${group}`;
}

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
    items.push(groupItem(build, group));
  }
  return items;
}

export function buildGroupItems(build: MenuBuildContext, group: ModuleGroup): SettingItem[] {
  const items: SettingItem[] = [];
  if (group === "general") {
    items.push(languageItem(build));
  }
  for (const active of build.getState().modules) {
    if (active.definition.group !== group) continue;
    items.push(...moduleItems(build, active.definition));
  }
  return items;
}

function groupLabelKeys(group: ModuleGroup): { label: MessageKey; description: MessageKey } {
  return group === "general"
    ? { label: "group.general", description: "group.general.description" }
    : { label: "group.subagents", description: "group.subagents.description" };
}

function groupItem(build: MenuBuildContext, group: ModuleGroup): SettingItem {
  const keys = groupLabelKeys(group);
  return {
    id: groupItemId(group),
    label: build.t(keys.label),
    description: build.t(keys.description),
    currentValue: build.t("group.itemCount", { count: buildGroupItems(build, group).length }),
    submenu: (_currentValue, done) =>
      new SettingsPanel({
        title: build.t(keys.label),
        items: buildGroupItems(build, group),
        theme: build.theme,
        t: build.t,
        onChange: build.onChange,
        onClose: () => done(),
      }),
  };
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
    // schema 字段是标量；这里再规范化一次，把类型收成标量（取值非法时回落到默认值）
    const current = normalizeConfigValue(field, config[key]) ?? field.default;
    items.push(fieldItem(build, definition, key, field, current));
  }
  if (definition.menuItems) {
    items.push(
      ...definition.menuItems({
        t: build.t,
        services: build.getState().services,
        getConfig: () => build.getModuleConfig(definition.id),
        context: build.context,
        agentDir: build.agentDir,
        theme: build.theme,
        requestRender: () => build.requestRender(),
      }),
    );
  }
  return items;
}

function fieldItem(
  build: MenuBuildContext,
  definition: ModuleDefinition,
  key: string,
  field: ConfigField,
  current: ModuleConfigScalar | undefined,
): SettingItem {
  const label = build.t(field.labelKey);
  const currentCode = fieldCode(current);
  return {
    id: moduleFieldId(definition.id, key),
    label,
    ...(field.descriptionKey === undefined ? {} : { description: build.t(field.descriptionKey) }),
    currentValue: fieldDisplayValue(build.t, field, current),
    submenu: (_currentValue, done) =>
      new ChoicePicker({
        title: label,
        options: fieldOptions(build.t, field).map((option) => ({
          value: option.code,
          label: option.label,
          ...(option.code === currentCode ? { description: build.t("common.current") } : {}),
        })),
        theme: build.theme,
        t: build.t,
        onSelect: (_value, displayLabel) => done(displayLabel),
        onCancel: () => done(),
      }),
  };
}
