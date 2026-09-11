// pi-toolkit 三语键表与译者。
// 所有面向用户的文案（菜单、通知、提示行）都必须经这里取，组件里禁止硬编码字符串。
// 语言设置沿用 pi-eyes 的 auto 机制并扩展出繁体中文。

/** 实际生效的语言：三语键表各一份 */
export type ResolvedLanguage = "en" | "zh-CN" | "zh-TW";

/** 配置里保存的语言设置：auto 跟随系统语言 */
export type LanguageSetting = "auto" | ResolvedLanguage;

export const LANGUAGE_SETTINGS: readonly LanguageSetting[] = ["auto", "en", "zh-CN", "zh-TW"];

export interface ToolkitMessages {
  "command.description": string;
  "menu.title": string;
  "group.general": string;
  "group.general.description": string;
  "group.subagents": string;
  "group.subagents.description": string;
  /** {count}：分组内的行数 */
  "group.itemCount": string;
  "problem.config": string;
  "problem.module": string;
  /** {label}：{source} — {detail} */
  "problem.summary": string;
  "language.label": string;
  "language.description": string;
  "language.auto": string;
  "language.en": string;
  "language.zhCN": string;
  "language.zhTW": string;
  /** {language}：auto 解析后的实际语言名 */
  "language.autoResolved": string;
  "common.on": string;
  "common.off": string;
  "common.current": string;
  "hint.change": string;
  "hint.search": string;
  "hint.noSettings": string;
  "hint.noMatch": string;
  "hint.chooseOptions": string;
  "hint.back": string;
  "hint.cancel": string;
  /** {language} */
  "notify.languageChanged": string;
  /** {reason} */
  "notify.saveFailed": string;
  /** {module} */
  "notify.moduleTogglePending": string;
  "notify.nonInteractive": string;
  "module.tui.label": string;
  "module.tui.description": string;
  "module.tui.enabled.label": string;
  "module.tui.enabled.description": string;
  "module.tui.menu.label": string;
  "module.tui.menu.description": string;
  /** {editor} {header} {footer}：三个常驻 UI 开关的显示值 */
  "module.tui.menu.value": string;
  "module.tui.editor.label": string;
  "module.tui.editor.description": string;
  "module.tui.header.label": string;
  "module.tui.header.description": string;
  "module.tui.footer.label": string;
  "module.tui.footer.description": string;
  "module.tui.spinner.label": string;
  "module.tui.spinner.description": string;
  "module.tui.spinner.default": string;
  "module.tui.spinner.static": string;
  "module.tui.spinner.hidden": string;
  "module.tui.preset.label": string;
  "module.tui.preset.description": string;
  "module.tui.preset.minimal": string;
  "module.tui.preset.default": string;
  "module.tui.preset.full": string;
  "module.tui.refresh.label": string;
  "module.tui.refresh.description": string;
  "module.tui.refresh.30": string;
  "module.tui.refresh.60": string;
  "module.tui.refresh.120": string;
  "module.tui.refresh.300": string;
  "module.tui.telemetry.label": string;
  "module.tui.telemetry.description": string;
  "module.tui.providerAccess.label": string;
  "module.tui.providerAccess.description": string;
  "module.tui.providerAccess.configured": string;
  "module.tui.providerAccess.missing": string;
  "module.tui.packageOrder.notice": string;
  "module.eyes.label": string;
  "module.eyes.description": string;
  "module.eyes.enabled.label": string;
  "module.eyes.enabled.description": string;
  "module.eyes.route.label": string;
  "module.eyes.route.description": string;
  "module.eyes.route.auto": string;
  "module.eyes.route.off": string;
  /** {model} */
  "module.eyes.route.fixed": string;
  "module.eyes.menu.label": string;
  "module.eyes.menu.description": string;
  "module.eyes.model.label": string;
  "module.eyes.model.description": string;
  "module.eyes.model.auto": string;
  "module.eyes.model.autoDescription": string;
  "module.eyes.model.off": string;
  "module.eyes.model.offDescription": string;
  "module.eyes.model.authenticated": string;
  "module.eyes.model.noAuthRequired": string;
  "module.eyes.model.unavailable": string;
  "module.eyes.model.empty": string;
  "module.eyes.refresh.label": string;
  "module.eyes.refresh.description": string;
  /** {count}：候选模型数 */
  "module.eyes.refresh.value": string;
  "module.eyes.refresh.running": string;
  "module.eyes.refresh.complete": string;
  /** {reason} */
  "module.eyes.refresh.failed": string;
  "module.eyes.check.label": string;
  "module.eyes.check.description": string;
  "module.eyes.check.value": string;
  "module.eyes.check.running": string;
  /** {elapsed}：耗时毫秒 */
  "module.eyes.check.passed": string;
  /** {reason} */
  "module.eyes.check.failed": string;
  "module.eyes.check.noRoute": string;
  "module.eyes.check.noModel": string;
  /** {model} */
  "module.eyes.probe.running": string;
  /** {model} {matched}/{total} {response} */
  "module.eyes.probe.passed": string;
  /** {model} {matched}/{total} {reason} */
  "module.eyes.probe.failed": string;
  "module.eyes.probe.unchanged": string;
  "module.eyes.save.running": string;
  /** {reason} */
  "module.eyes.save.failed": string;
  "module.eyes.save.modelsChanged": string;
  "module.eyes.running": string;
  "module.eyes.cancelled": string;
  /** {field} */
  "module.eyes.configError.notObject": string;
  /** {field} */
  "module.eyes.configError.notNonEmptyString": string;
  /** {field} */
  "module.eyes.configError.badMode": string;
  /** {field} */
  "module.eyes.configError.allowedModelsNotArray": string;
  /** {field} */
  "module.eyes.configError.fixedRequired": string;
  /** {command}：sharp 安装命令 */
  "module.eyes.sharpMissing": string;
  /** {index}：图片序号，从 1 起 */
  "module.eyes.imageError.empty": string;
  /** {index}：图片序号，从 1 起；{mediaType} */
  "module.eyes.imageError.unsupportedMime": string;
  /** {index} */
  "module.eyes.imageError.invalidBase64": string;
  /** {index} */
  "module.eyes.imageError.corruptBase64": string;
  /** {bytes} */
  "module.eyes.imageError.tooLarge": string;
  /** {reason} */
  "module.eyes.imageError.decodeFailed": string;
  /** {bytes} */
  "module.eyes.imageError.totalTooLarge": string;
  /** {reason} */
  "module.eyes.injectPreprocessFailed": string;
  "module.eyes.injectUnavailable": string;
  "module.eyes.queryEmpty": string;
  "module.eyes.queryNoImage": string;
  "module.eyes.queryFailed": string;
  "module.subagents.label": string;
  "module.subagents.description": string;
  "module.subagents.enabled.label": string;
  "module.subagents.enabled.description": string;
  "module.subagents.menu.label": string;
  "module.subagents.menu.description": string;
  /** {configured}/{total}：已配置的档位数与总档位数 */
  "module.subagents.menu.value": string;
  "module.subagents.status.label": string;
  "module.subagents.status.description": string;
  /** {tier}：fast / balanced / deep */
  "module.subagents.tier.label": string;
  /** {tier} */
  "module.subagents.tier.description": string;
  "module.subagents.tier.unmapped": string;
  "module.subagents.tier.authenticated": string;
  "module.subagents.tier.noAuthRequired": string;
  "module.subagents.route.label": string;
  "module.subagents.route.description": string;
}

