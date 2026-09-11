import type {
	TUI,
	TuiMainScreenRenderState,
} from "@earendil-works/pi-tui";

/** 终端输出抽象：测试可注入伪 TTY。 */
export type VisibleScreenOutput = {
	isTTY?: boolean;
};

export const CLEAR_VISIBLE_SCREEN = "\x1b[2J\x1b[H";
export const DIRTY_RENDER_SUFFIX = "\x00";
/** 过渡揭示的稳定等待：超过该时长没有新 Editor 帧即视为结构稳定。 */
export const TRANSITION_SETTLE_MS = 32;

export function isInteractiveLaunch(): boolean {
	if (!process.stdout.isTTY) return false;
	const nonInteractiveFlags = new Set([
		"-p",
		"--print",
		"--help",
		"-h",
		"--version",
		"-v",
		"--list-models",
		"--export",
	]);
	return process.argv.slice(2).every((arg) => !nonInteractiveFlags.has(arg) && !arg.startsWith("--mode"));
}

type MainScreenTui = TUI & {
	captureRenderState(): TuiMainScreenRenderState;
	restoreRenderState(state: TuiMainScreenRenderState): void;
};

export function isMainScreenTui(tui: TUI): tui is MainScreenTui {
	return (
		tui.mode === "regular" &&
		typeof (tui as Partial<MainScreenTui>).captureRenderState === "function" &&
		typeof (tui as Partial<MainScreenTui>).restoreRenderState === "function"
	);
}

function hasImageLine(lines: readonly string[]): boolean {
	return lines.some((line) => line.includes("\x1b_G") || line.includes("\x1b]1337;File="));
}

export function isSafeRenderState(tui: TUI, state: TuiMainScreenRenderState): boolean {
	const width = tui.terminal.columns;
	const height = tui.terminal.rows;
	if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
		return false;
	}
	if (state.previousWidth !== width || state.previousHeight !== height) return false;
	if (!Array.isArray(state.previousLines) || state.previousLines.length === 0) return false;
	if (hasImageLine(state.previousLines)) return false;
	if (!Number.isSafeInteger(state.previousViewportTop) || state.previousViewportTop < 0) return false;
	return state.previousViewportTop === Math.max(0, state.previousLines.length - height);
}

function isPristineRenderState(state: TuiMainScreenRenderState): boolean {
	return (
		Array.isArray(state.previousLines) &&
		state.previousLines.length === 0 &&
		state.previousWidth === 0 &&
		state.previousHeight === 0 &&
		state.previousViewportTop === 0 &&
		state.cursorRow === 0 &&
		state.hardwareCursorRow === 0 &&
		state.maxLinesRendered === 0
	);
}

function hasStableRenderState(
	left: TuiMainScreenRenderState,
	right: TuiMainScreenRenderState,
): boolean {
	if (
		left.previousWidth !== right.previousWidth ||
		left.previousHeight !== right.previousHeight ||
		left.previousViewportTop !== right.previousViewportTop ||
		left.previousLines.length !== right.previousLines.length
	) {
		return false;
	}
	return left.previousLines.every((line, index) => line === right.previousLines[index]);
}

export function flashVisibleScreen(
	tui: TUI,
	output: VisibleScreenOutput = process.stdout,
): TuiMainScreenRenderState | undefined {
	if (!output.isTTY || !isMainScreenTui(tui) || tui.hasOverlay()) return undefined;
	let state: TuiMainScreenRenderState;
	try {
		state = tui.captureRenderState();
	} catch {
		return undefined;
	}
	if (!isPristineRenderState(state) && !isSafeRenderState(tui, state)) return undefined;

	try {
		tui.terminal.write(CLEAR_VISIBLE_SCREEN);
		return state;
	} catch {
		forceRestoreClearedScreen(tui);
		return undefined;
	}
}

function forceRestoreClearedScreen(tui: TUI): void {
	try {
		tui.renderNow(true);
	} catch {
		// 强制重画已经是闪屏后的最后恢复路径。
	}
}

function captureStableMainScreenState(tui: TUI): TuiMainScreenRenderState | undefined {
	try {
		tui.renderNow(false);
		if (!isMainScreenTui(tui) || tui.hasOverlay()) return undefined;
		const firstState = tui.captureRenderState();
		if (!isSafeRenderState(tui, firstState)) return undefined;

		// 连续两次同步渲染必须完全稳定，否则不能保证恢复范围。
		tui.renderNow(false);
		const state = tui.captureRenderState();
		if (!isSafeRenderState(tui, state) || !hasStableRenderState(firstState, state)) {
			return undefined;
		}
		return state;
	} catch {
		return undefined;
	}
}

function revealPreparedMainScreen(
	tui: TUI,
	deferred: boolean,
	screenAlreadyCleared: boolean,
): boolean {
	try {
		if (deferred) tui.requestRender(false);
		else tui.renderNow(false);
		return true;
	} catch {
		if (screenAlreadyCleared) forceRestoreClearedScreen(tui);
		return false;
	}
}

export function restoreVisibleMainScreen(
	tui: TUI,
	preClearState?: TuiMainScreenRenderState,
	deferred = false,
): boolean {
	const screenAlreadyCleared = preClearState !== undefined;
	const state = preClearState ?? captureStableMainScreenState(tui);
	if (!state) {
		if (screenAlreadyCleared) forceRestoreClearedScreen(tui);
		return false;
	}
	if (!isMainScreenTui(tui)) {
		if (screenAlreadyCleared) forceRestoreClearedScreen(tui);
		return false;
	}
	if (screenAlreadyCleared && isPristineRenderState(state)) {
		return revealPreparedMainScreen(tui, deferred, true);
	}

	const top = state.previousViewportTop;
	const bottom = Math.min(state.previousLines.length, top + state.previousHeight);
	if (bottom <= top) {
		if (screenAlreadyCleared) forceRestoreClearedScreen(tui);
		return false;
	}
	const previousLines = state.previousLines.map((line, index) =>
		index >= top && index < bottom ? `${line}${DIRTY_RENDER_SUFFIX}` : line,
	);

	try {
		tui.restoreRenderState({
			...state,
			previousLines,
			cursorRow: top,
			hardwareCursorRow: top,
			maxLinesRendered: 0,
		});
	} catch {
		try {
			tui.restoreRenderState(state);
		} catch {
			// renderer 状态未改变时无需继续恢复。
		}
		if (screenAlreadyCleared) forceRestoreClearedScreen(tui);
		else tui.renderNow(false);
		return false;
	}

	if (!screenAlreadyCleared) tui.terminal.write(CLEAR_VISIBLE_SCREEN);
	return revealPreparedMainScreen(tui, deferred, screenAlreadyCleared);
}
