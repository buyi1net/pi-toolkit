import {
	CustomEditor,
	type ExtensionContext,
	type KeybindingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	type Component,
	type EditorTheme,
	type OverlayHandle,
	type OverlayMargin,
	type OverlayOptions,
	type TUI,
	type TuiMainScreenRenderState,
} from "@earendil-works/pi-tui";
import type { UsageRuntimeState } from "../../providers/api.ts";
import {
	resolveStatusSettings,
	type EditorLeftSegmentId,
	type ResolvedStatusSettings,
	type TurnTimerSnapshot,
} from "../../status/api.ts";
import { sanitizeSingleLine } from "../../../shared/sanitize.ts";
import {
	insertTopBorderStatus,
	splitNativeEditorRender,
} from "../renderer/editor.ts";
import { resolveGlyphs, type IconGlyphs } from "../renderer/icons.ts";
import {
	durationStatusColor,
	formatElapsed,
	thinkingStatusColor,
} from "../status/status-segments.ts";
import { layoutEditorStatus, type StatusSegment } from "../status/segment-layout.ts";
import { buildEditorProviderSegments } from "../status/provider-status.ts";
import type {
	EditorLayoutSource,
	ProviderUsageSource,
	SessionStatusSource,
	StatusAppearance,
} from "./status-sources.ts";
import { isMainScreenTui, isSafeRenderState } from "./screen-transition.ts";

const MIN_DECORATED_WIDTH = 6;

function cropAutocompleteLines(lines: readonly string[], maxHeight: number): string[] {
	const height = Math.max(0, Math.floor(maxHeight));
	if (height === 0) return [];
	if (lines.length <= height) return [...lines];
	const selectedIndex = lines.findIndex((line) =>
		stripTerminalSequences(line).trimStart().startsWith("→ "),
	);
	const targetIndex = selectedIndex >= 0 ? selectedIndex : 0;
	const start = Math.max(
		0,
		Math.min(targetIndex - Math.floor((height - 1) / 2), lines.length - height),
	);
	return lines.slice(start, start + height);
}

export function formatModel(ctx: ExtensionContext): string {
	const model = ctx.model;
	if (!model) return "no model";
	return sanitizeSingleLine(model.provider ? `${model.provider}/${model.id}` : model.id) || "no model";
}

function formatCompactModel(ctx: ExtensionContext): string {
	return sanitizeSingleLine(ctx.model?.id ?? "no model") || "no model";
}

function getFrameStatus(
	ctx: ExtensionContext,
	theme: Theme,
	glyphs: IconGlyphs,
	width: number,
	settings: ResolvedStatusSettings,
	providerState: UsageRuntimeState | undefined,
	timer: TurnTimerSnapshot,
): { left: string; right: string } {
	const thinking = ctx.thinkingLevel ?? "off";
	const color = (role: Parameters<Theme["fg"]>[0], text: string): string => theme.fg(role, text);
	const provider = providerState
		? buildEditorProviderSegments(providerState, theme)
		: null;
	const leftById: Record<EditorLeftSegmentId, StatusSegment> = {
		provider: provider?.provider ?? {
			id: "provider",
			text: "",
			priority: 4,
		},
		model: {
			id: "model",
			text: color("accent", formatCompactModel(ctx)),
			compactText: color("accent", formatCompactModel(ctx)),
			priority: 0,
			required: true,
		},
		thinking: {
			id: "thinking",
			text: color(thinkingStatusColor(thinking), thinking),
			priority: 2,
		},
		duration: {
			id: "duration",
			text: timer.state === "idle"
				? ""
				: color(durationStatusColor(timer.state), formatElapsed(timer.elapsedMs)),
			priority: 1,
		},
		balance: provider?.balance ?? {
			id: "balance",
			text: "",
			priority: 3,
		},
		subscription: provider?.subscription ?? {
			id: "subscription",
			text: "",
			priority: 3,
		},
	};
	const left = settings.editorLeft.map((id) => leftById[id]).filter((segment) => segment.text);
	// 顶边右侧已让位：会话遥测整体移入 Footer 第二行，顶边只保留左侧身份段
	return layoutEditorStatus(left, [], width);
}

export interface PiUiEditorHooks {
	onReloadSubmit?: () => void;
	onFrameRendered?: () => void;
}

export class PiUiEditor extends CustomEditor {
	private readonly ctx: ExtensionContext;
	private readonly getGlyphs: () => IconGlyphs;
	private readonly getSettings: () => ResolvedStatusSettings;
	private readonly getFooterHeight: () => number;
	private readonly getProviderStatus: () => UsageRuntimeState | undefined;
	private readonly getTimer: () => TurnTimerSnapshot | undefined;
	private readonly appKeybindings: KeybindingsManager;
	private readonly autocompleteOverlay: Component & { setLines(lines: readonly string[]): void };
	private readonly autocompleteOverlayOptions: OverlayOptions;
	private autocompleteOverlayLines: readonly string[] = [];
	private autocompleteOverlayHandle: OverlayHandle | undefined;
	private autocompleteOverlayToken = 0;
	private frameHeight = 0;
	private frameCursorRow = -1;
	private suppressAutocompleteOverlay = false;
	private disposed = false;
	private readonly hooks: PiUiEditorHooks;

