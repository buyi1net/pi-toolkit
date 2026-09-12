// 顶层菜单组件与菜单改动落盘。
// 顶层用 SettingsList 内嵌在 Container 里（上下边框），分组页与取值选择器见 panels.ts。

import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import type { LanguageSetting } from "../../i18n/index.ts";
import { createConfigTransaction } from "../config-transaction.ts";
import type { ModuleConfigScalar } from "../module.ts";
import type { Toolkit } from "../toolkit.ts";
import {
  buildTopLevelItems,
  fieldValueFromLabel,
  ID_LANGUAGE,
  languageFromLabel,
  type MenuBuildContext,
  type MenuState,
} from "./items.ts";
import { I18nSettingsList } from "./settings-list.ts";
import type { MenuTheme } from "./theme.ts";

const TOP_LEVEL_MAX_VISIBLE = 8;

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
  /** 打开菜单时的扩展上下文（模块自绘子菜单用） */
  readonly context: ExtensionContext;
  /** pi 的配置目录（传给模块菜单，供模块自写盘） */
  readonly agentDir: string;
  /** 异步动作结束后请宿主重绘 */
  readonly requestRender: () => void;
  /** 菜单里每次取值变化都先到这里（id + 显示文案） */
  readonly onChange: (id: string, value: string) => void;
  /** 顶层 Esc：关闭菜单 */
  readonly onClose: () => void;
}

export class ToolkitMenu extends Container {
  private readonly options: ToolkitMenuOptions;
  private readonly build: MenuBuildContext;
  private list: I18nSettingsList | undefined;

  constructor(options: ToolkitMenuOptions) {
    super();
    this.options = options;
    // 结构化配置写入事务（工单 19）：写盘与内存重载走 kit，重绘请求由菜单层注入（kit 不依赖 tui）
    const transaction = createConfigTransaction({
      configPath: options.toolkit.configPath,
      reload: () => options.toolkit.reloadConfig(),
      requestRender: () => options.requestRender(),
    });
    this.build = {
      // 译者始终读当前语言，重建时 label 自然换成新语言
      t: options.toolkit.getTranslator(),
      theme: options.theme,
      context: options.context,
      agentDir: options.agentDir,
      getState: () => readMenuState(options.toolkit),
      getModuleConfig: (moduleId) => options.toolkit.getModuleConfig(moduleId),
      onChange: options.onChange,
      requestRender: () => options.requestRender(),
      saveModuleConfig: (moduleId, patch, hooks) =>
        transaction.write({ modules: { [moduleId]: patch } }, hooks),
      refresh: (selectId) => this.rebuild(selectId),
    };
    this.rebuild();
  }

  /** 语言切换后重建整棵菜单，让全部文案立刻生效 */
  refresh(selectId?: string): void {
    this.rebuild(selectId);
  }

  handleInput(data: string): void {
    this.list?.handleInput(data);
  }

  private rebuild(selectId?: string): void {
    this.clear();
    const items = buildTopLevelItems(this.build);
    this.addChild(new DynamicBorder(this.options.theme.border));
    const list = new I18nSettingsList({
      items,
      maxVisible: Math.min(Math.max(items.length, 1), TOP_LEVEL_MAX_VISIBLE),
      theme: this.options.theme.settings,
      t: this.build.t,
      onChange: this.options.onChange,
      onCancel: () => this.options.onClose(),
      enableSearch: true,
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
  | { readonly kind: "ignored" };

/**
 * 把菜单行 id 与显示文案翻回配置改动并持久化。
 * 显示文案 → 规范化取值的映射见 items.ts（同一份 i18n 选项表）。
 */
export async function applyMenuChange(
  toolkit: Toolkit,
  id: string,
  displayValue: string,
): Promise<MenuChangeResult> {
  const t = toolkit.getTranslator();

  if (id === ID_LANGUAGE) {
    const language = languageFromLabel(t, displayValue);
    if (!language) return { kind: "ignored" };
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
  if (value === undefined) return { kind: "ignored" };
  return { kind: "module-field", moduleId, field, value: await toolkit.setModuleField(moduleId, field, value) };
}
