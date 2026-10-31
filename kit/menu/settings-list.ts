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
