// 菜单主题：SettingsList / SelectList 用 pi 原生 get*Theme()，与原生 /settings 同色；
// 标题与边框用 ctx.ui.custom 回调里的主题实例显式上色（jiti 加载下不要依赖组件内部默认主题）。

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
  /** 模块自绘面板用：状态行按语义上色（success / error / warning / dim） */
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
