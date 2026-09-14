// providers 模块实现入口：控制器创建、`providers.usage` / `providers.pool-usage` 句柄注册、会话绑定与凭据读取。
//
// 句柄契约见 api.ts（工单 07 定案；候选池句柄为工单 25 新增）。两个控制器在模块装配时创建并注册：
// - 上下文经 getContext 延迟取用：装配期还没有会话，session_start 绑定后刷新才生效；
// - 会话结束 stop() 停掉轮询并清空运行态，句柄与实例保留，下一会话重新开始；
// - 凭据文件 `<agentDir>/pi-tui.json` 在每次刷新时现读（用户可随时编辑，读取行为与迁出前一致）；
// - 快照带变更序号（工单 18）：运行态内容变化时递增，tui 心跳按它判断是否需要重绘。

import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModuleContext } from "../../kit/module.ts";
import {
	PROVIDERS_POOL_USAGE_SERVICE_NAME,
	PROVIDERS_USAGE_SERVICE_NAME,
	resolveProviderRefreshMs,
	type ProvidersPoolUsageService,
	type ProvidersUsageService,
	type ProvidersUsageSnapshot,
	type UsageRuntimeState,
} from "./api.ts";
import { loadProviderAccessFile } from "./credentials.ts";
import { PiProviderUsageController } from "./provider-usage.ts";
import { PoolUsageTracker } from "./pool-usage.ts";

export interface ProvidersModuleOptions {
	/** pi 的配置目录（只读的 pi-tui.json 在它下面）；默认 getAgentDir() */
	readonly agentDir?: string;
}

/**
 * 快照变更序号的读取器（工单 18 / 决策 9）：内容与上次读取不同就递增，随快照带出。
 * 运行态由 UsageRuntime 在刷新时更新，这里只在句柄读取时按内容比较维护序号。
 */
function createRevisionReader(): (value: UsageRuntimeState) => ProvidersUsageSnapshot {
	let revision = 0;
	let signature: string | undefined;
	let hasSignature = false;
	return (value) => {
		const next = JSON.stringify(value);
		if (hasSignature && next !== signature) revision += 1;
		signature = next;
		hasSignature = true;
		return { ...value, revision };
	};
}

export function registerProviders(context: ModuleContext, options: ProvidersModuleOptions = {}): void {
	const agentDir = options.agentDir ?? getAgentDir();
	let sessionContext: ExtensionContext | undefined;
	let polling = false;
	// 快照变更序号（工单 18）：内容变化时递增，供 tui 心跳判断是否需要重绘
	const readUsageRevision = createRevisionReader();

	const controller = new PiProviderUsageController(
		() => sessionContext,
		() => {},
		{
			refreshMs: () => resolveProviderRefreshMs(context.getConfig()),
			accessConfig: () => loadProviderAccessFile(agentDir).access ?? {},
		},
	);

	// 候选池观测器（工单 25）：不轮询、只按需刷新；缓存有效期跟着同一份菜单配置。
	// 句柄缺席（本模块禁用）时编排侧按状态未知处理，不影响选择器行为。
	const poolTracker = new PoolUsageTracker(
		() => sessionContext,
		() => loadProviderAccessFile(agentDir).access ?? {},
		{ ttlMs: () => resolveProviderRefreshMs(context.getConfig()) },
	);

	context.services.register(PROVIDERS_USAGE_SERVICE_NAME, {
		id: "providers",
		snapshot: () => (sessionContext ? readUsageRevision(controller.getState()) : undefined),
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

	context.services.register(PROVIDERS_POOL_USAGE_SERVICE_NAME, {
		id: "providers",
		snapshot: (pool) => poolTracker.snapshot(pool),
		refresh: (pool) => poolTracker.refresh(pool),
	} satisfies ProvidersPoolUsageService);

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
		poolTracker.stop();
		sessionContext = undefined;
	});
}