export type MessageKey = keyof ToolkitMessages;
export type MessageVars = Record<string, string | number>;
/** 取当前语言文案；{name} 占位符由 vars 替换 */
export type Translator = (key: MessageKey, vars?: MessageVars) => string;

const EN: ToolkitMessages = {
  "command.description": "Open the pi-toolkit control panel",
  "menu.title": "pi-toolkit",
  "group.general": "General",
  "group.general.description": "Language and general module settings",
  "group.subagents": "Subagents",
  "group.subagents.description": "Subagent tooling: tier model routing and the status widget",
  "group.itemCount": "{count} items",
  "problem.config": "Config file problem",
  "problem.module": "Module failed to load",
  /** {label}：{source} — {detail} */
  "problem.summary": "{label}: {source} — {detail}",
  "language.label": "Language",
  "language.description": "Language used by the pi-toolkit menus",
  "language.auto": "Auto",
  "language.en": "English",
  "language.zhCN": "简体中文",
  "language.zhTW": "繁體中文",
  "language.autoResolved": "Follow the system language; currently {language}",
  "common.on": "On",
  "common.off": "Off",
  "common.current": "Current",
  "hint.change": "  Enter/Space to change · Esc to go back",
  "hint.search": "  Type to search · Enter/Space to change · Esc to go back",
  "hint.noSettings": "  No settings available",
  "hint.noMatch": "  No matching settings",
  "hint.chooseOptions": "  ↑↓ select · Enter confirm · Esc go back",
  "hint.back": "  Esc to go back",
  "hint.cancel": "  Esc to cancel",
  "notify.languageChanged": "Language switched to {language}",
  "notify.saveFailed": "{reason}",
  "notify.moduleTogglePending": "{module} saved; reload pi to apply it",
  "notify.nonInteractive": "/pi-toolkit needs the pi TUI; nothing was changed",
  "module.tui.label": "Appearance & status",
  "module.tui.description": "Editor border, header, footer, spinner, status preset and provider data",
  "module.tui.enabled.label": "Enable appearance & status",
  "module.tui.enabled.description": "When off, the editor, header, footer, working indicator and all 15 event hooks are not installed (reload to apply)",
  "module.tui.menu.label": "Appearance settings",
  "module.tui.menu.description": "Editor border, header, footer, spinner, status data and provider credentials",
  "module.tui.menu.value": "Editor {editor} · Header {header} · Footer {footer}",
  "module.tui.editor.label": "Editor border status",
  "module.tui.editor.description": "Show status segments on the editor frame",
  "module.tui.header.label": "Header",
  "module.tui.header.description": "Show version, model and working directory above the editor",
  "module.tui.footer.label": "Footer status bar",
  "module.tui.footer.description": "Show session and project status below the editor; off leaves the host footer untouched",
  "module.tui.spinner.label": "Working indicator",
  "module.tui.spinner.description": "Animation shown while the agent is working",
  "module.tui.spinner.default": "Default animation",
  "module.tui.spinner.static": "Static dot",
  "module.tui.spinner.hidden": "Hidden",
  "module.tui.preset.label": "Status preset",
  "module.tui.preset.description": "Which status segments are shown",
  "module.tui.preset.minimal": "Minimal",
  "module.tui.preset.default": "Default",
  "module.tui.preset.full": "Full",
  "module.tui.refresh.label": "Balance refresh interval",
  "module.tui.refresh.description": "How often provider balance/quota data is queried",
  "module.tui.refresh.30": "30 seconds",
  "module.tui.refresh.60": "1 minute",
  "module.tui.refresh.120": "2 minutes",
  "module.tui.refresh.300": "5 minutes",
  "module.tui.telemetry.label": "Reply telemetry",
  "module.tui.telemetry.description": "Record per-reply timing and token usage entries",
  "module.tui.providerAccess.label": "Provider credentials",
  "module.tui.providerAccess.description": "Read-only: kept in the standalone file",
  "module.tui.providerAccess.configured": "Configured",
  "module.tui.providerAccess.missing": "Not configured",
  "module.tui.packageOrder.notice": "pi-toolkit was moved to the front of the startup package list; restart Pi to apply",
  "module.eyes.label": "Vision assistance",
  "module.eyes.description": "Gives text-only models image understanding through an auxiliary vision model",
  "module.eyes.enabled.label": "Enable vision assistance",
  "module.eyes.enabled.description": "When off, image context injection and the vision_query tool are not registered (reload to apply)",
  "module.eyes.route.label": "Vision model routing",
  "module.eyes.route.description": "The active vision route (read-only)",
  "module.eyes.route.auto": "auto — pick an available vision model",
  "module.eyes.route.off": "off — no vision model",
  "module.eyes.route.fixed": "fixed — {model}",
  "module.eyes.menu.label": "Vision settings",
  "module.eyes.menu.description": "Choose the vision model, refresh the catalogue and run a self-check",
  "module.eyes.model.label": "Vision model",
  "module.eyes.model.description": "A real image probe runs on the candidate before the change sticks",
  "module.eyes.model.auto": "auto — Select automatically",
  "module.eyes.model.autoDescription": "Pick from Pi's currently available vision models.",
  "module.eyes.model.off": "off — Use no vision model",
  "module.eyes.model.offDescription": "Turn vision assistance off; no vision model is called.",
  "module.eyes.model.authenticated": "authenticated",
  "module.eyes.model.noAuthRequired": "no authentication required",
  "module.eyes.model.unavailable": "currently unavailable",
  "module.eyes.model.empty": "No vision model is currently available.",
  "module.eyes.refresh.label": "Refresh model catalogue",
  "module.eyes.refresh.description": "Re-read Pi's model catalogue without using the network",
  "module.eyes.refresh.value": "{count} candidates",
  "module.eyes.refresh.running": "Refreshing Pi's model catalogue…",
  "module.eyes.refresh.complete": "Pi's model catalogue was refreshed.",
  "module.eyes.refresh.failed": "Could not refresh models: {reason}",
  "module.eyes.check.label": "Run self-check",
  "module.eyes.check.description": "Send a 6-cell colour probe to verify the active vision route",
  "module.eyes.check.value": "Not run yet",
  "module.eyes.check.running": "Testing the vision model…",
  "module.eyes.check.passed": "Vision model OK · {elapsed} ms",
  "module.eyes.check.failed": "Vision model failed: {reason}",
  "module.eyes.check.noRoute": "No vision route is available to test.",
  "module.eyes.check.noModel": "No vision model is available to test.",
  "module.eyes.probe.running": "Probing {model}…",
  "module.eyes.probe.passed": "{model} passed the probe ({matched}/{total}); response: {response}",
  "module.eyes.probe.failed": "{model} failed the probe ({matched}/{total}): {reason}",
  "module.eyes.probe.unchanged": "The previous setting remains active.",
  "module.eyes.save.running": "Saving…",
  "module.eyes.save.failed": "Save failed; the previous setting remains active: {reason}",
  "module.eyes.save.modelsChanged": "Pi's available models changed; this selection was not saved. Choose again.",
  "module.eyes.running": "Working…",
  "module.eyes.cancelled": "Cancelled.",
  "module.eyes.configError.notObject": "{field} must be an object",
  "module.eyes.configError.notNonEmptyString": "{field} must be a non-empty string",
  "module.eyes.configError.badMode": "{field} must be \"automatic\" or \"fixed\"",
  "module.eyes.configError.allowedModelsNotArray": "{field} must be an array or null",
  "module.eyes.configError.fixedRequired": "fixed routing requires {field}",
  "module.eyes.sharpMissing": "Image preprocessing needs the optional dependency sharp, which is not installed. Run `{command}` in your pi extension install directory (or reinstall pi-toolkit with optional dependencies), then reload pi.",
  "module.eyes.imageError.empty": "Image {index} is empty",
  "module.eyes.imageError.unsupportedMime": "Image {index} has an unsupported MIME type: {mediaType}",
  "module.eyes.imageError.invalidBase64": "Image {index} has invalid base64 data",
  "module.eyes.imageError.corruptBase64": "Image {index} has empty or corrupted base64 data",
  "module.eyes.imageError.tooLarge": "The image still exceeds the {bytes} byte limit after compression",
  "module.eyes.imageError.decodeFailed": "The image could not be decoded or compressed: {reason}",
  "module.eyes.imageError.totalTooLarge": "The images exceed the {bytes} byte total limit",
  "module.eyes.injectPreprocessFailed": "Vision assistance could not process this image: {reason}",
  "module.eyes.injectUnavailable": "Vision assistance could not read the image reliably; do not guess image content.",
  "module.eyes.queryEmpty": "The vision question must not be empty.",
  "module.eyes.queryNoImage": "This session has no recent screenshot to ask about; call computer_screenshot first.",
  "module.eyes.queryFailed": "The auxiliary vision model could not answer this targeted question reliably; do not guess image content.",
  "module.subagents.label": "Subagents",
  "module.subagents.description": "Spawn, steer and stop sub-agents that run tasks in separate pi processes",
  "module.subagents.enabled.label": "Enable subagents",
  "module.subagents.enabled.description": "When off, the subagent tools, message renderers, status widget and hooks are not registered (reload to apply)",
  "module.subagents.menu.label": "Subagent settings",
  "module.subagents.menu.description": "Tier model routing and the status widget toggle",
  "module.subagents.menu.value": "{configured}/{total} tiers mapped",
  "module.subagents.status.label": "Status widget",
  "module.subagents.status.description": "Show the status widget while sub-agents run (falls back to the bundled config when unset here)",
  "module.subagents.tier.label": "{tier} tier model",
  "module.subagents.tier.description": "Model used when a subagent asks for tier \"{tier}\"",
  "module.subagents.tier.unmapped": "Not mapped",
  "module.subagents.tier.authenticated": "authenticated",
  "module.subagents.tier.noAuthRequired": "no authentication configured",
  "module.subagents.route.label": "Tier routing",
  "module.subagents.route.description": "The tier routing resolved by the six-level config chain (read-only)",
};

