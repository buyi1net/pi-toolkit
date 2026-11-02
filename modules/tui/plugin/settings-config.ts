export type SpinnerMode = "default" | "static" | "hidden";

export type TuiWarningKind = "notObject" | "badValue";

export type TuiSettingKey =
	| "module.tui.section.appearance"
	| "module.tui.section.advanced"
	| "module.tui.editor.label"
	| "module.tui.header.label"
	| "module.tui.footer.label"
	| "module.tui.spinner.label";

export interface TuiWarning {
	readonly kind: TuiWarningKind;
	readonly setting: TuiSettingKey;
}

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
	warnings: readonly TuiWarning[];
}

export const DEFAULT_PI_TUI_CONFIG: Readonly<PiTuiConfig> = Object.freeze({
	appearance: Object.freeze({ editor: true, header: true, footer: true }),
	advanced: Object.freeze({ spinner: "default" }),
});

const SPINNER_MODES = new Set<SpinnerMode>(["default", "static", "hidden"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalRecord(value: unknown, setting: TuiSettingKey, warnings: TuiWarning[]): Record<string, unknown> {
	if (value === undefined) return {};
	if (!isRecord(value)) {
		warnings.push({ kind: "notObject", setting });
		return {};
	}
	return value;
}

function readBoolean(value: unknown, fallback: boolean, setting: TuiSettingKey, warnings: TuiWarning[]): boolean {
	if (value === undefined) return fallback;
	if (typeof value !== "boolean") {
		warnings.push({ kind: "badValue", setting });
		return fallback;
	}
	return value;
}

function readChoice<T extends string>(
	value: unknown,
	choices: ReadonlySet<T>,
	fallback: T,
	setting: TuiSettingKey,
	warnings: TuiWarning[],
): T {
	if (value === undefined) return fallback;
	if (typeof value !== "string" || !choices.has(value as T)) {
		warnings.push({ kind: "badValue", setting });
		return fallback;
	}
	return value as T;
}

export function parseTuiSection(section: Record<string, unknown> | undefined): LoadedPiTuiConfig {
	const warnings: TuiWarning[] = [];
	const source = isRecord(section) ? section : {};
	const appearance = optionalRecord(source.appearance, "module.tui.section.appearance", warnings);
	const advanced = optionalRecord(source.advanced, "module.tui.section.advanced", warnings);
	const defaults = DEFAULT_PI_TUI_CONFIG;

	return {
		config: {
			appearance: {
				editor: readBoolean(appearance.editor, defaults.appearance.editor, "module.tui.editor.label", warnings),
				header: readBoolean(appearance.header, defaults.appearance.header, "module.tui.header.label", warnings),
				footer: readBoolean(appearance.footer, defaults.appearance.footer, "module.tui.footer.label", warnings),
			},
			advanced: {
				spinner: readChoice(advanced.spinner, SPINNER_MODES, defaults.advanced.spinner, "module.tui.spinner.label", warnings),
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
