// SettingsList 的薄包装：组件内部自带几行英文提示（"Enter/Space to change · Esc to cancel"、
// "Type to search"、"No matching settings" 等），无法通过构造参数改写。这里在渲染出口按行
// 替换成 i18n 文案，保证三语切换后菜单里没有残留英文；无法识别时原样放行，不猜不改。

import {
  type Component,
  type SettingItem,
  SettingsList,
  type SettingsListTheme,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import type { FrameworkMessageKey, Translator } from "../../i18n/index.ts";

/** 组件内置提示行 → i18n 键；顺序即匹配顺序，先匹配更长的搜索提示 */
const BUILT_IN_HINTS: readonly { readonly match: string; readonly key: FrameworkMessageKey }[] = [
  { match: "Type to search", key: "hint.search" },
  { match: "Enter/Space to change", key: "hint.change" },
  { match: "No matching settings", key: "hint.noMatch" },
  { match: "No settings available", key: "hint.noSettings" },
];

export interface I18nSettingsListOptions {
  readonly items: readonly SettingItem[];
  readonly maxVisible: number;
  readonly theme: SettingsListTheme;
  readonly t: Translator;
  readonly onChange: (id: string, value: string) => void;
  readonly onCancel: () => void;
  readonly enableSearch?: boolean;
}

export class I18nSettingsList implements Component {
  private readonly list: SettingsList;
  private readonly t: Translator;
  private readonly theme: SettingsListTheme;

  constructor(options: I18nSettingsListOptions) {
    this.t = options.t;
    this.theme = options.theme;
    this.list = new SettingsList(
      [...options.items],
      options.maxVisible,
      options.theme,
      options.onChange,
      options.onCancel,
      options.enableSearch === undefined ? {} : { enableSearch: options.enableSearch },
    );
  }

  updateValue(id: string, newValue: string): void {
    this.list.updateValue(id, newValue);
  }

  selectItem(id: string): void {
    this.list.selectItem(id);
  }

  invalidate(): void {
    this.list.invalidate();
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.list.handleMouse(event);
  }

  render(width: number): string[] {
    return this.list.render(width).map((line) => this.translateLine(line, width));
  }

  private translateLine(line: string, width: number): string {
    for (const hint of BUILT_IN_HINTS) {
      if (line.includes(hint.match)) {
        return truncateToWidth(this.theme.hint(this.t(hint.key)), width);
      }
    }
    return line;
  }
}
