// pi-tui 模块的配置菜单行（工单 46 一级化：原 TuiPanel 自画面板取消，外观行直接作为
// 二级页内容，由 kit 按同 pageId 聚合——tui 与 status 共享「外观配置」页）。
//
// 页面行（tui 模块部分，schema 的 enabled 行由骨架自动生成，同样落在共享页里）：
//   编辑器边框   —— modules.tui.appearance.editor
//   顶部信息栏   —— modules.tui.appearance.header
//   底部状态栏   —— modules.tui.appearance.footer（迁入后新增的总开关）
//   工作指示动画 —— modules.tui.advanced.spinner（默认 / 静态 / 隐藏）
//
// 余额刷新间隔与供应商凭据行随工单 10 归 providers 模块（modules/providers/menu.ts）；
// 状态预设与回复遥测行随工单 11 归 status 模块（modules/status/menu.ts）。
// 写盘全落 pi-toolkit.json 的 `modules.tui` 节；保存后立刻让 lifecycle 重装常驻 UI
// （与原 pi-tui 设置保存后的原子重装一致），因此外观开关是即时生效的。

import type { SettingItem } from "@earendil-works/pi-tui";
import type { Translator } from "../../i18n/index.ts";
import type { ConfigWriteHooks } from "../../kit/config-transaction.ts";
import { SettingsPanel, type ChoiceOption } from "../../kit/menu/panels.ts";
import type { ModuleConfigRecord, ModuleMenuContext, RowChangeEntry } from "../../kit/module.ts";
import { readTuiSection, tuiSectionPatch, type TuiSectionUpdate } from "./config.ts";
import type { TuiMessageKey } from "./messages/index.ts";
import { type SpinnerMode } from "./plugin/settings-config.ts";

/** 一级「外观配置」入口行 id */
export const TUI_MENU_ITEM_ID = "tui.settings";

const ROW_EDITOR = "tui.settings.editor";
const ROW_HEADER = "tui.settings.header";
const ROW_FOOTER = "tui.settings.footer";
const ROW_SPINNER = "tui.settings.spinner";

export const SPINNER_MODES: readonly SpinnerMode[] = ["default", "static", "hidden"];

/** 面板行的 id 清单（渲染顺序，自测用） */
export function panelRowIds(): readonly string[] {
	return [
		ROW_EDITOR,
		ROW_HEADER,
		ROW_FOOTER,
		ROW_SPINNER,
	];
}

/** 菜单运行态：由模块 register 装上 */
export interface TuiMenuRuntime {
	/** 重读配置并原子重装常驻 UI（未安装时是空操作）；返回是否重装 */
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

/** 行构造与保存需要的依赖（buildTuiMenuItems 从 ModuleMenuContext 组出这份） */
export interface TuiRowContext {
	readonly t: Translator;
	readonly runtime: TuiMenuRuntime;
	/** 结构化配置写入事务（由菜单层注入，重绘请求也由它带）：模块只给补丁与 reapply */
	readonly saveConfig: (patch: ModuleConfigRecord, hooks?: ConfigWriteHooks) => Promise<void>;
	readonly requestRender: () => void;
	/** 读本模块配置节（实时） */
	readonly getSection: () => Record<string, unknown>;
	/** 保存失败提示用（headless 自测可省） */
	readonly notify?: (message: string, type: "error") => void;
	/** 自绘短选项行的就地切换注册（见 kit 的 RowChangeEntry）：行构造时调用 */
	readonly registerRowChange: (id: string, entry: RowChangeEntry) => void;
}

/** 保存补丁 → 事务（落盘 → 内存重载 → 原子重装界面）；返回结果供 UI 与自测判定 */
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

/** 行就地切换的保存路径：补丁 → 事务；失败提示在 reportSave（返回是否成功） */
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
		/** 读实时开关（行显示与失败回滚都用它） */
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
		/** 读实时显示值（行显示与失败回滚都用它） */
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

/** 模块的二级页行：外观四行（工单 46 起由 kit 聚合进「外观配置」共享页） */
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

/** 顶层入口行（本单起）：打开 tui 与 status 共享的「外观配置」二级页；值位不显示状态摘要 */
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