const ZH_CN: ToolkitMessages = {
  "command.description": "打开 pi-toolkit 控制菜单",
  "menu.title": "pi-toolkit",
  "group.general": "常规",
  "group.general.description": "语言与常规模块设置",
  "group.subagents": "子代理",
  "group.subagents.description": "子代理能力：tier 模型路由与状态显示",
  "group.itemCount": "{count} 项",
  "problem.config": "配置文件异常",
  "problem.module": "模块装载失败",
  "problem.summary": "{label}：{source} — {detail}",
  "language.label": "界面语言",
  "language.description": "pi-toolkit 菜单使用的界面语言",
  "language.auto": "自动",
  "language.en": "English",
  "language.zhCN": "简体中文",
  "language.zhTW": "繁體中文",
  "language.autoResolved": "跟随系统语言，当前为{language}",
  "common.on": "开",
  "common.off": "关",
  "common.current": "当前",
  "hint.change": "  Enter/空格 修改 · Esc 返回上级",
  "hint.search": "  输入以搜索 · Enter/空格 修改 · Esc 返回上级",
  "hint.noSettings": "  暂无可配置项",
  "hint.noMatch": "  没有匹配的配置项",
  "hint.chooseOptions": "  ↑↓ 选择 · Enter 确认 · Esc 返回",
  "hint.back": "  Esc 返回上级",
  "hint.cancel": "  Esc 取消",
  "notify.languageChanged": "界面语言已切换为{language}",
  "notify.saveFailed": "{reason}",
  "notify.moduleTogglePending": "{module} 已保存；重载 pi 后生效",
  "notify.nonInteractive": "/pi-toolkit 只能在 pi TUI 中使用；本次没有改动配置",
  "module.tui.label": "外观与状态",
  "module.tui.description": "编辑器边框、Header、底部栏、Spinner、状态预设与供应商数据",
  "module.tui.enabled.label": "启用外观与状态",
  "module.tui.enabled.description": "关闭后不安装编辑器、Header、底部栏、工作指示动画与全部 15 个事件钩子（重载 pi 后生效）",
  "module.tui.menu.label": "外观配置",
  "module.tui.menu.description": "编辑器边框、Header、底部栏、Spinner、状态数据与供应商凭据",
  "module.tui.menu.value": "编辑器{editor} · Header{header} · 底部栏{footer}",
  "module.tui.editor.label": "编辑器边框状态",
  "module.tui.editor.description": "在编辑器边框上显示状态分段",
  "module.tui.header.label": "顶部信息栏",
  "module.tui.header.description": "在编辑器上方显示版本、模型与工作目录",
  "module.tui.footer.label": "底部状态栏",
  "module.tui.footer.description": "在编辑器下方显示会话与项目状态；关闭后不动宿主默认底部栏",
  "module.tui.spinner.label": "工作指示动画",
  "module.tui.spinner.description": "代理工作期间显示的动画",
  "module.tui.spinner.default": "默认动画",
  "module.tui.spinner.static": "静态圆点",
  "module.tui.spinner.hidden": "隐藏",
  "module.tui.preset.label": "状态预设",
  "module.tui.preset.description": "显示哪些状态分段",
  "module.tui.preset.minimal": "精简",
  "module.tui.preset.default": "默认",
  "module.tui.preset.full": "完整",
  "module.tui.refresh.label": "余额刷新间隔",
  "module.tui.refresh.description": "供应商余额/套餐数据的查询频率",
  "module.tui.refresh.30": "30 秒",
  "module.tui.refresh.60": "1 分钟",
  "module.tui.refresh.120": "2 分钟",
  "module.tui.refresh.300": "5 分钟",
  "module.tui.telemetry.label": "回复遥测",
  "module.tui.telemetry.description": "记录每次回复的耗时与 token 用量条目",
  "module.tui.providerAccess.label": "供应商凭据",
  "module.tui.providerAccess.description": "只读：保存在独立文件",
  "module.tui.providerAccess.configured": "已配置",
  "module.tui.providerAccess.missing": "未配置",
  "module.tui.packageOrder.notice": "已将 pi-toolkit 调整到启动首位，重启 Pi 后生效",
  "module.eyes.label": "视觉辅助",
  "module.eyes.description": "用辅助视觉模型让纯文本模型也能理解图片",
  "module.eyes.enabled.label": "启用视觉辅助",
  "module.eyes.enabled.description": "关闭后不再注入图片上下文、不注册 vision_query 工具（重载 pi 后生效）",
  "module.eyes.route.label": "视觉模型路由",
  "module.eyes.route.description": "当前生效的视觉路由（只读）",
  "module.eyes.route.auto": "auto — 自动选择可用视觉模型",
  "module.eyes.route.off": "off — 不使用视觉模型",
  "module.eyes.route.fixed": "fixed — {model}",
  "module.eyes.menu.label": "视觉配置",
  "module.eyes.menu.description": "选择视觉模型、刷新模型目录并运行自检",
  "module.eyes.model.label": "视觉模型",
  "module.eyes.model.description": "更改前会先对候选模型跑一次真实图片探测，通过才生效",
  "module.eyes.model.auto": "auto — 自动选择",
  "module.eyes.model.autoDescription": "从当前可用的视觉模型中自动选择。",
  "module.eyes.model.off": "off — 不使用视觉模型",
  "module.eyes.model.offDescription": "关闭视觉辅助，不调用任何视觉模型。",
  "module.eyes.model.authenticated": "已认证",
  "module.eyes.model.noAuthRequired": "无需认证",
  "module.eyes.model.unavailable": "当前不可用",
  "module.eyes.model.empty": "当前没有可用的视觉模型。",
  "module.eyes.refresh.label": "刷新模型目录",
  "module.eyes.refresh.description": "重新读取 Pi 的模型目录，不联网",
  "module.eyes.refresh.value": "{count} 个候选模型",
  "module.eyes.refresh.running": "正在刷新 Pi 模型目录……",
  "module.eyes.refresh.complete": "Pi 模型目录已刷新。",
  "module.eyes.refresh.failed": "刷新模型失败：{reason}",
  "module.eyes.check.label": "运行自检",
  "module.eyes.check.description": "发一张 6 格彩色图验证当前视觉路由",
  "module.eyes.check.value": "尚未运行",
  "module.eyes.check.running": "正在检测视觉模型……",
  "module.eyes.check.passed": "视觉模型正常 · {elapsed} ms",
  "module.eyes.check.failed": "视觉模型异常：{reason}",
  "module.eyes.check.noRoute": "当前没有可检测的视觉路径。",
  "module.eyes.check.noModel": "当前没有可检测的视觉模型。",
  "module.eyes.probe.running": "正在探测 {model}……",
  "module.eyes.probe.passed": "{model} 探测通过（{matched}/{total}）；返回值：{response}",
  "module.eyes.probe.failed": "{model} 探测未通过（{matched}/{total}）：{reason}",
  "module.eyes.probe.unchanged": "原设置保持不变。",
  "module.eyes.save.running": "正在保存……",
  "module.eyes.save.failed": "保存失败，原设置保持不变：{reason}",
  "module.eyes.save.modelsChanged": "Pi 可用模型已经变化，本次选择未保存，请重新选择。",
  "module.eyes.running": "处理中……",
  "module.eyes.cancelled": "操作已取消。",
  "module.eyes.configError.notObject": "{field} 必须是对象",
  "module.eyes.configError.notNonEmptyString": "{field} 必须是非空字符串",
  "module.eyes.configError.badMode": "{field} 必须是 \"automatic\" 或 \"fixed\"",
  "module.eyes.configError.allowedModelsNotArray": "{field} 必须是数组或 null",
  "module.eyes.configError.fixedRequired": "fixed 路由必须指定 {field}",
  "module.eyes.sharpMissing": "图片预处理需要可选依赖 sharp，当前未安装。请在 pi 扩展安装目录执行 `{command}`（或重装 pi-toolkit 并保留可选依赖），然后重载 pi。",
  "module.eyes.imageError.empty": "第 {index} 张图片为空",
  "module.eyes.imageError.unsupportedMime": "第 {index} 张图片的 MIME 类型不受支持：{mediaType}",
  "module.eyes.imageError.invalidBase64": "第 {index} 张图片的 base64 数据格式无效",
  "module.eyes.imageError.corruptBase64": "第 {index} 张图片的 base64 数据为空或损坏",
  "module.eyes.imageError.tooLarge": "图片压缩后仍超过 {bytes} 字节限制",
  "module.eyes.imageError.decodeFailed": "图片无法解码或压缩：{reason}",
  "module.eyes.imageError.totalTooLarge": "图片总大小超过 {bytes} 字节限制",
  "module.eyes.injectPreprocessFailed": "视觉辅助无法处理本次图片：{reason}",
  "module.eyes.injectUnavailable": "视觉辅助未能可靠读取图片，禁止根据图片内容猜测。",
  "module.eyes.queryEmpty": "视觉询问不能为空。",
  "module.eyes.queryNoImage": "当前会话没有可供视觉询问的最近截图，请先调用 computer_screenshot。",
  "module.eyes.queryFailed": "辅助视觉模型未能可靠回答本次定向问题，禁止根据图片内容猜测。",
  "module.subagents.label": "子代理",
  "module.subagents.description": "在独立 pi 进程中启动、干预并停止执行任务的子代理",
  "module.subagents.enabled.label": "启用子代理",
  "module.subagents.enabled.description": "关闭后不注册子代理工具、消息渲染器、状态 widget 与钩子（重载 pi 后生效）",
  "module.subagents.menu.label": "子代理配置",
  "module.subagents.menu.description": "tier 模型路由与状态显示开关",
  "module.subagents.menu.value": "{configured}/{total} 档已配置",
  "module.subagents.status.label": "状态显示",
  "module.subagents.status.description": "子代理运行期间显示状态 widget（此处未设置时回落包内配置）",
  "module.subagents.tier.label": "{tier} 档模型",
  "module.subagents.tier.description": "子代理请求 tier \"{tier}\" 时使用的模型",
  "module.subagents.tier.unmapped": "未配置",
  "module.subagents.tier.authenticated": "已认证",
  "module.subagents.tier.noAuthRequired": "未配置认证",
  "module.subagents.route.label": "tier 路由状态",
  "module.subagents.route.description": "六级配置链解析出的 tier 路由（只读）",
};

