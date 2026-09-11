// 内置模块清单：三个源插件 + 从 tui 拆出的 providers 与 status，共五个模块（工单 10 / 11）。
// 顺序 = 装配与事件钩子注册顺序。tui 放最后，避免它的钩子抢在 vision/subagents/providers/status
// 的 session_start 之前注册（联调用例按注册顺序取第一个 session_start 处理器）；
// providers 与 status 在 tui 前，保证 tui 装配时 `providers.usage` 与 `status.*` 句柄
// 已经注册（且 status 的 session_start 已绑定会话，句柄快照可用）。
//
// 这里同时是全部模块三语键表的唯一聚合点（工单 09 定案）：新增模块时在本文件的
// MODULE_MESSAGE_TABLES 里登记一次即可。引擎侧的框架级键表在 i18n/messages.ts，
// 模块自己的键表在该模块 messages/（模块目录拿走则文案一起消失）。
import { registerMessages, type MessageTables } from "../i18n/index.ts";
import type { ModuleDefinition } from "../kit/module.ts";
import { visionModule } from "./vision/index.ts";
import { VISION_MESSAGES } from "./vision/messages/index.ts";
import { providersModule } from "./providers/index.ts";
import { PROVIDERS_MESSAGES } from "./providers/messages/index.ts";
import { statusModule } from "./status/index.ts";
import { STATUS_MESSAGES } from "./status/messages/index.ts";
import { subagentsModule } from "./subagents/index.ts";
import { SUBAGENTS_MESSAGES } from "./subagents/messages/index.ts";
import { tuiModule } from "./tui/index.ts";
import { TUI_MESSAGES } from "./tui/messages/index.ts";

/**
 * 模块 id → 该模块的三语键表。键就是 ModuleDefinition.id，
 * 完整性测试据此校验"每个模块都有键表、键表里的键都属于该模块"。
 */
export const MODULE_MESSAGE_TABLES: Readonly<Record<string, MessageTables>> = {
  vision: VISION_MESSAGES,
  providers: PROVIDERS_MESSAGES,
  status: STATUS_MESSAGES,
  subagents: SUBAGENTS_MESSAGES,
  tui: TUI_MESSAGES,
};

for (const tables of Object.values(MODULE_MESSAGE_TABLES)) {
  registerMessages(tables);
}

export const BUILT_IN_MODULES: readonly ModuleDefinition[] = [
  visionModule,
  subagentsModule,
  providersModule,
  statusModule,
  tuiModule,
];
