// subagents 模块三语键表（自包含：本模块的文案只在这里；模块目录拿走则这些文案一起消失）。
// 框架级键（command/menu/group/problem/language/common/hint/notify）在 i18n/messages.ts。
// 三语（en / zh-CN / zh-TW）必须同时补齐：ZH_CN / ZH_TW 以 typeof EN 断言，缺键/多键 typecheck 报错；
// 三语键集合相等与无未翻译值由 tests/pi-toolkit/i18n-messages.test.ts 兜底。

import type { MessageTables } from "../../../i18n/index.ts";

const EN = {
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
} satisfies Record<string, string>;

const ZH_CN: typeof EN = {
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

const ZH_TW: typeof EN = {
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

/** 本键表：全部模块键表在 modules/index.ts 聚合登记 */
export const SUBAGENTS_MESSAGES = { en: EN, "zh-CN": ZH_CN, "zh-TW": ZH_TW } satisfies MessageTables;

/** 模块内使用的键类型（kit/module.ts 的契约字段已收窄为 string） */
export type SubagentsMessageKey = keyof typeof EN;
