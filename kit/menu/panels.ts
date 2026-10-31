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

  readonly onClose: () => void;

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

  readonly searchable?: boolean;

  readonly onSelect: (value: string, label: string) => void;
  readonly onCancel: () => void;
}

export class ChoicePicker extends Container {
  private list: SelectList;
  private readonly searchInput: Input | undefined;
  private allItems: SelectItem[];
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

  removeOption(value: string): void {
    const remaining = this.allItems.filter((item) => item.value !== value);
    if (remaining.length === this.allItems.length) return;
    this.allItems = remaining;
    const query = this.searchInput ? this.searchInput.getValue() : "";
    this.applyFilter(query);
  }
}
