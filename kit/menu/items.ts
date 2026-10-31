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

  readonly context: ExtensionContext;

  readonly agentDir: string;
  getState(): MenuState;
  getModuleConfig(moduleId: string): ModuleConfigRecord;

  onChange(id: string, value: string): void;

  requestRender(): void;

  saveModuleConfig(moduleId: string, patch: ModuleConfigRecord, hooks?: ConfigWriteHooks): Promise<void>;

  registerRowChange(id: string, entry: RowChangeEntry): void;

  refresh(selectId?: string): void;
}

export interface FieldOption {
  readonly code: string;
  readonly label: string;
}

function enumValueLabel(t: Translator, field: ConfigField, value: string): string {
  const key = field.valueLabelKeys?.[value];
  return key ? t(key) : value;
}

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

export function fieldDisplayValue(
  t: Translator,
  field: ConfigField,
  current: ModuleConfigScalar | undefined,
): string {
  const code = fieldCode(current);
  const option = fieldOptions(t, field).find((candidate) => candidate.code === code);
  return option?.label ?? code ?? "";
}

export function fieldValueFromLabel(
  t: Translator,
  field: ConfigField,
  label: string,
): ModuleConfigScalar | undefined {
  const option = fieldOptions(t, field).find((candidate) => candidate.label === label);
  return option ? normalizeConfigValue(field, option.code) : undefined;
}

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

function moduleTopItems(build: MenuBuildContext, definition: ModuleDefinition): SettingItem[] {
  if (definition.topLevel) {
    return [...definition.topLevel(moduleMenuContext(build, definition))];
  }
  return moduleItems(build, definition);
}

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