	// 前四个参数由宿主编辑框工厂签名与基类要求保持原位；其余按数据源分组，
	// 缺省时回落到与旧位置参数一致的默认行为。
	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		ctx: ExtensionContext,
		appearance: StatusAppearance = {},
		provider: ProviderUsageSource = {},
		session: SessionStatusSource = {},
		layout: EditorLayoutSource = {},
		hooks: PiUiEditorHooks = {},
	) {
		super(tui, theme, keybindings);
		this.ctx = ctx;
		this.getGlyphs = appearance.getGlyphs ?? (() => resolveGlyphs("unicode"));
		this.getSettings = appearance.getSettings ?? (() => resolveStatusSettings({}));
		this.getFooterHeight = layout.getFooterHeight ?? (() => 0);
		this.getProviderStatus = provider.getState ?? (() => undefined);
		this.hooks = hooks;
		this.getTimer = session.getTimer ?? (() => undefined);
		this.appKeybindings = keybindings;
		this.autocompleteOverlay = {
			setLines: (lines) => { this.autocompleteOverlayLines = [...lines]; },
			invalidate() {},
			render: (overlayWidth) => this.autocompleteOverlayLines.map((line) => {
				const clipped = truncateToWidth(line, overlayWidth, "");
				return `${clipped}${" ".repeat(Math.max(0, overlayWidth - visibleWidth(clipped)))}`;
			}),
		};
		const margin: OverlayMargin = {};
		// Footer 高度会随遥测和供应商数据变化；Overlay 在合成阶段读取最新值，
		// 始终贴在输入框上方，不进入正文布局，也不覆盖输入框和 Footer。
		Object.defineProperty(margin, "bottom", {
			enumerable: true,
			get: () => this.frameHeight + Math.max(0, this.getFooterHeight()),
		});
		this.autocompleteOverlayOptions = {
			anchor: "bottom-left",
			width: 1,
			margin,
			nonCapturing: true,
		};
	}

	override render(width: number): string[] {
		if (width < MIN_DECORATED_WIDTH) {
			const baseLines = super.render(width);
			return this.finishRender(this.renderWithAutocompleteOverlay(baseLines, baseLines, width));
		}

		const baseLines = super.render(width);
		const renderedLines = insertTopBorderStatus(baseLines, {
			left: getFrameStatus(
				this.ctx,
				this.ctx.ui.theme,
				this.getGlyphs(),
				width,
				this.getSettings(),
				this.getProviderStatus(),
				this.getTimer() ?? { state: "idle", elapsedMs: 0 },
			).left,
			borderColor: (text) => this.borderColor(text),
		});
		return this.finishRender(this.renderWithAutocompleteOverlay(baseLines, renderedLines, width));
	}

	override handleInput(data: string): void {
		const submitsInput = this.appKeybindings.matches(data, "tui.input.submit");
		const submitsAutocomplete =
			this.tui.mode === "regular" &&
			this.autocompleteOverlayHandle &&
			submitsInput;
		if (!submitsAutocomplete) {
			if (submitsInput && this.getText().trim() === "/reload") this.hooks.onReloadSubmit?.();
			super.handleInput(data);
			return;
		}

		// 补全确认和命令提交发生在同一次同步调用中。先撤下 Overlay，但不提交旧 Editor 帧；
		// 等父类给出补全后的完整命令，再决定进入 reload 过渡或恢复普通底图。
		const originalOnSubmit = this.onSubmit;
		let didSubmit = false;
		this.suppressAutocompleteOverlay = true;
		this.hideAutocompleteOverlay();
		this.onSubmit = (text) => {
			didSubmit = true;
			if (text.trim() === "/reload") this.hooks.onReloadSubmit?.();
			else this.tui.renderNow(false);
			originalOnSubmit?.(text);
		};
		try {
			super.handleInput(data);
			if (!didSubmit) this.tui.renderNow(false);
		} finally {
			this.onSubmit = originalOnSubmit;
			this.suppressAutocompleteOverlay = false;
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.hideAutocompleteOverlay();
	}

	private finishRender(lines: string[]): string[] {
		this.hooks.onFrameRendered?.();
		return lines;
	}

	private renderWithAutocompleteOverlay(
		baseLines: readonly string[],
		renderedLines: readonly string[],
		width: number,
	): string[] {
		const autocompleteCount = splitNativeEditorRender(baseLines).autocomplete.length;
		const frameEnd = Math.max(0, renderedLines.length - autocompleteCount);
		const frameLines = renderedLines.slice(0, frameEnd);
		this.frameHeight = frameLines.length;
		this.frameCursorRow = frameLines.findIndex((line) => line.includes(CURSOR_MARKER));

		if (this.tui.mode !== "regular") {
			this.updateAutocompleteOverlay([], width);
			return [...renderedLines];
		}

		const autocompleteLines = this.suppressAutocompleteOverlay ? [] : renderedLines.slice(frameEnd);
		const layout = autocompleteLines.length > 0
			? this.resolveAutocompleteOverlayLayout(autocompleteLines.length)
			: undefined;
		if (layout?.maxHeight === 0) {
			// Editor 已贴到可见区顶部时没有安全的覆盖空间，保留原生内联补全。
			this.updateAutocompleteOverlay([], width);
			return [...renderedLines];
		}
		this.updateAutocompleteOverlay(autocompleteLines, width, layout);
		return frameLines;
	}

	private hideAutocompleteOverlay(): void {
		this.autocompleteOverlayToken += 1;
		this.autocompleteOverlay.setLines([]);
		delete this.autocompleteOverlayOptions.row;
		this.autocompleteOverlayHandle?.hide();
		this.autocompleteOverlayHandle = undefined;
	}

	private updateAutocompleteOverlay(
		lines: readonly string[],
		width: number,
		initialLayout = this.resolveAutocompleteOverlayLayout(lines.length),
	): void {
		const initialLines = initialLayout
			? cropAutocompleteLines(lines, initialLayout.maxHeight)
			: [...lines];
		this.setAutocompleteOverlayLines(initialLines);
		this.setAutocompleteOverlayRow(initialLayout);
		this.autocompleteOverlayOptions.width = Math.max(1, width);
		const token = ++this.autocompleteOverlayToken;
		if (initialLines.length > 0) {
			// 当前正文渲染结束后再定位和挂载，避免在组件 render 中读取旧坐标或修改 Overlay 栈。
			queueMicrotask(() => {
				if (this.disposed || token !== this.autocompleteOverlayToken) return;
				const layout = this.resolveAutocompleteOverlayLayout(lines.length);
				const visibleLines = layout
					? cropAutocompleteLines(lines, layout.maxHeight)
					: [...lines];
				const linesChanged = this.setAutocompleteOverlayLines(visibleLines);
				const positionChanged = this.setAutocompleteOverlayRow(layout);
				if (visibleLines.length === 0) {
					this.autocompleteOverlayHandle?.hide();
					this.autocompleteOverlayHandle = undefined;
					return;
				}
				if (!this.autocompleteOverlayHandle) {
					this.autocompleteOverlayHandle = this.tui.showOverlay(
						this.autocompleteOverlay,
						this.autocompleteOverlayOptions,
					);
				} else if (positionChanged || linesChanged) {
					this.tui.requestRender();
				}
			});
			return;
		}
		if (lines.length === 0 && this.autocompleteOverlayHandle) {
			queueMicrotask(() => {
				if (token !== this.autocompleteOverlayToken || !this.autocompleteOverlayHandle) return;
				this.autocompleteOverlayHandle.hide();
				this.autocompleteOverlayHandle = undefined;
			});
		}
	}

	private resolveAutocompleteOverlayLayout(
		autocompleteHeight: number,
	): { row: number; maxHeight: number } | undefined {
		if (!isMainScreenTui(this.tui) || this.frameCursorRow < 0) {
			return undefined;
		}

		let state: TuiMainScreenRenderState;
		try {
			state = this.tui.captureRenderState();
		} catch {
			return undefined;
		}
		if (!isSafeRenderState(this.tui, state)) return undefined;

		const editorTop = state.hardwareCursorRow - this.frameCursorRow - state.previousViewportTop;
		const maxHeight = Math.max(0, Math.min(editorTop, this.tui.terminal.rows));
		return {
			row: Math.max(0, editorTop - Math.min(autocompleteHeight, maxHeight)),
			maxHeight,
		};
	}

	private setAutocompleteOverlayLines(lines: readonly string[]): boolean {
		if (
			lines.length === this.autocompleteOverlayLines.length &&
			lines.every((line, index) => line === this.autocompleteOverlayLines[index])
		) {
			return false;
		}
		this.autocompleteOverlay.setLines(lines);
		return true;
	}

	private setAutocompleteOverlayRow(
		layout: { row: number; maxHeight: number } | undefined,
	): boolean {
		if (!layout) {
			if (this.autocompleteOverlayOptions.row === undefined) return false;
			delete this.autocompleteOverlayOptions.row;
			return true;
		}
		if (this.autocompleteOverlayOptions.row === layout.row) return false;
		this.autocompleteOverlayOptions.row = layout.row;
		return true;
	}
}
