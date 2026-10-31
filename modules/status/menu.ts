import type { SettingItem } from "@earendil-works/pi-tui";
import type { Translator } from "../../i18n/index.ts";
import type { ConfigWriteHooks } from "../../kit/config-transaction.ts";
import type { ChoiceOption } from "../../kit/menu/panels.ts";
import type { ModuleConfigRecord, ModuleMenuContext, RowChangeEntry } from "../../kit/module.ts";
import type { StatusMenuRuntime } from "./mod.ts";
import {
	STATUS_PRESET_NAMES,
	readStatusSection,
	statusSectionPatch,
	type StatusPresetName,
	type StatusSectionUpdate,
} from "./status-config.ts";

export const STATUS_PRESET_ROW_ID = "status.settings.preset";
export const STATUS_TELEMETRY_ROW_ID = "status.settings.telemetry";

export function presetLabel(t: Translator, preset: StatusPresetName): string {
	switch (preset) {
		case "minimal":
			return t("module.status.preset.minimal");
		case "default":
			return t("module.status.preset.default");
		case "full":
			return t("module.status.preset.full");
	}
}

export function statusBoolLabel(t: Translator, value: boolean): string {
	return value ? t("common.on") : t("common.off");
}

interface SaveOutcome {
	readonly ok: boolean;
	readonly error?: string;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

interface StatusPanelOptions {
	readonly t: Translator;
	readonly runtime: StatusMenuRuntime;

	readonly saveConfig: (patch: ModuleConfigRecord, hooks?: ConfigWriteHooks) => Promise<void>;
	readonly requestRender: () => void;
	readonly getSection: () => Record<string, unknown>;
	readonly notify?: (message: string, type: "error") => void;

	readonly registerRowChange: (id: string, entry: RowChangeEntry) => void;
}

async function persistStatusSection(
	options: StatusPanelOptions,
	update: StatusSectionUpdate,
): Promise<SaveOutcome> {
	try {
		await options.saveConfig(statusSectionPatch(update), {
			reapply: () => {
				options.runtime.reapply();
			},
		});
	} catch (error) {
		return { ok: false, error: describeError(error) };
	}
	return { ok: true };
}

interface RowParams {
	readonly id: string;
	readonly labelKey: string;
	readonly descriptionKey: string;

	readonly read: () => string;
	readonly options: readonly ChoiceOption[];
	readonly apply: (value: string) => StatusSectionUpdate;
}

function statusRow(panel: StatusPanelOptions, params: RowParams): SettingItem {
	const t = panel.t;
	const label = t(params.labelKey);
	const report = (outcome: SaveOutcome): void => {
		if (outcome.ok) return;
		panel.notify?.(t("notify.saveFailed", { reason: outcome.error ?? "" }), "error");
	};
	panel.registerRowChange(params.id, {
		read: params.read,
		change: async (value) => {
			const picked = params.options.find((option) => option.label === value);
			if (!picked) return false;
			const outcome = await persistStatusSection(panel, params.apply(picked.value));
			report(outcome);
			panel.requestRender();
			return outcome.ok;
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

export function buildStatusMenuItems(
	context: ModuleMenuContext,
	runtime: StatusMenuRuntime,
): readonly SettingItem[] {
	const t = context.t;
	const panel: StatusPanelOptions = {
		t,
		runtime,
		saveConfig: (patch, hooks) => context.saveConfig(patch, hooks),
		requestRender: () => context.requestRender(),
		getSection: () => context.getConfig(),
		notify: (message, type) => context.context.ui.notify(message, type),
		registerRowChange: (id, entry) => context.registerRowChange(id, entry),
	};

	const readConfig = () => readStatusSection(panel.getSection()).config;

	return [
		statusRow(panel, {
			id: STATUS_PRESET_ROW_ID,
			labelKey: "module.status.preset.label",
			descriptionKey: "module.status.preset.description",
			read: () => presetLabel(t, readConfig().preset),
			options: STATUS_PRESET_NAMES.map((preset) => ({ value: preset, label: presetLabel(t, preset) })),
			apply: (value) => ({ preset: value as StatusPresetName }),
		}),
		statusRow(panel, {
			id: STATUS_TELEMETRY_ROW_ID,
			labelKey: "module.status.telemetry.label",
			descriptionKey: "module.status.telemetry.description",
			read: () => statusBoolLabel(t, readConfig().telemetry),
			options: [
				{ value: "true", label: t("common.on") },
				{ value: "false", label: t("common.off") },
			],
			apply: (value) => ({ telemetry: value === "true" }),
		}),
	];
}
