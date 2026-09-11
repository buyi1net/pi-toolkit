// tui 模块三语键表（自包含：本模块的文案只在这里；模块目录拿走则这些文案一起消失）。
// 框架级键（command/menu/group/problem/language/common/hint/notify）在 i18n/messages.ts。
// 三语（en / zh-CN / zh-TW）必须同时补齐：ZH_CN / ZH_TW 以 typeof EN 断言，缺键/多键 typecheck 报错；
// 三语键集合相等与无未翻译值由 tests/pi-toolkit/i18n-messages.test.ts 兜底。

import type { MessageTables } from "../../../i18n/index.ts";

const EN = {
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
  "module.tui.packageOrder.notice": "pi-toolkit was moved to the front of the startup package list; restart Pi to apply",
} satisfies Record<string, string>;

const ZH_CN: typeof EN = {
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
  "module.tui.packageOrder.notice": "已将 pi-toolkit 调整到启动首位，重启 Pi 后生效",
};

const ZH_TW: typeof EN = {
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
  "module.tui.packageOrder.notice": "已將 pi-toolkit 調整到啟動首位，重新載入 Pi 後生效",
};

/** 本键表：全部模块键表在 modules/index.ts 聚合登记 */
export const TUI_MESSAGES = { en: EN, "zh-CN": ZH_CN, "zh-TW": ZH_TW } satisfies MessageTables;

/** 模块内使用的键类型（kit/module.ts 的契约字段已收窄为 string） */
export type TuiMessageKey = keyof typeof EN;
