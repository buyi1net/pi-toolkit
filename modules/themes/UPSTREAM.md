# 主题资源来源

本目录的主题分两部分：`@firstpick/pi-themes-bundle` 的固定快照，和为对齐 Herdr 内置主题而自维护的移植。

## 上游固定部分（16 份）

来自 `@firstpick/pi-themes-bundle` `0.1.6`，上游仓库为 [Firstp1ck/pi-coding-agent-forge](https://github.com/Firstp1ck/pi-coding-agent-forge/tree/main/pi-package-themes-bundle)，固定提交为 `239829d747deae4d9c0f039421ab29440f40f1a2`。许可证见 [LICENSE.pi-themes-bundle](./LICENSE.pi-themes-bundle)。

主题名称和终端调色板保持上游版本。`catppuccin-mocha.json` 与 `matrix.json` 去掉了上游 `export` 中的 `backgroundImage`、`backgroundOverlay`、`backgroundSize`、`backgroundPosition` 和 `backgroundRepeat`。这些字段供上游 WebUI 使用，不属于 Pi `0.84.2` 的 TUI 主题 Schema；删除后不改变终端配色。

## 自维护部分（5 份，对齐 Herdr 内置主题）

Herdr（终端多路复用器）内置主题族里有 5 个是上游 bundle 没有的：`kanagawa`、`kanagawa-lotus`、`vesper`、`tokyo-night-day`、`one-light`（已核对 `0.1.7`，主题集合与 `0.1.6` 相同）。为了让 pi 与 Herdr 的主题观感对齐，本插件按下表来源自行移植：

| 主题文件 | 调色板来源 | 固定版本 | 许可证 |
|---|---|---|---|
| `kanagawa.json` / `kanagawa-lotus.json` | [rebelot/kanagawa.nvim](https://github.com/rebelot/kanagawa.nvim) `lua/kanagawa/colors.lua`（Wave / Lotus 调色板） | `bb85e4bfc8d8`（2026-05-10） | MIT |
| `vesper.json` | [raunofreiberg/vesper](https://github.com/raunofreiberg/vesper) `themes/Vesper-dark-color-theme.json` | `9043f3849b77`（2026-03-16） | MIT |
| `tokyo-night-day.json` | [enkia/tokyo-night-vscode-theme](https://github.com/enkia/tokyo-night-vscode-theme) `themes/tokyo-night-light-color-theme.json` | `7c0f11eaef32`（2025-02-05） | MIT |
| `one-light.json` | [atom/one-light-syntax](https://github.com/atom/one-light-syntax) `styles/colors.less` + [atom/one-light-ui](https://github.com/atom/one-light-ui) `styles/ui-variables*.less`（仓库已归档，不再变动） | `d84579027410` / `a27bce35088e` | MIT |

移植约定：

- 色值一律取自上表来源的官方调色板，不自造颜色；`one-light.json` 的 `bgSelect`（`#e5e5e6`）与面板背景（`#eaebeb`）分别是 Atom 官方 `darken(@syntax-bg, 8%)`（语法选区）与 `darken(@ui-bg, 6%)`（UI level-3）的精确换算。
- 角色映射不逐字照搬编辑器语义（如 Atom 官方把 `variable` 映射为红色），而是沿用包内现有主题的角色惯例，与 `one-dark.json`、`tokyo-night.json` 家族对偶，保证 pi 内明暗变体切换时观感一致。
- Herdr 侧对应的浅色变体名（`catppuccin-latte`、`gruvbox-light` 等）与深色名（`gruvbox-dark` 等）在 pi 侧已有同名或对应主题；名称错位（Herdr `catppuccin`/`gruvbox`/`solarized` 对应 pi `catppuccin-mocha`/`gruvbox-dark`/`solarized-dark`，Herdr `terminal` 对应 pi 内置 `system`）由使用侧自行选择，不在主题文件内做别名。

## 更新纪律

更新任何主题前必须重新核对：上游固定版本（bundle 固定提交、自维护部分的固定 commit）、Pi 当前 Theme Schema 和本文件中的兼容改动，不能跟随浮动分支自动覆盖。自维护部分更新调色板时，同步更新本表的固定版本与日期。
