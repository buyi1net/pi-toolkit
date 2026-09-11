// pi-tui 迁入 pi-toolkit 后的配置层（只解析，不写盘）。
//
// 外观 / 高级两个子节来自 pi-toolkit.json 的 `modules.tui` 节。
// 写盘统一走 modules/tui/config.ts（骨架的深合并 + 剥敏感键 + 0600 原子写），
// 本文件只负责把这些子节规范化成 lifecycle 认识的结构。
//
// 工单 10：供应商查询凭据与刷新间隔归 providers 模块（modules/providers/）。
// 工单 11：状态预设 / 段位与回复遥测开关随状态数据域归 status 模块
// （modules/status/：preset / segments / telemetry；渲染侧经 `status.workspace` 句柄读设置），
// 本文件不再解析 status 节。

export type SpinnerMode = "default" | "static" | "hidden";

export interface PiTuiConfig {
	appearance: {
		editor: boolean;
		header: boolean;
		/** 底部状态栏总开关（原版无条件安装，迁入后补上） */
		footer: boolean;
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
	advanced: Object.freeze({ spinner: "default" }),
});

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

/**
 * 把 pi-toolkit.json 的 `modules.tui` 节规范化成 PiTuiConfig。
 * 逐字段校验：非法项记 warning 并回退默认值，绝不因单点配置错误拖垮整个模块。
 */
export function parseTuiSection(section: Record<string, unknown> | undefined): LoadedPiTuiConfig {
	const warnings: string[] = [];
	const source = isRecord(section) ? section : {};
	const appearance = optionalRecord(source.appearance, "appearance", warnings);
	const advanced = optionalRecord(source.advanced, "advanced", warnings);
	const defaults = DEFAULT_PI_TUI_CONFIG;

	return {
		config: {
			appearance: {
				editor: readBoolean(appearance.editor, defaults.appearance.editor, "appearance.editor", warnings),
				header: readBoolean(appearance.header, defaults.appearance.header, "appearance.header", warnings),
				footer: readBoolean(appearance.footer, defaults.appearance.footer, "appearance.footer", warnings),
			},
			advanced: {
				spinner: readChoice(advanced.spinner, SPINNER_MODES, defaults.advanced.spinner, "advanced.spinner", warnings),
			},
		},
		warnings,
	};
}

/** 没有模块节可用时的兜底：默认外观 */
export function loadStandaloneTuiConfig(): LoadedPiTuiConfig {
	const defaults = DEFAULT_PI_TUI_CONFIG;
	return {
		config: {
			appearance: { ...defaults.appearance },
			advanced: { ...defaults.advanced },
		},
		warnings: [],
	};
}