const ZH_TW: ToolkitMessages = {
  "command.description": "開啟 pi-toolkit 控制選單",
  "menu.title": "pi-toolkit",
  "group.general": "一般",
  "group.general.description": "語言與一般模組設定",
  "group.subagents": "子代理",
  "group.subagents.description": "子代理能力：tier 模型路由與狀態顯示",
  "group.itemCount": "{count} 項",
  "problem.config": "設定檔異常",
  "problem.module": "模組載入失敗",
  "problem.summary": "{label}：{source} — {detail}",
  "language.label": "介面語言",
  "language.description": "pi-toolkit 選單使用的介面語言",
  "language.auto": "自動",
  "language.en": "English",
  "language.zhCN": "简体中文",
  "language.zhTW": "繁體中文",
  "language.autoResolved": "跟隨系統語言，目前為{language}",
  "common.on": "開",
  "common.off": "關",
  "common.current": "目前",
  "hint.change": "  Enter/空白鍵 修改 · Esc 返回上層",
  "hint.search": "  輸入以搜尋 · Enter/空白鍵 修改 · Esc 返回上層",
  "hint.noSettings": "  尚無可設定項目",
  "hint.noMatch": "  沒有符合的設定項目",
  "hint.chooseOptions": "  ↑↓ 選擇 · Enter 確認 · Esc 返回",
  "hint.back": "  Esc 返回上層",
  "hint.cancel": "  Esc 取消",
  "notify.languageChanged": "介面語言已切換為{language}",
  "notify.saveFailed": "{reason}",
  "notify.moduleTogglePending": "{module} 已儲存；重新載入 pi 後生效",
  "notify.nonInteractive": "/pi-toolkit 只能在 pi TUI 中使用；本次沒有變更設定",
  "module.tui.label": "外觀與狀態",
  "module.tui.description": "編輯器邊框、Header、底部列、Spinner、狀態預設與供應商資料",
  "module.tui.enabled.label": "啟用外觀與狀態",
  "module.tui.enabled.description": "關閉後不安裝編輯器、Header、底部列、工作指示動畫與全部 15 個事件鉤子（重新載入 pi 後生效）",
  "module.tui.menu.label": "外觀設定",
  "module.tui.menu.description": "編輯器邊框、Header、底部列、Spinner、狀態資料與供應商憑證",
  "module.tui.menu.value": "編輯器{editor} · Header{header} · 底部列{footer}",
  "module.tui.editor.label": "編輯器邊框狀態",
  "module.tui.editor.description": "在編輯器邊框上顯示狀態分段",
  "module.tui.header.label": "頂部資訊列",
  "module.tui.header.description": "在編輯器上方顯示版本、模型與工作目錄",
  "module.tui.footer.label": "底部狀態列",
  "module.tui.footer.description": "在編輯器下方顯示工作階段與專案狀態；關閉後不動宿主預設底部列",
  "module.tui.spinner.label": "工作指示動畫",
  "module.tui.spinner.description": "代理工作期間顯示的動畫",
  "module.tui.spinner.default": "預設動畫",
  "module.tui.spinner.static": "靜態圓點",
  "module.tui.spinner.hidden": "隱藏",
  "module.tui.preset.label": "狀態預設",
  "module.tui.preset.description": "顯示哪些狀態分段",
  "module.tui.preset.minimal": "精簡",
  "module.tui.preset.default": "預設",
  "module.tui.preset.full": "完整",
  "module.tui.refresh.label": "餘額重新整理間隔",
  "module.tui.refresh.description": "供應商餘額/套餐資料的查詢頻率",
  "module.tui.refresh.30": "30 秒",
  "module.tui.refresh.60": "1 分鐘",
  "module.tui.refresh.120": "2 分鐘",
  "module.tui.refresh.300": "5 分鐘",
  "module.tui.telemetry.label": "回覆遙測",
  "module.tui.telemetry.description": "記錄每次回覆的耗時與 token 用量條目",
  "module.tui.providerAccess.label": "供應商憑證",
  "module.tui.providerAccess.description": "唯讀：保存在獨立檔案",
  "module.tui.providerAccess.configured": "已設定",
  "module.tui.providerAccess.missing": "未設定",
  "module.tui.packageOrder.notice": "已將 pi-toolkit 調整到啟動首位，重新載入 Pi 後生效",
  "module.eyes.label": "視覺輔助",
  "module.eyes.description": "用輔助視覺模型讓純文字模型也能理解圖片",
  "module.eyes.enabled.label": "啟用視覺輔助",
  "module.eyes.enabled.description": "關閉後不再注入圖片脈絡、不註冊 vision_query 工具（重新載入 pi 後生效）",
  "module.eyes.route.label": "視覺模型路由",
  "module.eyes.route.description": "目前生效的視覺路由（僅供檢視）",
  "module.eyes.route.auto": "auto — 自動選擇可用視覺模型",
  "module.eyes.route.off": "off — 不使用視覺模型",
  "module.eyes.route.fixed": "fixed — {model}",
  "module.eyes.menu.label": "視覺設定",
  "module.eyes.menu.description": "選擇視覺模型、重新整理模型目錄並執行自我檢查",
  "module.eyes.model.label": "視覺模型",
  "module.eyes.model.description": "變更前會先對候選模型執行一次真實圖片探測，通過才生效",
  "module.eyes.model.auto": "auto — 自動選擇",
  "module.eyes.model.autoDescription": "從目前可用的視覺模型中自動選擇。",
  "module.eyes.model.off": "off — 不使用視覺模型",
  "module.eyes.model.offDescription": "關閉視覺輔助，不呼叫任何視覺模型。",
  "module.eyes.model.authenticated": "已認證",
  "module.eyes.model.noAuthRequired": "無需認證",
  "module.eyes.model.unavailable": "目前無法使用",
  "module.eyes.model.empty": "目前沒有可用的視覺模型。",
  "module.eyes.refresh.label": "重新整理模型目錄",
  "module.eyes.refresh.description": "重新讀取 Pi 的模型目錄，不連網",
  "module.eyes.refresh.value": "{count} 個候選模型",
  "module.eyes.refresh.running": "正在重新整理 Pi 模型目錄……",
  "module.eyes.refresh.complete": "Pi 模型目錄已重新整理。",
  "module.eyes.refresh.failed": "重新整理模型失敗：{reason}",
  "module.eyes.check.label": "執行自我檢查",
  "module.eyes.check.description": "送出 6 格彩色圖驗證目前的視覺路由",
  "module.eyes.check.value": "尚未執行",
  "module.eyes.check.running": "正在檢測視覺模型……",
  "module.eyes.check.passed": "視覺模型正常 · {elapsed} ms",
  "module.eyes.check.failed": "視覺模型異常：{reason}",
  "module.eyes.check.noRoute": "目前沒有可檢測的視覺路徑。",
  "module.eyes.check.noModel": "目前沒有可檢測的視覺模型。",
  "module.eyes.probe.running": "正在探測 {model}……",
  "module.eyes.probe.passed": "{model} 探測通過（{matched}/{total}）；傳回值：{response}",
  "module.eyes.probe.failed": "{model} 探測未通過（{matched}/{total}）：{reason}",
  "module.eyes.probe.unchanged": "原設定保持不變。",
  "module.eyes.save.running": "正在儲存……",
  "module.eyes.save.failed": "儲存失敗，原設定保持不變：{reason}",
  "module.eyes.save.modelsChanged": "Pi 可用模型已變更，本次選擇未儲存，請重新選擇。",
  "module.eyes.running": "處理中……",
  "module.eyes.cancelled": "操作已取消。",
  "module.eyes.configError.notObject": "{field} 必須是物件",
  "module.eyes.configError.notNonEmptyString": "{field} 必須是非空字串",
  "module.eyes.configError.badMode": "{field} 必須是 \"automatic\" 或 \"fixed\"",
  "module.eyes.configError.allowedModelsNotArray": "{field} 必須是陣列或 null",
  "module.eyes.configError.fixedRequired": "fixed 路由必須指定 {field}",
  "module.eyes.sharpMissing": "圖片前置處理需要可選相依套件 sharp，目前未安裝。請在 pi 擴充套件安裝目錄執行 `{command}`（或重新安裝 pi-toolkit 並保留可選相依套件），然後重新載入 pi。",
  "module.eyes.imageError.empty": "第 {index} 張圖片為空",
  "module.eyes.imageError.unsupportedMime": "第 {index} 張圖片的 MIME 類型不受支援：{mediaType}",
  "module.eyes.imageError.invalidBase64": "第 {index} 張圖片的 base64 資料格式無效",
  "module.eyes.imageError.corruptBase64": "第 {index} 張圖片的 base64 資料為空或損毀",
  "module.eyes.imageError.tooLarge": "圖片壓縮後仍超過 {bytes} 位元組限制",
  "module.eyes.imageError.decodeFailed": "圖片無法解碼或壓縮：{reason}",
  "module.eyes.imageError.totalTooLarge": "圖片總大小超過 {bytes} 位元組限制",
  "module.eyes.injectPreprocessFailed": "視覺輔助無法處理本次圖片：{reason}",
  "module.eyes.injectUnavailable": "視覺輔助無法可靠讀取圖片，禁止依圖片內容猜測。",
  "module.eyes.queryEmpty": "視覺詢問不能為空。",
  "module.eyes.queryNoImage": "目前工作階段沒有可供視覺詢問的最近截圖，請先呼叫 computer_screenshot。",
  "module.eyes.queryFailed": "輔助視覺模型未能可靠回答本次指定問題，禁止依圖片內容猜測。",
  "module.subagents.label": "子代理",
  "module.subagents.description": "在獨立 pi 過程中啟動、介入並停止執行任務的子代理",
  "module.subagents.enabled.label": "啟用子代理",
  "module.subagents.enabled.description": "關閉後不註冊子代理工具、訊息渲染器、狀態 widget 與鉤子（重新載入 pi 後生效）",
  "module.subagents.menu.label": "子代理設定",
  "module.subagents.menu.description": "tier 模型路由與狀態顯示開關",
  "module.subagents.menu.value": "{configured}/{total} 檔已設定",
  "module.subagents.status.label": "狀態顯示",
  "module.subagents.status.description": "子代理執行期間顯示狀態 widget（此處未設定時回退套件內設定）",
  "module.subagents.tier.label": "{tier} 檔模型",
  "module.subagents.tier.description": "子代理要求 tier \"{tier}\" 時使用的模型",
  "module.subagents.tier.unmapped": "未設定",
  "module.subagents.tier.authenticated": "已認證",
  "module.subagents.tier.noAuthRequired": "未設定認證",
  "module.subagents.route.label": "tier 路由狀態",
  "module.subagents.route.description": "六級設定鏈解析出的 tier 路由（僅供檢視）",
};

