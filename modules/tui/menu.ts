// pi-tui 模块的配置子菜单：常规组里的 `外观与状态` 行打开这一页（原生 SettingsList 形态）。
//
// 页面行：
//   编辑器边框   —— modules.tui.appearance.editor
//   顶部信息栏   —— modules.tui.appearance.header
//   底部状态栏   —— modules.tui.appearance.footer（迁入后新增的总开关）
//   工作指示动画 —— modules.tui.advanced.spinner（默认 / 静态 / 隐藏）
//   状态预设     —— modules.tui.status.preset（minimal / default / full）
//   余额刷新间隔 —— modules.tui.data.providerRefreshMs
//   回复遥测     —— modules.tui.data.telemetry
//   供应商凭据   —— 只读：检测 <agentDir>/pi-tui.json 是否存在
//
// 写盘全落 pi-toolkit.json 的 `modules.tui` 节；保存后立刻让 lifecycle 重装常驻 UI
// （与原 pi-tui 设置保存后的原子重装一致），因此外观开关是即时生效的。

import { Container, type SettingItem, Text } from "@earendil-works/pi-tui";
import type { MessageKey, Translator } from "../../i18n.ts";
import { ChoicePicker, type ChoiceOption } from "../../menu/panels.ts";
import { I18nSettingsList } from "../../menu/settings-list.ts";
import type { MenuTheme } from "../../menu/theme.ts";
import type { ModuleMenuContext } from "../../module.ts";
import { readTuiSection, saveTuiSection, type TuiSectionUpdate } from "./config.ts";
import {
	PROVIDER_REFRESH_INTERVALS,
	piTuiConfigPath,
	providerAccessConfigured,
	type PiTuiConfig,
	type ProviderRefreshMs,
	type SpinnerMode,
} from "./plugin/settings-config.ts";
import { STATUS_PRESET_NAMES, type StatusPresetName } from "./status/status-config.ts";

/** 分组页里的入口行 id */
export const TUI_MENU_ITEM_ID = "tui.settings";

const ROW_EDITOR = "tui.settings.editor";
const ROW_HEADER = "tui.settings.header";
const ROW_FOOTER = "tui.settings.footer";
const ROW_SPINNER = "tui.settings.spinner";
const ROW_PRESET = "tui.settings.preset";
const ROW_REFRESH = "tui.settings.refresh";
const ROW_TELEMETRY = "tui.settings.telemetry";
const ROW_PROVIDER_ACCESS = "tui.settings.providerAccess";

export const SPINNER_MODES: readonly SpinnerMode[] = ["default", "static", "hidden"];

/** 面板行的 id 清单（渲染顺序，自测用） */
export function panelRowIds(): readonly string[] {
	return [
		ROW_EDITOR,
		ROW_HEADER,
		ROW_FOOTER,
		ROW_SPINNER,
		ROW_PRESET,
		ROW_REFRESH,
		ROW_TELEMETRY,
		ROW_PROVIDER_ACCESS,
	];
}

/** 菜单运行态：由模块 register 装上 */
export interface TuiMenuRuntime {
	/** 写盘后重载状态中枢的内存副本，让 getConfig() 跟上磁盘 */
	reload: () => Promise<void>;
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

export function presetLabel(t: Translator, preset: StatusPresetName): string {
	switch (preset) {
		case "minimal":
			return t("module.tui.preset.minimal");
		case "default":
			return t("module.tui.preset.default");
		case "full":
			return t("module.tui.preset.full");
	}
}

function refreshLabelKey(ms: ProviderRefreshMs): MessageKey {
	switch (ms) {
		case 30_000:
			return "module.tui.refresh.30";
		case 60_000:
			return "module.tui.refresh.60";
		case 120_000:
			return "module.tui.refresh.120";
		case 300_000:
			return "module.tui.refresh.300";
	}
}

export function refreshLabel(t: Translator, ms: ProviderRefreshMs): string {
	return t(refreshLabelKey(ms));
}

export function boolLabel(t: Translator, value: boolean): string {
	return value ? t("common.on") : t("common.off");
}

/** 入口行的当前值摘要：三个常驻 UI 开关的开关状态 */
export function appearanceSummary(config: PiTuiConfig, t: Translator): string {
	return t("module.tui.menu.value", {
		editor: boolLabel(t, config.appearance.editor),
		header: boolLabel(t, config.appearance.header),
		footer: boolLabel(t, config.appearance.footer),
	});
}

export interface SaveOutcome {
	readonly ok: boolean;
	readonly error?: string;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export interface TuiPanelOptions {
	readonly t: Translator;
	readonly theme: MenuTheme;
	readonly agentDir: string;
	readonly runtime: TuiMenuRuntime;
	readonly requestRender: () => void;
	/** 读本模块配置节（实时） */
	readonly getSection: () => Record<string, unknown>;
	/** 保存失败提示用（headless 自测可省） */
	readonly notify?: (message: string, type: "error") => void;
	readonly onDone: (value: string) => void;
}

/** 写本节点 → 重载状态中枢 → 重装常驻 UI；返回结果供 UI 与自测判定 */
export async function persistTuiSection(
	options: TuiPanelOptions,
	update: TuiSectionUpdate,
): Promise<SaveOutcome> {
	try {
		await saveTuiSection(update, { agentDir: options.agentDir });
	} catch (error) {
		return { ok: false, error: describeError(error) };
	}
	try {
		await options.runtime.reload();
	} catch {
		// 内存副本落后不影响磁盘已写入的事实；下一次读盘会跟上
	}
	try {
		options.runtime.applyUi();
	} catch (error) {
		return { ok: false, error: describeError(error) };
	}
	return { ok: true };
}

// ─────────────────────────────────────────────────────────────
// UI：配置面板
// ─────────────────────────────────────────────────────────────

export class TuiPanel extends Container {
	private readonly options: TuiPanelOptions;
	private list: I18nSettingsList | undefined;
	private config: PiTuiConfig;

