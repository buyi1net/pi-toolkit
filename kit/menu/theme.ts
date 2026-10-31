import {
  getSelectListTheme,
  getSettingsListTheme,
  type Theme,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import type { SelectListTheme, SettingsListTheme } from "@earendil-works/pi-tui";

export interface MenuTheme {
  readonly settings: SettingsListTheme;
  readonly select: SelectListTheme;
  readonly title: (text: string) => string;
  readonly border: (text: string) => string;
  readonly hint: (text: string) => string;

  readonly fg: (color: ThemeColor, text: string) => string;
}

export function createMenuTheme(theme: Theme): MenuTheme {
  return {
    settings: getSettingsListTheme(),
    select: getSelectListTheme(),
    title: (text) => theme.bold(theme.fg("accent", text)),
    border: (text) => theme.fg("border", text),
    hint: (text) => theme.fg("dim", text),
    fg: (color, text) => theme.fg(color, text),
  };
}
