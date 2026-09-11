// status 模块的配置菜单行（工单 07 定案 5「配置构造下沉」：原 tui 外观面板里的
// 状态预设行、以及跟随状态数据过来的回复遥测开关，都归本模块的菜单）。
//
// 页面行（常规分组页，schema 的 enabled 行由骨架自动生成）：
//   状态预设   —— modules.status.preset（minimal / default / full）
//   回复遥测   —— modules.status.telemetry（记录每次回复的耗时与 token 条目）
// 行 id 避开 schema 字段前缀（`status.preset` / `status.telemetry` 已被骨架占用语义），
// 用 `status.settings.*`；写盘后重载状态中枢并让模块重建控制器（纯数据侧，不碰 UI），
// 主界面在下一次重绘时按新段位渲染（渲染侧经 `status.workspace` 句柄读设置）。

import type { SettingItem } from "@earendil-works/pi-tui";
import type { Translator } from "../../i18n/index.ts";
import { ChoicePicker, type ChoiceOption } from "../../kit/menu/panels.ts";
import type { MenuTheme } from "../../kit/menu/theme.ts";
import type { ModuleMenuContext } from "../../kit/module.ts";
import type { StatusMenuRuntime } from "./mod.ts";
import {
	STATUS_PRESET_NAMES,
	readStatusSection,
	saveStatusSection,
	type StatusPresetName,
	type StatusSectionUpdate,
} from "./status-config.ts";

/** 面板行 id（schema 行是 `status.<字段>`，此处避开该前缀） */
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
	readonly theme: MenuTheme;
	readonly agentDir: string;
	readonly runtime: StatusMenuRuntime;
	readonly requestRender: () => void;
	readonly getSection: () => Record<string, unknown>;
	readonly notify?: (message: string, type: "error") => void;
}

/** 写本节点 → 重载状态中枢 → 重建控制器；返回结果供 UI 判定 */
async function persistStatusSection(
	options: StatusPanelOptions,
	update: StatusSectionUpdate,
): Promise<SaveOutcome> {
	try {
		await saveStatusSection(update, { agentDir: options.agentDir });
	} catch (error) {
		return { ok: false, error: describeError(error) };
	}
	try {
		await options.runtime.reload();
	} catch {
		// 内存副本落后不影响磁盘已写入的事实；下一次读盘会跟上
	}
	try {
		options.runtime.reapply();
	} catch (error) {
		return { ok: false, error: describeError(error) };
	}
	return { ok: true };
}

interface RowParams {
	readonly id: string;
	readonly labelKey: string;
	readonly descriptionKey: string;
	readonly current: string;
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
	return {
		id: params.id,
		label,
		description: t(params.descriptionKey),
		currentValue: params.current,
		submenu: (_currentValue, done) =>
			new ChoicePicker({
				title: label,
				theme: panel.theme,
				t,
				options: [...params.options],
				onSelect: (value, displayLabel) => {
					void (async () => {
						const outcome = await persistStatusSection(panel, params.apply(value));
						report(outcome);
						panel.requestRender();
						done(outcome.ok ? displayLabel : undefined);
					})();
				},
				onCancel: () => done(),
			}),
	};
}

/** 模块的配置行：状态预设 + 回复遥测开关 */
export function buildStatusMenuItems(
	context: ModuleMenuContext,
	runtime: StatusMenuRuntime,
): readonly SettingItem[] {
	const t = context.t;
	const config = readStatusSection(context.getConfig()).config;
	const panel: StatusPanelOptions = {
		t,
		theme: context.theme,
		agentDir: context.agentDir,
		runtime,
		requestRender: () => context.requestRender(),
		getSection: () => context.getConfig(),
		notify: (message, type) => context.context.ui.notify(message, type),
	};

	return [
		statusRow(panel, {
			id: STATUS_PRESET_ROW_ID,
			labelKey: "module.status.preset.label",
			descriptionKey: "module.status.preset.description",
			current: presetLabel(t, config.preset),
			options: STATUS_PRESET_NAMES.map((preset) => ({
				value: preset,
				label: presetLabel(t, preset),
				...(preset === config.preset ? { description: t("common.current") } : {}),
			})),
			apply: (value) => ({ preset: value as StatusPresetName }),
		}),
		statusRow(panel, {
			id: STATUS_TELEMETRY_ROW_ID,
			labelKey: "module.status.telemetry.label",
			descriptionKey: "module.status.telemetry.description",
			current: statusBoolLabel(t, config.telemetry),
			options: [
				{ value: "true", label: t("common.on"), ...(config.telemetry ? { description: t("common.current") } : {}) },
				{ value: "false", label: t("common.off"), ...(config.telemetry ? {} : { description: t("common.current") }) },
			],
			apply: (value) => ({ telemetry: value === "true" }),
		}),
	];
}
