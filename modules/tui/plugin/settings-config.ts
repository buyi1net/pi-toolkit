export type SpinnerMode = "default" | "static" | "hidden";

export interface PiTuiConfig {
	appearance: {
		editor: boolean;
		header: boolean;

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
