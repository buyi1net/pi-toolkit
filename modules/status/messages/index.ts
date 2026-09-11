// status 模块三语键表（自包含：本模块的文案只在这里；模块目录拿走则这些文案一起消失）。
// 框架级键（command/menu/group/problem/language/common/hint/notify）在 i18n/messages.ts。
// 三语（en / zh-CN / zh-TW）必须同时补齐：ZH_CN / ZH_TW 以 typeof EN 断言，缺键/多键 typecheck 报错；
// 三语键集合相等与无未翻译值由 tests/pi-toolkit/i18n-messages.test.ts 兜底。
//
// 工单 11：module.tui.preset.* / module.tui.telemetry.* 随状态数据域迁入本表，
// 命名空间改为 status，文案值零改动（只动归属）；模块自身的 label/enabled 文案为新增。

import type { MessageTables } from "../../../i18n/index.ts";

const EN = {
  "module.status.label": "Workspace & session status",
  "module.status.description": "Project/git, runtime, turn timer, reply telemetry and auto-compaction status data",
  "module.status.enabled.label": "Enable status data",
  "module.status.enabled.description": "When off, no status data is collected and the status bar keeps only structural placeholders (reload to apply)",
  "module.status.preset.label": "Status preset",
  "module.status.preset.description": "Which status segments are shown",
  "module.status.preset.minimal": "Minimal",
  "module.status.preset.default": "Default",
  "module.status.preset.full": "Full",
  "module.status.telemetry.label": "Reply telemetry",
  "module.status.telemetry.description": "Record per-reply timing and token usage entries",
} satisfies Record<string, string>;

const ZH_CN: typeof EN = {
  "module.status.label": "工作区与会话状态",
  "module.status.description": "项目/Git、运行时、回合计时、回复遥测与自动压缩的状态数据",
  "module.status.enabled.label": "启用状态数据",
  "module.status.enabled.description": "关闭后不采集状态数据，状态栏只保留结构性占位（重载 pi 后生效）",
  "module.status.preset.label": "状态预设",
  "module.status.preset.description": "显示哪些状态分段",
  "module.status.preset.minimal": "精简",
  "module.status.preset.default": "默认",
  "module.status.preset.full": "完整",
  "module.status.telemetry.label": "回复遥测",
  "module.status.telemetry.description": "记录每次回复的耗时与 token 用量条目",
};

const ZH_TW: typeof EN = {
  "module.status.label": "工作區與工作階段狀態",
  "module.status.description": "專案/Git、執行環境、回合計時、回覆遙測與自動壓縮的狀態資料",
  "module.status.enabled.label": "啟用狀態資料",
  "module.status.enabled.description": "關閉後不蒐集狀態資料，狀態列只保留結構性佔位（重新載入 pi 後生效）",
  "module.status.preset.label": "狀態預設",
  "module.status.preset.description": "顯示哪些狀態分段",
  "module.status.preset.minimal": "精簡",
  "module.status.preset.default": "預設",
  "module.status.preset.full": "完整",
  "module.status.telemetry.label": "回覆遙測",
  "module.status.telemetry.description": "記錄每次回覆的耗時與 token 用量條目",
};

/** 本键表：全部模块键表在 modules/index.ts 聚合登记 */
export const STATUS_MESSAGES = { en: EN, "zh-CN": ZH_CN, "zh-TW": ZH_TW } satisfies MessageTables;

/** 模块内使用的键类型（kit/module.ts 的契约字段已收窄为 string） */
export type StatusMessageKey = keyof typeof EN;
