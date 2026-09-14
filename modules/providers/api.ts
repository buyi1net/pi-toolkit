// providers 模块对其它模块开放的静态导出面（工单 07 定案「决策 9」的例外口径：
// 这里只放类型、常量与无状态的纯函数）。
//
// 有状态、有生命周期的运行能力不走静态 import：控制器由本模块装配时创建，
// 消费方（tui）经服务注册表的 `providers.usage` 句柄取快照与触发刷新。

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ProviderAccessOptions, ProviderQueryAccess, UsageSnapshot } from "./kernel/usage-core.ts";
import type { UsageRuntimeState } from "./kernel/usage-node.ts";

/** 供应商查询内核的校验错误类型（tui 侧消费时按类型区分配置错误） */
export { ProviderConfigValidationError, sanitizeQuotaWindowLabel } from "./kernel/usage-core.ts";
export type { ProviderAccess, ProviderAccessOptions, ProviderQueryAccess } from "./kernel/usage-core.ts";
export type { UsageRuntimeState } from "./kernel/usage-node.ts";
/** 单次查询成功时的用量快照（余额/额度窗口/时间戳）；供编排侧推导判定 */
export type { UsageSnapshot } from "./kernel/usage-core.ts";

/** 本模块在服务注册表里的句柄名（工单 07 定案：原 `ui.provider-usage` 正名） */
export const PROVIDERS_USAGE_SERVICE_NAME = "providers.usage";

/** 候选池用量观测句柄名（工单 25）：编排侧（subagents 模型选择）经注册表取用 */
export const PROVIDERS_POOL_USAGE_SERVICE_NAME = "providers.pool-usage";

/**
 * 单个候选的供应商查询原始状态（工单 25）。providers 域只回报观测事实，
 * 编排判定（可用/额度不足/…）由消费方（subagents/model-health.ts）推导。
 */
export type PoolUsageState =
	| { kind: "ready"; snapshot: UsageSnapshot }
	| { kind: "unsupported" }
	| { kind: "no-credential" }
	| { kind: "failed" }
	| { kind: "pending" }
	| { kind: "unresolved" };

/** 候选池单条观测结果 */
export interface PoolUsageEntry {
	/** 候选基础引用（已剥思考等级后缀，调用方负责归一后传入） */
	readonly model: string;
	readonly state: PoolUsageState;
}

/**
 * `providers.pool-usage` 句柄契约（工单 25）：候选池只读观测 + 按需后台刷新。
 * 只统计调用方（编排）传入的候选池模型，不扫描全部模型（ADR 0007 取舍）。
 * snapshot 同步无网络；refresh 异步且不抛错——查询失败只影响状态新鲜度，
 * 绝不阻断调用方，也绝不写任何静态配置。
 */
export interface ProvidersPoolUsageService {
	readonly id: "providers";
	/** 读取候选池最近已知状态；从未查询过的候选不在返回值里（消费方按未知处理） */
	snapshot(pool: readonly string[]): readonly PoolUsageEntry[];
	/** 触发一次后台查询（会话未绑定/退避中/缓存未超龄时自动跳过网络） */
	refresh(pool: readonly string[]): Promise<void>;
}

/** 查询目标模型：与 PiProviderUsageController 使用同一个 Pi 宿主模型类型 */
export type ProviderUsageModel = NonNullable<ExtensionContext["model"]>;

/**
 * `providers.usage` 句柄契约（工单 07 定案）：同步取快照 + 异步刷新。
 * 会话上下文绑定前 `snapshot()` 返回 undefined；`refresh()` 是空操作，
 * 首次成功调用会同时启动模块自己的周期刷新（轮询策略属于本模块，不在句柄上暴露）。
 */
export interface ProvidersUsageService {
	readonly id: "providers";
	snapshot(): ProvidersUsageSnapshot | undefined;
	refresh(model?: ProviderUsageModel): Promise<void>;
}

/**
 * 句柄快照的变更序号（工单 18 / 决策 9）：模块内部在内容变化时递增，随快照对象带出，
 * 供 tui 心跳做「有变化才重绘」；不属于服务注册表句柄契约扩展。
 */
export interface ProvidersUsageRevision {
	readonly revision: number;
}

/** `providers.usage` 快照：运行态 + 变更序号 */
export type ProvidersUsageSnapshot = UsageRuntimeState & ProvidersUsageRevision;

/** 供应商查询凭据配置（来自独立只读文件 `<agentDir>/pi-tui.json` 的 data.providerAccess） */
export interface PiProviderAccessConfig {
	queries?: readonly ProviderQueryAccess[];
	credentials?: ProviderAccessOptions["credentials"];
	githubDomain?: string;
}

/** 菜单可选的余额刷新间隔（毫秒）；schema 取值与校验共用 */
export const PROVIDER_REFRESH_INTERVALS = [30_000, 60_000, 120_000, 300_000] as const;

export type ProviderRefreshMs = (typeof PROVIDER_REFRESH_INTERVALS)[number];

export const DEFAULT_PROVIDER_REFRESH_MS: ProviderRefreshMs = 60_000;

/** 从 `modules.providers` 配置节取刷新间隔；非法值回落默认值 */
export function resolveProviderRefreshMs(section: Record<string, unknown>): number {
	const value = typeof section.refreshMs === "number" ? section.refreshMs : Number(section.refreshMs);
	return PROVIDER_REFRESH_INTERVALS.some((interval) => interval === value)
		? value
		: DEFAULT_PROVIDER_REFRESH_MS;
}
