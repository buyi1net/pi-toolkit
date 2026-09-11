// pi-tui 迁入 pi-toolkit 后的配置层（只解析，不写盘）。
//
// 两块来源：
// 1. 外观 / 状态 / 数据 / 高级四个子节来自 pi-toolkit.json 的 `modules.tui` 节。
//    写盘统一走 modules/tui/config.ts（骨架的深合并 + 剥敏感键 + 0600 原子写），
//    本文件只负责把这些子节规范化成 lifecycle 认识的结构。
// 2. 供应商查询凭据（queries[].apiKey、credentials 里的 AK/SK、githubDomain）
//    按用户裁决留在独立文件 <agentDir>/pi-tui.json：本模块只读，toolkit 永不写，
//    因此凭据永远不会进入 pi-toolkit.json。外观等其余键即使写在 pi-tui.json 里
//    也不再被读取（合并决策 8：不做旧配置迁移）。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PiProviderAccessConfig } from "../adapter/provider-usage.ts";
import {
	parseProviderCredentials,
	parseProviderQueries,
	ProviderConfigValidationError,
} from "../kernel/usage-core.ts";
import {
	STATUS_PRESET_NAMES,
	STATUS_SEGMENT_IDS,
	type StatusPresetName,
	type StatusSegmentId,
} from "../status/status-config.ts";

/** 供应商凭据独立文件名（相对 pi 的 agentDir） */
export const PI_TUI_CONFIG_FILENAME = "pi-tui.json";
export const PROVIDER_REFRESH_INTERVALS = [30_000, 60_000, 120_000, 300_000] as const;

export type ProviderRefreshMs = (typeof PROVIDER_REFRESH_INTERVALS)[number];
export type SpinnerMode = "default" | "static" | "hidden";

export interface PiTuiConfig {
	appearance: {
		editor: boolean;
		header: boolean;
		/** 底部状态栏总开关（原版无条件安装，迁入后补上） */
		footer: boolean;
	};
	status: {
		preset: StatusPresetName;
		segments: StatusSegmentId[] | null;
	};
	data: {
		providerRefreshMs: ProviderRefreshMs;
		telemetry: boolean;
		/** 只从独立文件 pi-tui.json 读取，不从 pi-toolkit.json 读取 */
		providerAccess?: PiProviderAccessConfig;
	};
	advanced: {
		spinner: SpinnerMode;
	};
}

export interface LoadedPiTuiConfig {
	config: PiTuiConfig;
	warnings: string[];
}

export const DEFAULT_PI_TUI_CONFIG: Readonly<PiTuiConfig> = Object.freeze({
	appearance: Object.freeze({ editor: true, header: true, footer: true }),
	status: Object.freeze({ preset: "default", segments: null }),
	data: Object.freeze({ providerRefreshMs: 60_000, telemetry: true }),
	advanced: Object.freeze({ spinner: "default" }),
});

const PRESETS = new Set<StatusPresetName>(STATUS_PRESET_NAMES);
const SEGMENTS = new Set<StatusSegmentId>(STATUS_SEGMENT_IDS);
const REFRESH_INTERVALS = new Set<number>(PROVIDER_REFRESH_INTERVALS);
const SPINNER_MODES = new Set<SpinnerMode>(["default", "static", "hidden"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalRecord(value: unknown, field: string, warnings: string[]): Record<string, unknown> {
	if (value === undefined) return {};
	if (!isRecord(value)) {
		warnings.push(`${field} 必须是对象，已忽略`);
		return {};
	}
	return value;
}

function readBoolean(value: unknown, fallback: boolean, field: string, warnings: string[]): boolean {
	if (value === undefined) return fallback;
	if (typeof value !== "boolean") {
		warnings.push(`${field} 必须是布尔值，已使用默认值`);
		return fallback;
	}
	return value;
}

function readChoice<T extends string>(
	value: unknown,
	choices: ReadonlySet<T>,
	fallback: T,
	field: string,
	warnings: string[],
): T {
	if (value === undefined) return fallback;
	if (typeof value !== "string" || !choices.has(value as T)) {
		warnings.push(`${field} 的值无效，已使用默认值`);
		return fallback;
	}
	return value as T;
}

function readSegments(value: unknown, warnings: string[]): StatusSegmentId[] | null {
	if (value === undefined || value === null) return null;
	if (!Array.isArray(value)) {
		warnings.push("status.segments 必须是数组或 null，已使用默认值");
		return null;
	}
	const seen = new Set<StatusSegmentId>();
	for (const segment of value) {
		if (typeof segment !== "string" || !SEGMENTS.has(segment as StatusSegmentId)) {
			warnings.push(`status.segments 包含无效值: ${String(segment)}，已忽略`);
			continue;
		}
		seen.add(segment as StatusSegmentId);
	}
	return [...seen];
}

function readStatusPresetValue(value: unknown, warnings: string[]): StatusPresetName {
	if (value === "ascii") return "default";
	return readChoice(value, PRESETS, "default", "status.preset", warnings);
}

function readRefreshMs(value: unknown, warnings: string[]): ProviderRefreshMs {
	if (value === undefined) return DEFAULT_PI_TUI_CONFIG.data.providerRefreshMs;
	if (typeof value !== "number" || !REFRESH_INTERVALS.has(value)) {
		warnings.push("data.providerRefreshMs 的值无效，已使用默认值");
		return DEFAULT_PI_TUI_CONFIG.data.providerRefreshMs;
	}
	return value as ProviderRefreshMs;
}

/**
 * 把 pi-toolkit.json 的 `modules.tui` 节规范化成 PiTuiConfig。
 * 逐字段校验：非法项记 warning 并回退默认值，绝不因单点配置错误拖垮整个模块。
 */
export function parseTuiSection(section: Record<string, unknown> | undefined): LoadedPiTuiConfig {
	const warnings: string[] = [];
	const source = isRecord(section) ? section : {};
	const appearance = optionalRecord(source.appearance, "appearance", warnings);
	const status = optionalRecord(source.status, "status", warnings);
	const data = optionalRecord(source.data, "data", warnings);
	const advanced = optionalRecord(source.advanced, "advanced", warnings);
	const defaults = DEFAULT_PI_TUI_CONFIG;

	return {
		config: {
			appearance: {
				editor: readBoolean(appearance.editor, defaults.appearance.editor, "appearance.editor", warnings),
				header: readBoolean(appearance.header, defaults.appearance.header, "appearance.header", warnings),
				footer: readBoolean(appearance.footer, defaults.appearance.footer, "appearance.footer", warnings),
			},
			status: {
				preset: readStatusPresetValue(status.preset, warnings),
				segments: readSegments(status.segments, warnings),
			},
			data: {
				providerRefreshMs: readRefreshMs(data.providerRefreshMs, warnings),
				telemetry: readBoolean(data.telemetry, defaults.data.telemetry, "data.telemetry", warnings),
			},
			advanced: {
				spinner: readChoice(advanced.spinner, SPINNER_MODES, defaults.advanced.spinner, "advanced.spinner", warnings),
			},
		},
		warnings,
	};
}

// ─────────────────────────────────────────────────────────────
// 独立凭据文件 <agentDir>/pi-tui.json（只读）
// ─────────────────────────────────────────────────────────────

export function piTuiConfigPath(agentDir: string): string {
	return join(agentDir, PI_TUI_CONFIG_FILENAME);
}

export interface LoadedProviderAccess {
	/** 独立文件是否存在；菜单的"已配置/未配置"状态直接看它 */
	readonly exists: boolean;
	/** 解析出的供应商查询配置；文件缺失或无效时为 undefined */
	readonly access?: PiProviderAccessConfig;
	readonly warnings: readonly string[];
}

function readGithubDomain(value: unknown, warnings: string[]): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !value.trim()) {
		warnings.push("data.providerAccess.githubDomain 必须是非空字符串，已忽略");
		return undefined;
	}
	const domain = value.trim().toLowerCase();
	try {
		const url = new URL(`https://${domain}`);
		if (url.hostname !== domain || url.port || url.pathname !== "/" || url.username || url.password) {
			throw new Error();
		}
		return domain;
	} catch {
		warnings.push("data.providerAccess.githubDomain 必须是主机名，已忽略");
		return undefined;
	}
}

