// providers 模块装配定义：供应商余额/套餐查询从 tui 迁出后的独立模块。
//
// 模块边界（工单 10）：
// - kernel/：usage-core / usage-node 的转发文件（与 claude-line 共享内核，仅搬家）
// - credentials.ts：独立只读凭据文件 <agentDir>/pi-tui.json 的读取
// - provider-usage.ts：运行态控制器；mod.ts 装配时创建并注册 `providers.usage` 句柄
// - api.ts：对其它模块开放的静态导出面（类型 / 纯函数 / 常量）
// tui 只是消费方：类型与纯函数走 api.ts 静态 import，运行态走句柄。

import { enabledField, type ModuleContext, type ModuleDefinition } from "../../kit/module.ts";
import {
	DEFAULT_PROVIDER_REFRESH_MS,
	PROVIDER_REFRESH_INTERVALS,
} from "./api.ts";
import { buildProvidersMenuItems } from "./menu.ts";
import { registerProviders, type ProvidersModuleOptions } from "./mod.ts";

/** 模块 id：同时是配置节名与菜单项 id 前缀 */
export const PROVIDERS_MODULE_ID = "providers";

export {
	PROVIDERS_POOL_USAGE_SERVICE_NAME,
	PROVIDERS_USAGE_SERVICE_NAME,
	type ProvidersPoolUsageService,
	type ProvidersUsageService,
} from "./api.ts";
export type { ProvidersModuleOptions } from "./mod.ts";

/** schema 取值（字符串码）→ 三语文案键；与 PROVIDER_REFRESH_INTERVALS 一一对应 */
const REFRESH_MS_LABEL_KEYS: Readonly<Record<string, string>> = {
	"30000": "module.providers.refresh.30",
	"60000": "module.providers.refresh.60",
	"120000": "module.providers.refresh.120",
	"300000": "module.providers.refresh.300",
};

export function createProvidersModule(options: ProvidersModuleOptions = {}): ModuleDefinition {
	return {
		id: PROVIDERS_MODULE_ID,
		labelKey: "module.providers.label",
		descriptionKey: "module.providers.description",
		group: "general",
		configSchema: {
			enabled: enabledField("module.providers.enabled.label", "module.providers.enabled.description"),
			refreshMs: {
				default: DEFAULT_PROVIDER_REFRESH_MS,
				values: PROVIDER_REFRESH_INTERVALS.map((ms) => String(ms)),
				labelKey: "module.providers.refresh.label",
				descriptionKey: "module.providers.refresh.description",
				valueLabelKeys: REFRESH_MS_LABEL_KEYS,
			},
		},
		register(context: ModuleContext): void {
			registerProviders(context, options);
		},
		menuItems(context): ReturnType<typeof buildProvidersMenuItems> {
			return buildProvidersMenuItems(context);
		},
	};
}

export const providersModule: ModuleDefinition = createProvidersModule();
