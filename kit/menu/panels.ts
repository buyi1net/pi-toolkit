// 菜单里的两种面板组件，都是 Container 子类内嵌 pi 原生列表组件（原生 WarningSettingsSubmenu 同款写法）：
// - SettingsPanel：设置页（工单 46 起用于共享二级页），内嵌 I18nSettingsList，默认开搜索；
//   搜索栏本身就是页头，不再渲染单独的标题行
// - ChoicePicker：取值选择器，内嵌 SelectList；searchable 时加输入框过滤（照 pi 原生 SelectSubmenu 的写法）。
//   它是取值器不是可搜索列表，标题行保留，否则用户不知道在改哪一项
// Esc 都交给上层回传 done() 返回上级。

import {
  Container,
  fuzzyFilter,
  getKeybindings,
  Input,
  type SelectItem,
  SelectList,
  type SettingItem,
  Text,
} from "@earendil-works/pi-tui";
import type { Translator } from "../../i18n/index.ts";
import { I18nSettingsList } from "./settings-list.ts";
import type { MenuTheme } from "./theme.ts";

const MAX_VISIBLE = 10;

export interface SettingsPanelOptions {
  readonly items: readonly SettingItem[];
  readonly theme: MenuTheme;
  readonly t: Translator;
  readonly onChange: (id: string, value: string) => void;
  /** Esc：返回上级菜单 */
  readonly onClose: () => void;
  /** 默认 true（工单 46：二级页统一搜索）；仅在明确要求关闭时传 false */
  readonly enableSearch?: boolean;
}

export class SettingsPanel extends Container {
  private readonly list: I18nSettingsList;

  constructor(options: SettingsPanelOptions) {
    super();
    this.list = new I18nSettingsList({
      items: options.items,
      maxVisible: MAX_VISIBLE,
      theme: options.theme.settings,
      t: options.t,
      onChange: options.onChange,
      onCancel: options.onClose,
      enableSearch: options.enableSearch ?? true,
    });
    this.addChild(this.list);
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
  }

  /** 行显示回滚入口（与 I18nSettingsList.updateValue 同名契约）：委托内层列表 */
  updateValue(id: string, newValue: string): void {
    this.list.updateValue(id, newValue);
  }
}

export interface ChoiceOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

export interface ChoicePickerOptions {
  readonly title: string;
  readonly options: readonly ChoiceOption[];
  readonly theme: MenuTheme;
  readonly t: Translator;
  /** 长选项列表打开搜索框（输入即过滤）；短选项保持纯列表 */
  readonly searchable?: boolean;
  /** 回传规范化取值与显示文案；由调用方决定如何回填父项 */
  readonly onSelect: (value: string, label: string) => void;
  readonly onCancel: () => void;
}

export class ChoicePicker extends Container {
  private list: SelectList;
  private readonly searchInput: Input | undefined;
  private readonly allItems: SelectItem[];
  private readonly theme: MenuTheme;
  private readonly onPick: (item: SelectItem) => void;
  private readonly onCancelPick: () => void;
  private listChildIndex = 0;

  constructor(options: ChoicePickerOptions) {
    super();
    this.theme = options.theme;
    this.onPick = (item) => options.onSelect(item.value, item.label);
    this.onCancelPick = () => options.onCancel();
    this.addChild(new Text(options.theme.title(options.title), 1, 0));
    this.allItems = options.options.map((option) => ({
      value: option.value,
      label: option.label,
      ...(option.description === undefined ? {} : { description: option.description }),
    }));
    if (options.searchable) {
      this.searchInput = new Input();
      this.addChild(this.searchInput);
    }
    this.list = this.buildList(this.allItems);
    this.listChildIndex = this.children.length;
    this.addChild(this.list);
    this.addChild(
      new Text(
        options.theme.hint(options.t(options.searchable ? "hint.filter" : "hint.chooseOptions")),
        1,
        0,
      ),
    );
  }

  handleInput(data: string): void {
    if (!this.searchInput) {
      this.list.handleInput(data);
      return;
    }
    // 导航键交给列表，其余输入进搜索框过滤（pi 原生 SelectSubmenu 同款分流）
    const kb = getKeybindings();
    const isNav =
      kb.matches(data, "tui.select.up") ||
      kb.matches(data, "tui.select.down") ||
      kb.matches(data, "tui.select.confirm") ||
      kb.matches(data, "tui.select.cancel");
    if (isNav) {
      this.list.handleInput(data);
      return;
    }
    this.searchInput.handleInput(data);
    this.applyFilter(this.searchInput.getValue());
  }

  private buildList(items: readonly SelectItem[]): SelectList {
    const list = new SelectList([...items], Math.min(items.length, MAX_VISIBLE), this.theme.select);
    list.onSelect = (item) => this.onPick(item);
    list.onCancel = () => this.onCancelPick();
    return list;
  }

  private applyFilter(query: string): void {
    const filtered = query
      ? fuzzyFilter(this.allItems, query, (item) => `${item.label} ${item.description ?? ""}`)
      : this.allItems;
    const list = this.buildList(filtered);
    this.children[this.listChildIndex] = list;
    this.list = list;
  }
}