const TABLES: Record<ResolvedLanguage, ToolkitMessages> = {
  en: EN,
  "zh-CN": ZH_CN,
  "zh-TW": ZH_TW,
};

function format(template: string, vars?: MessageVars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole,
  );
}

/** auto 解析规则：非中文 → en；繁体地区 → zh-TW；其余中文 → zh-CN */
export function resolveLanguage(setting: LanguageSetting): ResolvedLanguage {
  if (setting !== "auto") return setting;
  const locale = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase();
  if (!locale.startsWith("zh")) return "en";
  return /(hant|tw|hk|mo)/.test(locale) ? "zh-TW" : "zh-CN";
}

export function isLanguageSetting(value: unknown): value is LanguageSetting {
  return typeof value === "string" && (LANGUAGE_SETTINGS as readonly string[]).includes(value);
}

/** 键表里是否存在该键；枚举值的显示文案 `<labelKey>.<value>` 靠它做可选解析 */
export function hasMessage(key: string): key is MessageKey {
  return Object.prototype.hasOwnProperty.call(EN, key);
}

/** 语言设置对应的显示名键，用于语言选择项 */
export function languageLabelKey(setting: LanguageSetting): MessageKey {
  switch (setting) {
    case "auto":
      return "language.auto";
    case "en":
      return "language.en";
    case "zh-CN":
      return "language.zhCN";
    case "zh-TW":
      return "language.zhTW";
  }
}

/**
 * 造一个始终读当前语言的译者；语言切换后无需更换实例，菜单重建即可刷新文案。
 */
export function createTranslator(getLanguage: () => ResolvedLanguage): Translator {
  return (key, vars) => format(TABLES[getLanguage()][key], vars);
}
