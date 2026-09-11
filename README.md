# pi-toolkit

pi-toolkit 把日常编码中会用到的工具聚合进一个 Pi 扩展包，当前包含视觉辅助、子代理编排、供应商用量、工作区与会话状态、外观五个模块，后续会继续加入 MCP 连接器等新能力。所有配置通过一个控制菜单完成，菜单的观感和操作方式与 Pi 原生 `/settings` 完全一致，支持英语、简体中文、繁体中文。

## 安装

```bash
pi install npm:@buyi1net/pi-toolkit
```

或从 GitHub 安装：

```bash
pi install git:github.com/buyi1net/pi-toolkit
```

安装后在 Pi TUI 输入 `/pi-toolkit` 打开控制菜单。

## 模块

五个模块都可以在菜单里（常规组与子代理组）独立开关，关闭的模块不注册任何工具和钩子。

**视觉辅助（来自 pi-eyes）**：为纯文本模型自动补充图片理解能力，原生多模态模型直接旁路。主模型可通过 `vision_query` 工具针对最近截图追问。切换视觉模型前会先跑一次探测自检，不通过则保持原选择。

**子代理编排（来自 pi-subagents）**：spawn、调度、回收子代理。自动任务默认 headless 后台进程，演示型任务用 herdr 或 tmux 分屏，结果自动回注主会话。支持 tier 模型路由（fast / balanced / deep）与团队协作。`ask_question` 让子代理在卡住时向主会话提问。

**供应商用量、工作区与会话状态、外观（来自 pi-tui，重构后拆为三个模块）**：编辑器状态边框、Header、项目状态 Footer、启动与 reload 转场、单轮遥测，附带 16 个主题。供应商余额与套餐查询需要凭据时读取 `~/.pi/agent/pi-tui.json`（该文件由你手工维护，插件只读）。

## 配置

菜单改动写入 `~/.pi/agent/pi-toolkit.json`。子代理的 tier 路由也可被环境变量 `PI_SUBAGENTS_CONFIG`、项目或全局的 `pi-subagents.json` 覆盖，优先级与 pi-subagents 一致。

视觉辅助的图像预处理依赖 sharp，属于可选依赖：只在视觉模块启用且首次处理图片时加载；缺失时会提示安装命令，不影响其它模块。

## 隐私与边界

视觉图片只发送给你配置的 Pi 视觉模型 provider。凭据文件 `pi-tui.json` 永远不被本插件写入。子代理进程与你共享同一台机器的权限，请只派发可信任务。

## 致谢

子代理编排模块源自 [amosblomqvist/pi-interactive-subagents](https://github.com/amosblomqvist/pi-interactive-subagents)（MIT），在原实现基础上完成了 herdr 表面适配与进程内裁剪。

## 开源协议

pi-toolkit 的自有代码以 MIT License 发布。
