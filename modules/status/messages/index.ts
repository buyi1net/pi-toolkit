import type { Translator } from "../../../i18n/index.ts";
import type { MessageTables } from "../../../i18n/index.ts";
import type { StatusWarning } from "../status-config.ts";

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
  "module.status.segments.label": "Status segments",
  "module.status.warning.badValue": "The value of {setting} is invalid; the default is used",
  "module.status.warning.badSegmentValue": "Status segments contain an invalid value \"{value}\"; it was ignored",
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
  "module.status.segments.label": "状态分段",
  "module.status.warning.badValue": "{setting}取值无效，已使用默认值",
  "module.status.warning.badSegmentValue": "状态分段包含无效值「{value}」，已忽略",
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
  "module.status.segments.label": "狀態分段",
  "module.status.warning.badValue": "{setting}取值無效，已使用預設值",
  "module.status.warning.badSegmentValue": "狀態分段包含無效值「{value}」，已忽略",
};

export const STATUS_MESSAGES = { en: EN, "zh-CN": ZH_CN, "zh-TW": ZH_TW } satisfies MessageTables;

export type StatusMessageKey = keyof typeof EN;

const WARNING_KEYS = {
  badValue: "module.status.warning.badValue",
  badSegmentValue: "module.status.warning.badSegmentValue",
} as const;

export function formatStatusWarning(warning: StatusWarning, t: Translator): string {
  return warning.kind === "badSegmentValue"
    ? t(WARNING_KEYS[warning.kind], { value: warning.value })
    : t(WARNING_KEYS[warning.kind], { setting: t(warning.setting) });
}
