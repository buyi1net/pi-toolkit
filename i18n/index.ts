// i18n 目录入口：引擎（./engine.ts）与框架级键表（./messages.ts）对外统一从这里取。
// 模块自带的键表不放这里：各模块 modules/<id>/messages/，由 modules/index.ts 聚合登记。
export * from "./engine.ts";
export * from "./messages.ts";
