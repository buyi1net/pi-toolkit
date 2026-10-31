import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { languageLabelKey, type LanguageSetting } from "../../i18n/index.ts";
import { createConfigTransaction } from "../config-transaction.ts";
import { normalizeConfigValue, type ModuleConfigScalar, type RowChangeEntry } from "../module.ts";
import type { Toolkit } from "../toolkit.ts";
import {
  buildTopLevelItems,
  fieldDisplayValue,
  fieldValueFromLabel,
  ID_LANGUAGE,
  languageFromLabel,
  type MenuBuildContext,
  type MenuState,
} from "./items.ts";
import { I18nSettingsList } from "./settings-list.ts";
import type { MenuTheme } from "./theme.ts";

const TOP_LEVEL_MAX_VISIBLE = 10;

export function readMenuState(toolkit: Toolkit): MenuState {
  return {
    config: toolkit.getConfig(),
    modules: toolkit.modules,
    problems: toolkit.problems,
    services: toolkit.services,
    language: toolkit.getLanguage(),
    resolvedLanguage: toolkit.getResolvedLanguage(),
  };
}

export interface ToolkitMenuOptions {
  readonly toolkit: Toolkit;
  readonly theme: MenuTheme;

  readonly context: ExtensionContext;

  readonly agentDir: string;

  readonly requestRender: () => void;

  readonly onChange: (id: string, value: string) => void;

  readonly onClose: () => void;
}

export class ToolkitMenu extends Container {
  private readonly options: ToolkitMenuOptions;
  private readonly build: MenuBuildContext;
  private list: I18nSettingsList | undefined;

  private readonly rowChanges = new Map<string, RowChangeEntry>();

  constructor(options: ToolkitMenuOptions) {
    super();
    this.options = options;

    const transaction = createConfigTransaction({
      configPath: options.toolkit.configPath,
      reload: () => options.toolkit.reloadConfig(),
      requestRender: () => options.requestRender(),
    });
    this.build = {

      t: options.toolkit.getTranslator(),
      theme: options.theme,
      context: options.context,
      agentDir: options.agentDir,
      getState: () => readMenuState(options.toolkit),
      getModuleConfig: (moduleId) => options.toolkit.getModuleConfig(moduleId),
      onChange: (id, value) => {
        void this.handleRowChange(id, value);
      },
      requestRender: () => options.requestRender(),
      saveModuleConfig: (moduleId, patch, hooks) =>
        transaction.write({ modules: { [moduleId]: patch } }, hooks),
      registerRowChange: (id, entry) => {
        this.rowChanges.set(id, entry);
      },
      refresh: (selectId) => this.rebuild(selectId),
    };
    this.rebuild();
  }

  refresh(selectId?: string): void {
    this.rebuild(selectId);
  }

  restoreValue(id: string): void {
    const toolkit = this.options.toolkit;
    const t = toolkit.getTranslator();
    if (id === ID_LANGUAGE) {
      this.list?.updateValue(id, t(languageLabelKey(toolkit.getLanguage())));
      return;
    }
    const separator = id.indexOf(".");
    if (separator <= 0) return;
    const moduleId = id.slice(0, separator);
    const field = id.slice(separator + 1);
    const schemaField = toolkit.getModuleDefinition(moduleId)?.configSchema[field];
    if (!schemaField) return;
    const stored = toolkit.getModuleConfig(moduleId)[field];
    const normalized = stored === undefined ? undefined : normalizeConfigValue(schemaField, stored);
    this.list?.updateValue(id, fieldDisplayValue(t, schemaField, normalized));
  }

  handleInput(data: string): void {
    this.list?.handleInput(data);
  }

  private async handleRowChange(id: string, value: string): Promise<void> {
    const entry = this.rowChanges.get(id);
    if (!entry) {
      this.options.onChange(id, value);
      return;
    }
    let ok = false;
    try {
      ok = await entry.change(value);
    } catch {

      ok = false;
    }
    if (!ok) {
      this.list?.updateValue(id, entry.read());
    }
  }

  private rebuild(selectId?: string): void {
    this.clear();
    this.rowChanges.clear();
    const items = buildTopLevelItems(this.build);
    this.addChild(new DynamicBorder(this.options.theme.border));
    const list = new I18nSettingsList({
      items,
      maxVisible: Math.min(Math.max(items.length, 1), TOP_LEVEL_MAX_VISIBLE),
      theme: this.options.theme.settings,
      t: this.build.t,
      enableSearch: true,
      onChange: (id, value) => {
        void this.handleRowChange(id, value);
      },
      onCancel: () => this.options.onClose(),
    });
    this.list = list;
    this.addChild(list);
    this.addChild(new DynamicBorder(this.options.theme.border));
    if (selectId) list.selectItem(selectId);
  }
}

export type MenuChangeResult =
  | { readonly kind: "language"; readonly language: LanguageSetting }
  | {
      readonly kind: "module-field";
      readonly moduleId: string;
      readonly field: string;
      readonly value: ModuleConfigScalar;
    }

  | { readonly kind: "unmapped" }
  | { readonly kind: "ignored" };

export async function applyMenuChange(
  toolkit: Toolkit,
  id: string,
  displayValue: string,
): Promise<MenuChangeResult> {
  const t = toolkit.getTranslator();

  if (id === ID_LANGUAGE) {
    const language = languageFromLabel(t, displayValue);
    if (!language) return { kind: "unmapped" };
    return { kind: "language", language: await toolkit.setLanguage(language) };
  }

  const separator = id.indexOf(".");
  if (separator <= 0) return { kind: "ignored" };
  const moduleId = id.slice(0, separator);
  const field = id.slice(separator + 1);
  const definition = toolkit.getModuleDefinition(moduleId);
  const schemaField = definition?.configSchema[field];

  if (!definition || !schemaField) return { kind: "ignored" };

  const value = fieldValueFromLabel(t, schemaField, displayValue);
  if (value === undefined) return { kind: "unmapped" };
  return { kind: "module-field", moduleId, field, value: await toolkit.setModuleField(moduleId, field, value) };
}
