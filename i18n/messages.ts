// 框架级三语键表：引擎/根层/kit 与菜单框架共用的键（command/menu/group/problem/language/common/hint/notify）。
// 模块自己的文案不在这里——各模块 messages/ 自带键表，modules/index.ts 聚合登记。
// 三语（en / zh-CN / zh-TW）必须同时补齐：ZH_CN / ZH_TW 以 typeof EN 断言，缺键/多键 typecheck 报错；
// 三语键集合相等与无未翻译值由 tests/pi-toolkit/i18n-messages.test.ts 兜底。

// 归属规则（工单 09 定案）：被 kit 或根层消费的框架级键在本表；仅被模块消费的键进模块 messages/。
// 当前菜单框架的键（hint/group/common/language 等）全部落在本表；
// 若将来出现只被 kit/menu 自己消费、且不属于上述前缀的新键，再建 kit/menu/messages.ts，不塞进本表。

import type { ResolvedLanguage } from "./engine.ts";

/** 一种语言下的键表：键 → 文案模板 */
export type MessageTable = Record<string, string>;

/** 键表全集：三语各一份（模块自带的 messages/ 也用这个形状） */
export type MessageTables = Record<ResolvedLanguage, MessageTable>;

/** 占位符取值：{name} 由 Translator 替换 */
export type MessageVars = Record<string, string | number>;

const EN = {
  "command.description": "Open the pi-toolkit control panel",
  "menu.title": "pi-toolkit",
  "group.general": "General",
  "group.tui": "TUI",
  "group.models": "Models & usage",
  "group.subagents": "Subagents",
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
} satisfies Record<string, string>;

const ZH_CN: typeof EN = {
  "command.description": "打开 pi-toolkit 控制菜单",
  "menu.title": "pi-toolkit",
  "group.general": "常规",
  "group.tui": "TUI",
  "group.models": "模型与用量",
  "group.subagents": "子代理",
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
};

const ZH_TW: typeof EN = {
  "command.description": "開啟 pi-toolkit 控制選單",
  "menu.title": "pi-toolkit",
  "group.general": "一般",
  "group.tui": "TUI",
  "group.models": "模型與用量",
  "group.subagents": "子代理",
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
};

/** 框架级键表：引擎/根层/kit 共用的文案都在这里，模块键表由 modules/index.ts 聚合登记 */
export const FRAMEWORK_MESSAGES = { en: EN, "zh-CN": ZH_CN, "zh-TW": ZH_TW } satisfies MessageTables;

/** 框架级键类型：kit/根层自己的数据结构用它做局部 keyof 校验（模块键类型在各自 messages/ 里） */
export type FrameworkMessageKey = keyof typeof EN;