	constructor(options: TuiPanelOptions) {
		super();
		this.options = options;
		this.config = this.readConfig();
		this.addChild(new Text(options.theme.title(options.t("module.tui.menu.label")), 1, 0));
		this.list = new I18nSettingsList({
			items: this.buildItems(),
			maxVisible: 10,
			theme: options.theme.settings,
			t: options.t,
			onChange: () => {},
			onCancel: () => this.close(),
		});
		this.addChild(this.list);
	}

	handleInput(data: string): void {
		this.list?.handleInput(data);
	}

	private readConfig(): PiTuiConfig {
		// 凭据文件状态单独查（providerAccessValue），这里只解析 modules.tui 节
		return readTuiSection(this.options.getSection()).config;
	}

	private close(): void {
		this.options.onDone(appearanceSummary(this.config, this.options.t));
	}

	private reportSave(outcome: SaveOutcome): void {
		if (outcome.ok) return;
		this.options.notify?.(
			this.options.t("notify.saveFailed", { reason: outcome.error ?? "" }),
			"error",
		);
	}

	private refreshRows(): void {
		this.config = this.readConfig();
		const t = this.options.t;
		const cfg = this.config;
		this.list?.updateValue(ROW_EDITOR, boolLabel(t, cfg.appearance.editor));
		this.list?.updateValue(ROW_HEADER, boolLabel(t, cfg.appearance.header));
		this.list?.updateValue(ROW_FOOTER, boolLabel(t, cfg.appearance.footer));
		this.list?.updateValue(ROW_SPINNER, spinnerLabel(t, cfg.advanced.spinner));
		this.list?.updateValue(ROW_PRESET, presetLabel(t, cfg.status.preset));
		this.list?.updateValue(ROW_REFRESH, refreshLabel(t, cfg.data.providerRefreshMs));
		this.list?.updateValue(ROW_TELEMETRY, boolLabel(t, cfg.data.telemetry));
		this.list?.updateValue(ROW_PROVIDER_ACCESS, this.providerAccessValue());
		this.options.requestRender();
	}

	private providerAccessValue(): string {
		return providerAccessConfigured(this.options.agentDir)
			? this.options.t("module.tui.providerAccess.configured")
			: this.options.t("module.tui.providerAccess.missing");
	}

	private runSave(update: TuiSectionUpdate, label: string, done: (value?: string) => void): void {
		void (async () => {
			const outcome = await persistTuiSection(this.options, update);
			this.reportSave(outcome);
			if (outcome.ok) this.refreshRows();
			done(outcome.ok ? label : undefined);
		})();
	}

	private boolOptions(current: boolean): ChoiceOption[] {
		const t = this.options.t;
		return [
			{ value: "true", label: t("common.on"), ...(current ? { description: t("common.current") } : {}) },
			{ value: "false", label: t("common.off"), ...(current ? {} : { description: t("common.current") }) },
		];
	}

	private boolRow(params: {
		id: string;
		labelKey: MessageKey;
		descriptionKey: MessageKey;
		current: boolean;
		apply: (value: boolean) => TuiSectionUpdate;
	}): SettingItem {
		const t = this.options.t;
		const label = t(params.labelKey);
		return {
			id: params.id,
			label,
			description: t(params.descriptionKey),
			currentValue: boolLabel(t, params.current),
			submenu: (_currentValue, done) =>
				new ChoicePicker({
					title: label,
					theme: this.options.theme,
					t,
					options: this.boolOptions(params.current),
					onSelect: (value, displayLabel) => {
						this.runSave(params.apply(value === "true"), displayLabel, done);
					},
					onCancel: () => done(),
				}),
		};
	}

