// providers 模块实现入口：控制器创建、`providers.usage` 句柄注册、会话绑定与凭据读取。
//
// 句柄契约见 api.ts（工单 07 定案）。控制器在模块装配时创建并注册：
// - 上下文经 getContext 延迟取用：装配期还没有会话，session_start 绑定后刷新才生效；
// - 会话结束 stop() 停掉轮询并清空运行态，句柄与实例保留，下一会话重新开始；
// - 凭据文件 `<agentDir>/pi-tui.json` 在每次刷新时现读（用户可随时编辑，读取行为与迁出前一致）。

import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModuleContext } from "../../kit/module.ts";
import {
	PROVIDERS_USAGE_SERVICE_NAME,
	resolveProviderRefreshMs,
	type ProvidersUsageService,
} from "./api.ts";
import { loadProviderAccessFile } from "./credentials.ts";
import { PiProviderUsageController } from "./provider-usage.ts";

export interface ProvidersModuleOptions {
	/** pi 的配置目录（只读的 pi-tui.json 在它下面）；默认 getAgentDir() */
	readonly agentDir?: string;
}

export function registerProviders(context: ModuleContext, options: ProvidersModuleOptions = {}): void {
	const agentDir = options.agentDir ?? getAgentDir();
	let sessionContext: ExtensionContext | undefined;
	let polling = false;

	const controller = new PiProviderUsageController(
		() => sessionContext,
		() => {},
		{
			refreshMs: () => resolveProviderRefreshMs(context.getConfig()),
			accessConfig: () => loadProviderAccessFile(agentDir).access ?? {},
		},
	);

	context.services.register(PROVIDERS_USAGE_SERVICE_NAME, {
		id: "providers",
		snapshot: () => (sessionContext ? controller.getState() : undefined),
		refresh: async (model) => {
			if (!sessionContext) return;
			// 首次消费触发周期刷新的启动（轮询策略属于本模块，句柄上只暴露 refresh）
			if (!polling) {
				polling = true;
				await controller.start(model);
				return;
			}
			await controller.refresh(model);
		},
	} satisfies ProvidersUsageService);

	context.pi.on("session_start", (_event, ctx) => {
		sessionContext = ctx;
		// 凭据文件解析异常按迁出前行为逐条提示（只读文件由用户维护）
		const loaded = loadProviderAccessFile(agentDir);
		if (ctx.hasUI) {
			for (const warning of loaded.warnings) ctx.ui.notify(warning, "warning");
		}
	});

	context.pi.on("session_shutdown", () => {
		polling = false;
		controller.stop();
		sessionContext = undefined;
	});
}
