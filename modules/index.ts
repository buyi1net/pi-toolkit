// 内置模块清单：三个源插件各一个模块。
// 顺序 = 装配与事件钩子注册顺序。tui 放最后，避免它的 15 个钩子抢在
// eyes/subagents 的 session_start 之前注册（两个模块的联调用例按注册顺序取
// 第一个 session_start 处理器）。
import type { ModuleDefinition } from "../module.ts";
import { eyesModule } from "./eyes/index.ts";
import { subagentsModule } from "./subagents/index.ts";
import { tuiModule } from "./tui/index.ts";

export const BUILT_IN_MODULES: readonly ModuleDefinition[] = [eyesModule, subagentsModule, tuiModule];
