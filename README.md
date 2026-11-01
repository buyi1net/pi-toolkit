# pi-toolkit

pi-toolkit 把日常编码中会用到的工具聚合进一个 Pi 扩展包，当前包含十个模块：视觉辅助、子代理编排、供应商查询、工作区与会话状态、模型与用量、电脑控制、会话发现与通讯、模型压缩、Skill 工具、外观，另附 21 个主题。常用配置集中在一个控制菜单里完成，菜单的观感和操作方式与 Pi 原生 `/settings` 完全一致，支持英语、简体中文、繁体中文。

## 安装

需要 Pi 1.3.0 或更高版本。

```bash
pi install git:github.com/buyi1net/pi-toolkit
```

安装后在 Pi TUI 输入 `/pi-toolkit` 打开控制菜单。

npm 上的 `@buyi1net/pi-toolkit` 只有旧版本，不含本版内容，暂不提供 npm 安装入口。

## 模块

关闭的模块不注册任何工具和钩子。

**视觉辅助（来自 pi-eyes）**：为纯文本模型自动补充图片理解能力，原生多模态模型直接旁路。主模型可通过 `vision_query` 工具针对最近截图追问。切换视觉模型前会先跑一次探测自检，不通过则保持原选择。

**子代理编排（来自 pi-subagents）**：spawn、调度、回收子代理，最多三层（根 → 子代理 → 孙代理）；用 `close_agent` 关闭不再需要的子代理并释放任务名，`followup_task` 续跑时沿用原 `agent_id`。自动任务默认 headless 后台进程，演示型任务用 herdr 或 tmux 分屏，结果自动回注主会话。`list_agents` 显示整棵代理树，可按规范任务路径前缀过滤；根会话可以直接打断或关闭孙代理：`close_agent` 会级联关闭后代并返回关掉了哪些，`interrupt_agent` 可以打断孙代理的当前轮。支持 tier 模型路由（fast / balanced / deep）与团队协作。`ask_question` 让子代理在卡住时向主会话提问；提问、终态和状态回送都带 `Message Type`／`Task name`／`Sender`／`Payload` 信封，父会话能直接看出是哪个子代理发来的。

**供应商查询、工作区与会话状态、外观（来自 pi-tui，重构后拆为三个模块）**：编辑器状态边框、Header、项目状态 Footer、启动与 reload 转场、单轮遥测，附带 21 个主题（16 个 pi-themes-bundle + 5 个对齐 Herdr 内置主题的自维护移植）。供应商余额与套餐查询需要凭据时读取 `~/.pi/agent/pi-tui.json`（该文件由你手工维护，插件只读）。

**模型与用量**：统计子代理候选池模型的用量，按当前、今日、本周、历史聚合，附候选模型的余额与健康状态；每次运行保留模型来源标签（按池选中、继承父会话、指定模型）。入口在「余额查询」二级页。

**电脑控制（pi-computer）**：让 Agent 看屏幕、认控件、动键鼠，把只在图形界面里能办的事办完。当前已接入的平台 helper 会随发布快照分发，模块按环境选择可用后端；缺少对应 helper 时如实报告不可用，不要求额外工具链，也不会阻断其它模块使用。macOS 与 Linux 后端持续完善中。

**会话发现与通讯**：扫描本机各项目的会话文件，并维护活实例的注册与心跳。`peers_list` 列出其他会话，`peers_send` 按会话短码、名字、会话 id（或唯一前缀）或实例 id 把消息投递给对方会话，对端以外部来源卡片显示，并标明这不是用户指令。正文超过阈值自动转文件传输并做哈希校验，入站有体积与速率上限。

**模型压缩**：按会话或按模型规则在三种模式之间选择——Pi 原生压缩、Codex（Responses API 的 checkpoint 压缩）、ACP（本地投影加 sidecar，不丢原文，可解压找回）。一级菜单「模型压缩」只管总开关，二级页改全局默认模式、原生触发策略、模型规则和 ACP 高级参数。Codex 只接管显式规则命中的模型；压缩失败时取消并保留原历史，不静默重试。

**Skill 工具**：提供 Claude Code 兼容的 `skill` 模型工具。模型按 skill 名称调用工具，工具从 Pi 已解析的 skill registry 取得准确路径，读取 `SKILL.md` 正文、返回相对路径基准和随附文件清单；名称必须精确匹配，路径逃逸和同名歧义会拒绝加载。

## 依赖

宿主依赖按 Pi 的扩展契约声明为 peer：`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui`、`@earendil-works/pi-ai`（均从 1.3.0 起）和 `typebox` 1.x（peer 写 `*` 是按 Pi 宿主契约由宿主提供；开发依赖固定 1.3.27）。正式运行依赖是 `acp-kernel` 0.0.98（ACP 压缩引擎，MIT）。`sharp` 是可选依赖，只在视觉模块首次处理图片时加载。

## 配置

菜单改动写入 `~/.pi/agent/pi-toolkit.json`。子代理的 tier 路由也可被环境变量 `PI_SUBAGENTS_CONFIG`、项目或全局的 `pi-subagents.json` 覆盖，优先级与 pi-subagents 一致。

视觉辅助的图像预处理依赖 sharp，属于可选依赖：只在视觉模块启用且首次处理图片时加载；缺失时会提示安装命令，不影响其它模块。

## 隐私与边界

视觉图片只发送给你配置的 Pi 视觉模型 provider。凭据文件 `pi-tui.json` 永远不被本插件写入。子代理进程与你共享同一台机器的权限，请只派发可信任务。电脑控制的动作都在本机执行，模块自身不访问外部服务；它读到的窗口与控件内容会像其它工具结果一样进入当前会话。会话通讯只走本机端点，转文件通道落在 `<agentDir>/cache/pi-toolkit/peers/files` 里，按存活期自动清理。

## 致谢

子代理编排模块源自 [amosblomqvist/pi-interactive-subagents](https://github.com/amosblomqvist/pi-interactive-subagents)（MIT），在原实现基础上完成了 herdr 表面适配与进程内裁剪。

模型压缩模块的 Codex 部分移植自 `@narumitw/pi-codex-compact`（MIT，上游仓库 [narumiruna/pi-extensions](https://github.com/narumiruna/pi-extensions)），ACP 部分参考 [billion-context-pi](https://github.com/ranxianglei/billion-context-pi)（MIT）；上游来源与许可证登记见快照内 `modules/compression/UPSTREAM.md`。

## 开源协议

pi-toolkit 的自有代码以 MIT License 发布。
