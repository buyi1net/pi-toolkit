// vision 模块装配定义：视觉辅助模块的装配与导出（工单 12 正名迁入）。
//
// 模块边界：
// - mod.ts：实现入口（视觉链、context 钩子、vision_query 工具、`vision.query-latest` 句柄、装配）
// - config.ts：`modules.vision` 节的解析、合并与保存原语（含项目层覆盖）
// - facade.ts：路由门面（解析 / 合并 / 写盘 / 描述与缓存协议；菜单与链共用的读口）
// - menu.ts：原生设置子菜单（视觉模型选择 / 项目层提示 / 目录刷新 / 运行自检 / 路由状态）
// - messages/：本模块三语键表；系统级键在 i18n/messages.ts
// 界面显示名走 i18n（"视觉辅助"），目录与代码标识用英文 vision（规格决策 3）。

import { enabledField, type ModuleContext, type ModuleDefinition } from "../../kit/module.ts";
import { VISION_MODULE_ID } from "./config.ts";
import { buildVisionMenuItems } from "./menu.ts";
import { createVisionRuntime } from "./mod.ts";

export { VISION_MODULE_ID } from "./config.ts";
export { VISION_SERVICE_NAME, type VisionService } from "./mod.ts";

export function createVisionModule(): ModuleDefinition {
  // 菜单行要读门面快照（全局路由、项目层覆盖标记、目录版本号、诊断缓存），运行态由 mod.ts 建好两处共用
  const runtime = createVisionRuntime();

  return {
    id: VISION_MODULE_ID,
    labelKey: "module.vision.label",
    descriptionKey: "module.vision.description",
    group: "general",
    // schema 只放总开关；视觉路由是结构化配置（非 schema 键），由本模块的菜单与配置层读写
    configSchema: {
      enabled: enabledField("module.vision.enabled.label", "module.vision.enabled.description"),
    },
    register(context: ModuleContext): void {
      runtime.register(context);
    },
    menuItems(context): ReturnType<typeof buildVisionMenuItems> {
      return buildVisionMenuItems(context, runtime.menu);
    },
  };
}

export const visionModule: ModuleDefinition = createVisionModule();