	private choiceRow(params: {
		id: string;
		labelKey: MessageKey;
		descriptionKey: MessageKey;
		current: string;
		options: ChoiceOption[];
		apply: (value: string) => TuiSectionUpdate;
	}): SettingItem {
		const t = this.options.t;
		const label = t(params.labelKey);
		return {
			id: params.id,
			label,
			description: t(params.descriptionKey),
			currentValue: params.current,
			submenu: (_currentValue, done) =>
				new ChoicePicker({
					title: label,
					theme: this.options.theme,
					t,
					options: params.options,
					onSelect: (value, displayLabel) => {
						this.runSave(params.apply(value), displayLabel, done);
					},
					onCancel: () => done(),
				}),
		};
	}

	private buildItems(): SettingItem[] {
		const t = this.options.t;
		const cfg = this.config;
		const items: SettingItem[] = [];

		items.push(this.boolRow({
			id: ROW_EDITOR,
			labelKey: "module.tui.editor.label",
			descriptionKey: "module.tui.editor.description",
			current: cfg.appearance.editor,
			apply: (editor) => ({ appearance: { editor } }),
		}));
		items.push(this.boolRow({
			id: ROW_HEADER,
			labelKey: "module.tui.header.label",
			descriptionKey: "module.tui.header.description",
			current: cfg.appearance.header,
			apply: (header) => ({ appearance: { header } }),
		}));
		items.push(this.boolRow({
			id: ROW_FOOTER,
			labelKey: "module.tui.footer.label",
			descriptionKey: "module.tui.footer.description",
			current: cfg.appearance.footer,
			apply: (footer) => ({ appearance: { footer } }),
		}));

		items.push(this.choiceRow({
			id: ROW_SPINNER,
			labelKey: "module.tui.spinner.label",
			descriptionKey: "module.tui.spinner.description",
			current: spinnerLabel(t, cfg.advanced.spinner),
			options: SPINNER_MODES.map((mode) => ({
				value: mode,
				label: spinnerLabel(t, mode),
				...(mode === cfg.advanced.spinner ? { description: t("common.current") } : {}),
			})),
			apply: (spinner) => ({ advanced: { spinner: spinner as SpinnerMode } }),
		}));

		items.push(this.choiceRow({
			id: ROW_PRESET,
			labelKey: "module.tui.preset.label",
			descriptionKey: "module.tui.preset.description",
			current: presetLabel(t, cfg.status.preset),
			options: STATUS_PRESET_NAMES.map((preset) => ({
				value: preset,
				label: presetLabel(t, preset),
				...(preset === cfg.status.preset ? { description: t("common.current") } : {}),
			})),
			apply: (preset) => ({ status: { preset: preset as StatusPresetName } }),
		}));

		items.push(this.choiceRow({
			id: ROW_REFRESH,
			labelKey: "module.tui.refresh.label",
			descriptionKey: "module.tui.refresh.description",
			current: refreshLabel(t, cfg.data.providerRefreshMs),
			options: PROVIDER_REFRESH_INTERVALS.map((ms) => ({
				value: String(ms),
				label: refreshLabel(t, ms),
				...(ms === cfg.data.providerRefreshMs ? { description: t("common.current") } : {}),
			})),
			apply: (value) => ({ data: { providerRefreshMs: Number(value) as ProviderRefreshMs } }),
		}));

		items.push(this.boolRow({
			id: ROW_TELEMETRY,
			labelKey: "module.tui.telemetry.label",
			descriptionKey: "module.tui.telemetry.description",
			current: cfg.data.telemetry,
			apply: (telemetry) => ({ data: { telemetry } }),
		}));

		items.push({
			id: ROW_PROVIDER_ACCESS,
			label: t("module.tui.providerAccess.label"),
			description: `${t("module.tui.providerAccess.description")} ${piTuiConfigPath(this.options.agentDir)}`,
			currentValue: this.providerAccessValue(),
		});

		return items;
	}
}

/** 模块的菜单行：一行入口，进去是外观与状态配置页 */
export function buildTuiMenuItems(
	context: ModuleMenuContext,
	runtime: TuiMenuRuntime,
): readonly SettingItem[] {
	const t = context.t;
	const { config } = readTuiSection(context.getConfig());
	return [
		{
			id: TUI_MENU_ITEM_ID,
			label: t("module.tui.menu.label"),
			description: t("module.tui.menu.description"),
			currentValue: appearanceSummary(config, t),
			submenu: (_currentValue, done) =>
				new TuiPanel({
					t,
					theme: context.theme,
					agentDir: context.agentDir,
					runtime,
					requestRender: () => context.requestRender(),
					getSection: () => context.getConfig(),
					notify: (message, type) => context.context.ui.notify(message, type),
					onDone: (value) => done(value),
				}),
		},
	];
}
