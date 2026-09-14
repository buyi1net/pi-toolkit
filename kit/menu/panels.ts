// 菜单里的两种面板组件，都是 Container 子类内嵌 pi 原生列表组件（原生 WarningSettingsSubmenu 同款写法）：
// - SettingsPanel：设置页（工单 46 起用于共享二级页），内嵌 SettingsList，默认开搜索；
//   搜索栏本身就是页头，不再渲染单独的标题行
// - ChoicePicker：取值选择器，内嵌 SelectList，用于语言与各配置字段的取值选择；
//   它是取值器不是可搜索列表，标题行保留，否则用户不知道在改哪一项
// Esc 都交给上层回传 done() 返回上级。

import {
  Container,
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
  /** 回传规范化取值与显示文案；由调用方决定如何回填父项 */
  readonly onSelect: (value: string, label: string) => void;
  readonly onCancel: () => void;
}

export class ChoicePicker extends Container {
  private readonly list: SelectList;

  constructor(options: ChoicePickerOptions) {
    super();
    this.addChild(new Text(options.theme.title(options.title), 1, 0));
    const items: SelectItem[] = options.options.map((option) => ({
      value: option.value,
      label: option.label,
      ...(option.description === undefined ? {} : { description: option.description }),
    }));
    this.list = new SelectList(items, Math.min(items.length, MAX_VISIBLE), options.theme.select);
    this.list.onSelect = (item) => options.onSelect(item.value, item.label);
    this.list.onCancel = () => options.onCancel();
    this.addChild(this.list);
    this.addChild(new Text(options.theme.hint(options.t("hint.chooseOptions")), 1, 0));
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
  }
}
