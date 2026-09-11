# 主题资源来源

本目录的 16 份主题来自 `@firstpick/pi-themes-bundle` `0.1.6`，上游仓库为 [Firstp1ck/pi-coding-agent-forge](https://github.com/Firstp1ck/pi-coding-agent-forge/tree/main/pi-package-themes-bundle)，固定提交为 `239829d747deae4d9c0f039421ab29440f40f1a2`。许可证见 [LICENSE.pi-themes-bundle](./LICENSE.pi-themes-bundle)。

主题名称和终端调色板保持上游版本。`catppuccin-mocha.json` 与 `matrix.json` 去掉了上游 `export` 中的 `backgroundImage`、`backgroundOverlay`、`backgroundSize`、`backgroundPosition` 和 `backgroundRepeat`。这些字段供上游 WebUI 使用，不属于 Pi `0.84.2` 的 TUI 主题 Schema；删除后不改变终端配色。

本插件直接交付这些主题，用户无需再安装 `@firstpick/pi-themes-bundle`。更新主题前必须重新核对上游固定版本、Pi 当前 Theme Schema 和本文件中的兼容改动，不能跟随浮动分支自动覆盖。
