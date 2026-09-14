// 一级菜单列表组件（工单 46）：pi 原生 SettingsList 不支持分组标题，也不能安全地从
// 外部改它的渲染（renderMainList 私有，滚动/搜索过滤后行号与 item 索引不固定对应），
// 所以把原生组件（pi-tui/dist/components/settings-list.js）的渲染与交互逻辑搬过来裁剪，
// 加上标题行支持。
//
// 与原生的差异只在标题行：
// - 上下键与滚轮跳过标题行，光标永不落在标题上；回车/空格对标题无反应；
// - 搜索只匹配设置行，标题不产生孤立匹配；查询为空时恢复全部标题；
// - label 宽度对齐只在设置行之间计算，标题不参与。
// 其余行为保持原生：模糊搜索（Input + fuzzyFilter）、上下键循环、鼠标（hover 不改
// 选中、点击激活）、可见窗口滚动 + (n/m) 提示、选中项描述行、子菜单托管。
// 提示行不走组件内置英文文案，直接用框架键表渲染（三语无英文残留）。

import {
  fuzzyFilter,
  getKeybindings,
  Input,
  type Component,
  type SettingItem,
  type SettingsListTheme,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { FrameworkMessageKey, Translator } from "../../i18n/index.ts";

/** 分组标题行：只做视觉分隔，不可选中、不可激活、不参与搜索与对齐 */
export interface HeadingItem {
  readonly kind: "heading";
  readonly label: string;
}

/** 一级菜单的行：普通设置行或分组标题行 */
export type GroupedSettingItem = SettingItem | HeadingItem;

export function isHeading(item: GroupedSettingItem): item is HeadingItem {
  return (item as HeadingItem).kind === "heading";
}

export interface GroupedSettingsListOptions {
  readonly items: readonly GroupedSettingItem[];
  readonly maxVisible: number;
  readonly theme: SettingsListTheme;
  readonly t: Translator;
  readonly onChange: (id: string, newValue: string) => void;
  readonly onCancel: () => void;
  /** 标题行上色（MenuTheme.title：accent 加粗） */
  readonly heading: (text: string) => string;
}

export class GroupedSettingsList implements Component {
  private readonly items: GroupedSettingItem[];
  private filteredItems: GroupedSettingItem[];
  private readonly theme: SettingsListTheme;
  private readonly headingStyle: (text: string) => string;
  private readonly t: Translator;
  private selectedIndex = 0;
  private mousePressedIndex: number | undefined;
  private readonly maxVisible: number;
  private readonly onChange: (id: string, newValue: string) => void;
  private readonly onCancel: () => void;
  private readonly searchInput: Input;
  // 子菜单状态（与原生同构）：打开期间渲染与输入全部委托给子菜单
  private submenuComponent: Component | null = null;
  private submenuItemIndex: number | null = null;
  private navigateAfterClose: string | null = null;

  constructor(options: GroupedSettingsListOptions) {
    this.items = [...options.items];
    this.filteredItems = this.items;
    this.maxVisible = options.maxVisible;
    this.theme = options.theme;
    this.headingStyle = options.heading;
    this.t = options.t;
    this.onChange = options.onChange;
    this.onCancel = options.onCancel;
    // 一级菜单始终开搜索（工单 46：顶层跨分组搜索）
    this.searchInput = new Input();
    this.selectedIndex = this.firstActivatableIndex();
  }

  /** 把光标移到指定 id 的设置行（找不到则不动） */
  selectItem(id: string): void {
    const index = this.filteredItems.findIndex(
      (candidate) => !isHeading(candidate) && candidate.id === id,
    );
    if (index !== -1) {
      this.selectedIndex = index;
    }
  }

  /**
   * 把指定 id 的设置行显示值换掉（不触发 onChange）：保存失败后的显示回滚用。
   * 本层没有该行时转发给打开中的子面板：二级页里的行走同一个回滚入口。
   */
  updateValue(id: string, newValue: string): void {
    const item = this.filteredItems.find(
      (candidate): candidate is SettingItem => !isHeading(candidate) && candidate.id === id,
    );
    if (item) {
      item.currentValue = newValue;
    }
    const panel = this.submenuComponent as
      | { updateValue?: (id: string, newValue: string) => void }
      | null;
    panel?.updateValue?.(id, newValue);
  }

  invalidate(): void {
    this.submenuComponent?.invalidate?.();
  }

  render(width: number): string[] {
    if (this.submenuComponent) {
      return this.submenuComponent.render(width);
    }
    return this.renderMainList(width);
  }

  private renderMainList(width: number): string[] {
    const lines: string[] = [];
    lines.push(...this.searchInput.render(width));
    lines.push("");

    const settingItems = this.items.filter((item) => !isHeading(item));
    if (settingItems.length === 0) {
      lines.push(truncateToWidth(this.theme.hint(this.t("hint.noSettings")), width));
      this.addHintLine(lines, width);
      return lines;
    }
    const displayItems = this.getDisplayItems();
    if (this.activatableCount(displayItems) === 0) {
      lines.push(truncateToWidth(this.theme.hint(this.t("hint.noMatch")), width));
      this.addHintLine(lines, width);
      return lines;
    }

    const { startIndex, endIndex } = this.getVisibleRange(displayItems);
    // label 宽度对齐只在设置行之间计算，标题行不参与
    const maxLabelWidth = Math.min(36, Math.max(...settingItems.map((item) => visibleWidth(item.label))));

    for (let i = startIndex; i < endIndex; i++) {
      const item = displayItems[i];
      if (!item) continue;
      if (isHeading(item)) {
        lines.push(truncateToWidth(this.headingStyle(`  ${item.label}`), width));
        continue;
      }
      const isSelected = i === this.selectedIndex;
      const prefix = isSelected ? this.theme.cursor : "  ";
      const prefixWidth = visibleWidth(prefix);
      const labelPadded = item.label + " ".repeat(Math.max(0, maxLabelWidth - visibleWidth(item.label)));
      const labelText = this.theme.label(labelPadded, isSelected);
      const separator = "  ";
      const usedWidth = prefixWidth + maxLabelWidth + visibleWidth(separator);
      const valueMaxWidth = width - usedWidth - 2;
      const valueText = this.theme.value(truncateToWidth(item.currentValue, valueMaxWidth, ""), isSelected);
      lines.push(truncateToWidth(prefix + labelText + separator + valueText, width));
    }

    if (startIndex > 0 || endIndex < displayItems.length) {
      const scrollText = `  (${this.selectedIndex + 1}/${displayItems.length})`;
      lines.push(this.theme.hint(truncateToWidth(scrollText, width - 2, "")));
    }

    const selectedItem = displayItems[this.selectedIndex];
    if (selectedItem && !isHeading(selectedItem) && selectedItem.description) {
      lines.push("");
      const wrappedDesc = wrapTextWithAnsi(selectedItem.description, width - 4);
      for (const line of wrappedDesc) {
        lines.push(this.theme.description(`  ${line}`));
      }
    }

    this.addHintLine(lines, width);
    return lines;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.submenuComponent) {
      const result = this.submenuComponent.handleMouse?.(event);
      return result ? { ...result, focus: true } : undefined;
    }
    // 搜索输入行固定在第 0 行，第 1 行是空行
    if (event.y === 0) {
      const result = this.searchInput.handleMouse?.(event);
      return result ? { ...result, focus: true } : undefined;
    }
    if (event.y === 1) return undefined;

    const displayItems = this.getDisplayItems();
    if (this.activatableCount(displayItems) === 0) return undefined;
    if (event.type === "wheel" && event.wheelDelta) {
      const delta = event.wheelDelta < 0 ? -1 : 1;
      const previousIndex = this.selectedIndex;
      this.moveSelection(delta);
      return { handled: true, render: this.selectedIndex !== previousIndex };
    }
    // hover 必须不改变选中：可见窗口以选中项为中心
    if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return undefined;
    const rowOffset = 2;
    const { startIndex, endIndex } = this.getVisibleRange(displayItems);
    const itemIndex = startIndex + event.y - rowOffset;
    if (itemIndex < startIndex || itemIndex >= endIndex) return undefined;
    if (isHeading(displayItems[itemIndex])) return undefined;
    if (event.type === "press") {
      this.mousePressedIndex = itemIndex;
      this.selectedIndex = itemIndex;
      return { handled: true, focus: true };
    }
    if (event.type === "click") {
      this.selectedIndex = this.mousePressedIndex ?? itemIndex;
      this.mousePressedIndex = undefined;
      this.activateItem();
      return { handled: true };
    }
    return undefined;
  }

  handleInput(data: string): void {
    // 子菜单打开期间输入全部委托给它；Esc 由子菜单的 onCancel 触发 done() 关闭
    if (this.submenuComponent) {
      this.submenuComponent.handleInput?.(data);
      return;
    }
    const kb = getKeybindings();
    if (kb.matches(data, "tui.select.up")) {
      this.moveSelection(-1);
    } else if (kb.matches(data, "tui.select.down")) {
      this.moveSelection(1);
    } else if (kb.matches(data, "tui.select.confirm") || (data === " " && this.searchInput.getValue().length === 0)) {
      this.activateItem();
    } else if (kb.matches(data, "tui.select.cancel")) {
      this.onCancel();
    } else {
      this.searchInput.handleInput(data);
      this.applyFilter(this.searchInput.getValue());
    }
  }

  private getDisplayItems(): GroupedSettingItem[] {
    return this.filteredItems;
  }

  private activatableCount(items: readonly GroupedSettingItem[]): number {
    return items.filter((item) => !isHeading(item)).length;
  }

  private firstActivatableIndex(): number {
    const index = this.filteredItems.findIndex((item) => !isHeading(item));
    return index === -1 ? 0 : index;
  }

  /** 上下键/滚轮移动选中：跳过标题行，首尾循环 */
  private moveSelection(step: 1 | -1): void {
    const displayItems = this.getDisplayItems();
    if (this.activatableCount(displayItems) === 0) return;
    let index = this.selectedIndex;
    for (let moved = 0; moved < displayItems.length; moved++) {
      index = (index + step + displayItems.length) % displayItems.length;
      if (!isHeading(displayItems[index])) {
        this.selectedIndex = index;
        return;
      }
    }
  }

  private getVisibleRange(displayItems: readonly GroupedSettingItem[]): {
    startIndex: number;
    endIndex: number;
  } {
    const startIndex = Math.max(
      0,
      Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), displayItems.length - this.maxVisible),
    );
    return { startIndex, endIndex: Math.min(startIndex + this.maxVisible, displayItems.length) };
  }

  private activateItem(): void {
    const item = this.getDisplayItems()[this.selectedIndex];
    if (!item || isHeading(item)) return;
    if (item.submenu) {
      this.submenuItemIndex = this.selectedIndex;
      this.submenuComponent = item.submenu(item.currentValue, (selectedValue, options) => {
        if (selectedValue !== undefined) {
          item.currentValue = selectedValue;
          this.onChange(item.id, selectedValue);
        }
        if (options?.navigateTo) {
          this.navigateAfterClose = options.navigateTo;
        }
        this.closeSubmenu();
      });
    } else if (item.values && item.values.length > 0) {
      const currentIndex = item.values.indexOf(item.currentValue);
      const nextIndex = (currentIndex + 1) % item.values.length;
      const newValue = item.values[nextIndex];
      item.currentValue = newValue;
      this.onChange(item.id, newValue);
    }
  }

  private closeSubmenu(): void {
    this.submenuComponent = null;
    if (this.navigateAfterClose !== null) {
      const id = this.navigateAfterClose;
      this.navigateAfterClose = null;
      this.submenuItemIndex = null;
      this.selectItem(id);
      this.activateItem();
    } else if (this.submenuItemIndex !== null) {
      this.selectedIndex = this.submenuItemIndex;
      this.submenuItemIndex = null;
    }
  }

  private applyFilter(query: string): void {
    if (query === "") {
      this.filteredItems = this.items;
    } else {
      // 搜索只匹配设置行：标题不参与，避免出现没有任何可选项的孤立标题
      const matched = fuzzyFilter(
        this.items.filter((item) => !isHeading(item)) as SettingItem[],
        query,
        (item) => item.label,
      );
      this.filteredItems = matched;
    }
    this.selectedIndex = this.firstActivatableIndex();
  }

  private addHintLine(lines: string[], width: number): void {
    lines.push("");
    lines.push(truncateToWidth(this.theme.hint(this.t("hint.search")), width));
  }
}
