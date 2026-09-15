// SettingsList 的薄包装，两件事：
// 1) 提示行 i18n：组件内部自带几行英文提示（"Enter/Space to change · Esc to cancel"、
//    "Type to search"、"No matching settings" 等），无法通过构造参数改写。这里在渲染出口按行
//    替换成 i18n 文案，保证三语切换后菜单里没有残留英文；无法识别时原样放行，不猜不改。
// 2) 子面板回滚转发：跟踪本列表最后打开的子菜单组件；updateValue(id) 先写本层行，
//    再转发给打开中的子面板（子面板内部的列表又是同一包装，逐层转发到行所在层）。
//    保存失败的行显示回滚（toolkit-menu 的 restoreValue 与直切失败回滚）都靠它落到正确层级。

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

type PanelWithUpdate = Component & { updateValue?(id: string, newValue: string): void };

export class I18nSettingsList implements Component {
  private readonly list: SettingsList;
  private readonly t: Translator;
  private readonly theme: SettingsListTheme;
  /** 最后打开的子菜单组件（同一时刻至多一个）；updateValue 的转发目标 */
  private openPanel: PanelWithUpdate | null = null;

  constructor(options: I18nSettingsListOptions) {
    this.t = options.t;
    this.theme = options.theme;
    this.list = new SettingsList(
      options.items.map((item) => this.trackSubmenu(item)),
      options.maxVisible,
      options.theme,
      options.onChange,
      options.onCancel,
      options.enableSearch === undefined ? {} : { enableSearch: options.enableSearch },
    );
  }

  /** 行显示回滚入口：本层行直接改；本层没有的（二级页里的行）转发给打开中的子面板逐层找 */
  updateValue(id: string, newValue: string): void {
    this.list.updateValue(id, newValue);
    this.openPanel?.updateValue?.(id, newValue);
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

  /** 包装子菜单构造：记录打开中的面板，done 时清除（Esc 与选择两条路径都会走 done） */
  private trackSubmenu(item: SettingItem): SettingItem {
    const original = item.submenu;
    if (!original) return item;
    return {
      ...item,
      submenu: (currentValue: string, done: (selectedValue?: string, options?: { navigateTo?: string }) => void) => {
        let closed = false;
        const panel = original(currentValue, (selectedValue, options) => {
          closed = true;
          this.openPanel = null;
          done(selectedValue, options);
        });
        // 子菜单构造期间同步关门（立即取消）时不登记
        if (!closed) {
          this.openPanel = panel;
        }
        return panel;
      },
    };
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
