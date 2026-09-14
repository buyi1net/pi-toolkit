// computer 模块三语键表（自包含：本模块的文案只在这里；模块目录拿走则这些文案一起消失）。
// 框架级键在 i18n/messages.ts，聚合登记点在 modules/index.ts（工单 07 接入装配已登记）。
// 三语（en / zh-CN / zh-TW）必须同时补齐：ZH_CN / ZH_TW 以 typeof EN 断言，缺键/多键 typecheck 报错。
//
// 错误码文案的键是 `module.computer.error.<错误码>`（模块键表只含本模块前缀，由三语完整性测试兜底），
// 一一对应由 COMPUTER_ERROR_MESSAGE_KEYS 的类型兜底；
// 工具标题与描述是模型可见的协议文本（英文），不进键表。

import type { ComputerErrorCode } from "../contract.ts";
import type { MessageTables } from "../../../i18n/index.ts";

const EN = {
  "module.computer.label": "Computer control",
  "module.computer.description":
    "Let the agent see the screen, read UI controls and drive mouse and keyboard on desktop apps (Windows, macOS, Linux)",
  "module.computer.enabled.label": "Enable computer control",
  "module.computer.enabled.description":
    "When off, no computer_* tool is registered and the native helper is not started (reload to apply)",
  "module.computer.error.stale_ref":
    "The interface changed after that observation, so the reference is no longer valid. Observe the root again and use the new state id.",
  "module.computer.error.wrong_scope":
    "That reference belongs to another observation scope (another root). Observe that root and act with the stateId it returns; re-observing the current root will not help.",
  "module.computer.error.target_not_found":
    "The target window or element no longer exists. Observe the root again and resolve the target once more.",
  "module.computer.error.capability_unsupported":
    "This platform or session does not support the operation; it is reported as unsupported instead of being faked.",
  "module.computer.error.bridge_timeout":
    "The native helper did not answer before the timeout, so the action may or may not have taken effect. Observe the root again before retrying.",
  "module.computer.error.bridge_unavailable":
    "The native helper is not running or could not be started, so no action was attempted.",
  "module.computer.error.invalid_params":
    "The call does not satisfy this tool's contract: a field is missing, has the wrong type, or the action lacks its explicit target.",
  "module.computer.error.action_failed":
    "The platform refused or failed the action; the detail field carries the native message for troubleshooting.",
  "module.computer.error.expectation_failed":
    "A step's expectation was not satisfied before its timeout, so the run stopped there. The receipt carries the scene at that moment; re-check the interface with the returned stateId before deciding what to do next.",
} satisfies Record<string, string>;

const ZH_CN: typeof EN = {
  "module.computer.label": "电脑控制",
  "module.computer.description": "让 Agent 看屏幕、认控件、动键鼠，操作桌面应用（Windows、macOS、Linux）",
  "module.computer.enabled.label": "启用电脑控制",
  "module.computer.enabled.description": "关闭后不注册任何 computer_* 工具，也不启动原生 helper（重载 pi 后生效）",
  "module.computer.error.stale_ref": "界面在这次观察之后变了，引用已失效；请重新观察根，用新的 stateId 操作。",
  "module.computer.error.wrong_scope":
    "这个引用属于另一个观察作用域（另一个根）；重新观察当前根不管用，请观察那个根并用它返回的 stateId 操作。",
  "module.computer.error.target_not_found": "目标窗口或元素已不存在；请重新观察根并重新定位目标。",
  "module.computer.error.capability_unsupported": "当前平台或会话不支持该操作，如实上报为不支持，不会假装执行。",
  "module.computer.error.bridge_timeout": "原生 helper 在超时前没有返回，动作可能已生效也可能没有；重试前先重新观察根。",
  "module.computer.error.bridge_unavailable": "原生 helper 未运行或无法启动，动作没有执行。",
  "module.computer.error.invalid_params": "调用不符合工具契约：字段缺失、类型不对，或动作没有给出显式目标。",
  "module.computer.error.action_failed": "平台拒绝或执行失败，排查线索见 detail 字段里的原生信息。",
  "module.computer.error.expectation_failed":
    "某一步的期望在其超时前没有满足，运行停在该步。回执带当时的现场；请先用返回的 stateId 复核界面再决定下一步。",
};

const ZH_TW: typeof EN = {
  "module.computer.label": "電腦控制",
  "module.computer.description": "讓 Agent 看螢幕、認控件、動鍵鼠，操作桌面應用程式（Windows、macOS、Linux）",
  "module.computer.enabled.label": "啟用電腦控制",
  "module.computer.enabled.description": "關閉後不註冊任何 computer_* 工具，也不啟動原生 helper（重載 pi 後生效）",
  "module.computer.error.stale_ref": "介面在這次觀察之後變了，參照已失效；請重新觀察根，用新的 stateId 操作。",
  "module.computer.error.wrong_scope":
    "這個參照屬於另一個觀察作用域（另一個根）；重新觀察目前這個根不管用，請觀察那個根並用它回傳的 stateId 操作。",
  "module.computer.error.target_not_found": "目標視窗或元素已不存在；請重新觀察根並重新定位目標。",
  "module.computer.error.capability_unsupported": "目前平台或工作階段不支援該操作，會如實回報為不支援，不會假裝執行。",
  "module.computer.error.bridge_timeout": "原生 helper 在逾時前沒有回應，動作可能已生效也可能沒有；重試前請先重新觀察根。",
  "module.computer.error.bridge_unavailable": "原生 helper 未執行或無法啟動，動作沒有執行。",
  "module.computer.error.invalid_params": "呼叫不符合工具契約：欄位缺少、型別不對，或動作沒有給出顯式目標。",
  "module.computer.error.action_failed": "平台拒絕或執行失敗，排查線索見 detail 欄位裡的原生訊息。",
  "module.computer.error.expectation_failed":
    "某一步的期望在其逾時前沒有滿足，執行停在該步。回執帶當時的現場；請先用回傳的 stateId 複核介面再決定下一步。",
};

export const COMPUTER_MESSAGES = { en: EN, "zh-CN": ZH_CN, "zh-TW": ZH_TW } satisfies MessageTables;
export type ComputerMessageKey = keyof typeof EN;

/** 错误码 → 文案键；Record 按错误码联合类型补齐，漏一个错误码就 typecheck 不过 */
export const COMPUTER_ERROR_MESSAGE_KEYS: Readonly<Record<ComputerErrorCode, ComputerMessageKey>> = {
  stale_ref: "module.computer.error.stale_ref",
  wrong_scope: "module.computer.error.wrong_scope",
  target_not_found: "module.computer.error.target_not_found",
  capability_unsupported: "module.computer.error.capability_unsupported",
  bridge_timeout: "module.computer.error.bridge_timeout",
  bridge_unavailable: "module.computer.error.bridge_unavailable",
  invalid_params: "module.computer.error.invalid_params",
  action_failed: "module.computer.error.action_failed",
  expectation_failed: "module.computer.error.expectation_failed",
};
