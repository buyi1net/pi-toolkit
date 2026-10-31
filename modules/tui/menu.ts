import type { SettingItem } from "@earendil-works/pi-tui";
import type { Translator } from "../../i18n/index.ts";
import type { ConfigWriteHooks } from "../../kit/config-transaction.ts";
import { SettingsPanel, type ChoiceOption } from "../../kit/menu/panels.ts";
import type { ModuleConfigRecord, ModuleMenuContext, RowChangeEntry } from "../../kit/module.ts";
import { readTuiSection, tuiSectionPatch, type TuiSectionUpdate } from "./config.ts";
import type { TuiMessageKey } from "./messages/index.ts";
import { type SpinnerMode } from "./plugin/settings-config.ts";

export const TUI_MENU_ITEM_ID = "tui.settings";

const ROW_EDITOR = "tui.settings.editor";
const ROW_HEADER = "tui.settings.header";
const ROW_FOOTER = "tui.settings.footer";
const ROW_SPINNER = "tui.settings.spinner";

export const SPINNER_MODES: readonly SpinnerMode[] = ["default", "static", "hidden"];

export function panelRowIds(): readonly string[] {
	return [
		ROW_EDITOR,
		ROW_HEADER,
		ROW_FOOTER,
		ROW_SPINNER,
	];
}

export interface TuiMenuRuntime {

	applyUi: () => boolean;
}

export function spinnerLabel(t: Translator, mode: SpinnerMode): string {
	switch (mode) {
		case "default":
			return t("module.tui.spinner.default");
		case "static":
			return t("module.tui.spinner.static");
		case "hidden":
			return t("module.tui.spinner.hidden");
	}
}

export function boolLabel(t: Translator, value: boolean): string {
	return value ? t("common.on") : t("common.off");
}

export interface SaveOutcome {
	readonly ok: boolean;
	readonly error?: string;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export interface TuiRowContext {
	readonly t: Translator;
	readonly runtime: TuiMenuRuntime;

	readonly saveConfig: (patch: ModuleConfigRecord, hooks?: ConfigWriteHooks) => Promise<void>;
	readonly requestRender: () => void;

	readonly getSection: () => Record<string, unknown>;

	readonly notify?: (message: string, type: "error") => void;

	readonly registerRowChange: (id: string, entry: RowChangeEntry) => void;
}

export async function persistTuiSection(
	options: TuiRowContext,
	update: TuiSectionUpdate,
): Promise<SaveOutcome> {
	try {
		await options.saveConfig(tuiSectionPatch(update), {
			reapply: () => {
				options.runtime.applyUi();
			},
		});
	} catch (error) {
		return { ok: false, error: describeError(error) };
	}
	return { ok: true };
}

function reportSave(options: TuiRowContext, outcome: SaveOutcome): void {
	if (outcome.ok) return;
	options.notify?.(
		options.t("notify.saveFailed", { reason: outcome.error ?? "" }),
		"error",
	);
}

async function saveRow(options: TuiRowContext, update: TuiSectionUpdate): Promise<boolean> {
	const outcome = await persistTuiSection(options, update);
	reportSave(options, outcome);
	if (outcome.ok) options.requestRender();
	return outcome.ok;
}

function boolRow(
	options: TuiRowContext,
	params: {
		id: string;
		labelKey: TuiMessageKey;
		descriptionKey: TuiMessageKey;

		read: () => boolean;
		apply: (value: boolean) => TuiSectionUpdate;
	},
): SettingItem {
	const t = options.t;
	const label = t(params.labelKey);
	const readLabel = () => boolLabel(t, params.read());
	options.registerRowChange(params.id, {
		read: readLabel,
		change: (value) => saveRow(options, params.apply(value === t("common.on"))),
	});
	return {
		id: params.id,
		label,
		description: t(params.descriptionKey),
		currentValue: readLabel(),
		values: [t("common.on"), t("common.off")],
	};
}

function choiceRow(
	options: TuiRowContext,
	params: {
		id: string;
		labelKey: TuiMessageKey;
		descriptionKey: TuiMessageKey;

		read: () => string;
		options: readonly ChoiceOption[];
		apply: (value: string) => TuiSectionUpdate;
	},
): SettingItem {
	const t = options.t;
	const label = t(params.labelKey);
	options.registerRowChange(params.id, {
		read: params.read,
		change: async (value) => {
			const picked = params.options.find((option) => option.label === value);
			if (!picked) return false;
			return saveRow(options, params.apply(picked.value));
		},
	});
	return {
		id: params.id,
		label,
		description: t(params.descriptionKey),
		currentValue: params.read(),
		values: params.options.map((option) => option.label),
	};
}

function rowContext(context: ModuleMenuContext, runtime: TuiMenuRuntime): TuiRowContext {
	return {
		t: context.t,
		runtime,
		saveConfig: (patch, hooks) => context.saveConfig(patch, hooks),
		requestRender: () => context.requestRender(),
		getSection: () => context.getConfig(),
		notify: (message, type) => context.context.ui.notify(message, type),
		registerRowChange: (id, entry) => context.registerRowChange(id, entry),
	};
}

export function buildTuiMenuItems(
	context: ModuleMenuContext,
	runtime: TuiMenuRuntime,
): readonly SettingItem[] {
	const t = context.t;
	const options = rowContext(context, runtime);
	const items: SettingItem[] = [];

	items.push(boolRow(options, {
		id: ROW_EDITOR,
		labelKey: "module.tui.editor.label",
		descriptionKey: "module.tui.editor.description",
		read: () => readTuiSection(options.getSection()).config.appearance.editor,
		apply: (editor) => ({ appearance: { editor } }),
	}));
	items.push(boolRow(options, {
		id: ROW_HEADER,
		labelKey: "module.tui.header.label",
		descriptionKey: "module.tui.header.description",
		read: () => readTuiSection(options.getSection()).config.appearance.header,
		apply: (header) => ({ appearance: { header } }),
	}));
	items.push(boolRow(options, {
		id: ROW_FOOTER,
		labelKey: "module.tui.footer.label",
		descriptionKey: "module.tui.footer.description",
		read: () => readTuiSection(options.getSection()).config.appearance.footer,
		apply: (footer) => ({ appearance: { footer } }),
	}));

	items.push(choiceRow(options, {
		id: ROW_SPINNER,
		labelKey: "module.tui.spinner.label",
		descriptionKey: "module.tui.spinner.description",
		read: () => spinnerLabel(t, readTuiSection(options.getSection()).config.advanced.spinner),
		options: SPINNER_MODES.map((mode) => ({ value: mode, label: spinnerLabel(t, mode) })),
		apply: (spinner) => ({ advanced: { spinner: spinner as SpinnerMode } }),
	}));

	return items;
}

export function buildTuiTopLevel(
	context: ModuleMenuContext,
	runtime: TuiMenuRuntime,
): readonly SettingItem[] {
	const t = context.t;
	return [
		{
			id: TUI_MENU_ITEM_ID,
			label: t("module.tui.menu.label"),
			description: t("module.tui.menu.description"),
			currentValue: "",
			submenu: (_currentValue, done) =>
				new SettingsPanel({
					items: context.pageItems?.() ?? [],
					theme: context.theme,
					t,
					onChange: context.onChange,
					onClose: () => done(),
				}),
		},
	];
}
