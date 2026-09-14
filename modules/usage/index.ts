// usage 模块装配定义（工单 28）：模型与用量面板 + 共享快照句柄。
//
// 模块边界：
// - mod.ts：快照控制器 + `usage.snapshot`（只读编排查询）/ `usage.recorder`（终态写入）句柄；
// - api.ts：对其它模块开放的静态导出面（类型 / 常量 / 纯函数）；
// - journal.ts：append-only JSONL 统计日志（并发追加不覆盖，reload 可重建）；
// - aggregate.ts：只统计当前子代理候选池模型的窗口聚合（纯函数）；
// - menu.ts：用户面板入口与只读面板视图。
//
// 装配顺序在 modules/index.ts：subagents 与 providers 之后、tui 之前——句柄
// 查找虽然延迟到每次调用，但面板入口要保证 tui 启动前已注册。

import { enabledField, type ModuleContext, type ModuleDefinition } from "../../kit/module.ts";
import { buildUsageMenuItems } from "./menu.ts";
import { registerUsage } from "./mod.ts";

/** 模块 id：同时是配置节名与菜单项 id 前缀 */
export const USAGE_MODULE_ID = "usage";

export {
  USAGE_RECORDER_SERVICE_NAME,
  USAGE_SNAPSHOT_SERVICE_NAME,
  type UsageRecord,
  type UsageRecorderService,
  type UsageRunEvent,
  type UsageSnapshotService,
  type UsageSnapshotView,
} from "./api.ts";

export function createUsageModule(): ModuleDefinition {
  return {
    id: USAGE_MODULE_ID,
    labelKey: "module.usage.label",
    descriptionKey: "module.usage.description",
    // 工单 46：归「模型与用量」分组，与 providers 共享二级页（pageId "providers-usage"）；
    // 一级不出现（topLevel 空数组），行收进共享页
    group: "models",
    pageId: "providers-usage",
    topLevel: () => [],
    configSchema: {
      enabled: enabledField("module.usage.enabled.label", "module.usage.enabled.description"),
    },
    register(context: ModuleContext): void {
      registerUsage(context);
    },
    menuItems(context): ReturnType<typeof buildUsageMenuItems> {
      return buildUsageMenuItems(context);
    },
  };
}

export const usageModule: ModuleDefinition = createUsageModule();