const VALIDATION_RULES = {
	object: "必须是对象",
	array: "必须是数组",
	nonEmptyArray: "必须是非空数组",
	nonEmptyString: "必须是非空字符串",
	choice: "的值无效",
} as const;

function readProviderAccess(value: unknown, warnings: string[]): PiProviderAccessConfig | undefined {
	if (!isRecord(value)) {
		warnings.push("data.providerAccess 必须是对象，已忽略");
		return undefined;
	}
	try {
		const queries = parseProviderQueries(value.queries, "data.providerAccess.queries");
		const githubDomain = readGithubDomain(value.githubDomain, warnings);
		const credentials = parseProviderCredentials(value.credentials, "data.providerAccess.credentials");
		return {
			...(queries ? { queries } : {}),
			...(Object.keys(credentials).length > 0 ? { credentials } : {}),
			...(githubDomain ? { githubDomain } : {}),
		};
	} catch (error) {
		if (!(error instanceof ProviderConfigValidationError)) throw error;
		warnings.push(`${error.field} ${VALIDATION_RULES[error.rule]}，已忽略`);
		return undefined;
	}
}

/**
 * 读独立凭据文件的数据源部分。除 `data.providerAccess` 外的键一律忽略。
 * 只读：本文件永不写盘（凭据由用户自行维护）。
 */
export function loadProviderAccessFile(agentDir: string): LoadedProviderAccess {
	const path = piTuiConfigPath(agentDir);
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { exists: false, warnings: [] };
		}
		return { exists: false, warnings: [`${path}: 读取失败（${(error as Error).message}），供应商查询按未配置处理`] };
	}

	const warnings: string[] = [];
	let root: unknown;
	try {
		root = JSON.parse(text);
	} catch (error) {
		warnings.push(`${path}: 解析失败（${(error as Error).message}），供应商查询按未配置处理`);
		return { exists: true, warnings };
	}
	if (!isRecord(root)) {
		warnings.push(`${path}: 顶层不是对象，供应商查询按未配置处理`);
		return { exists: true, warnings };
	}
	const data = root.data;
	if (!isRecord(data) || data.providerAccess === undefined) {
		return { exists: true, warnings };
	}
	return { exists: true, access: readProviderAccess(data.providerAccess, warnings), warnings };
}

/** 菜单里的只读状态行：检测到独立文件即视为已配置 */
export function providerAccessConfigured(agentDir: string): boolean {
	return loadProviderAccessFile(agentDir).exists;
}

/** 没有模块节可用时的兜底：默认外观 + 独立文件里的供应商凭据 */
export function loadStandaloneTuiConfig(agentDir: string): LoadedPiTuiConfig {
	const provider = loadProviderAccessFile(agentDir);
	const defaults = DEFAULT_PI_TUI_CONFIG;
	return {
		config: {
			appearance: { ...defaults.appearance },
			status: { preset: defaults.status.preset, segments: null },
			data: {
				...defaults.data,
				...(provider.access ? { providerAccess: provider.access } : {}),
			},
			advanced: { ...defaults.advanced },
		},
		warnings: [...provider.warnings],
	};
}
