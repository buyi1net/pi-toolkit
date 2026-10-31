import type {
	TUI,
	TuiMainScreenRenderState,
} from "@earendil-works/pi-tui";

const CLEAR_VISIBLE_SCREEN = "\x1b[2J\x1b[H";
const BEGIN_SYNCHRONIZED_OUTPUT = "\x1b[?2026h";
const END_SYNCHRONIZED_OUTPUT = "\x1b[?2026l";
const MAX_HELD_OUTPUT_BYTES = 2 * 1024 * 1024;
const FAIL_OPEN_AFTER_MS = 10_000;
const GUARD_CLEAR_INTERVAL_MS = 16;
const GLOBAL_GATE_KEY = "__piTuiTerminalTransitionGateV1";

type TerminalWriteTarget = {
	write(data: string): void;
};

type TransitionOutput = {
	isTTY?: boolean;
	write(data: string): unknown;
};

type MainScreenTui = TUI & {
	captureRenderState(): TuiMainScreenRenderState;
	restoreRenderState(state: TuiMainScreenRenderState): void;
};

type HeldWrite = {
	terminal: TerminalWriteTarget;
	data: string;
};

export interface TransitionHoldOptions {
	clearVisibleScreen?: boolean;
}

function isMainScreenTui(tui: TUI): tui is MainScreenTui {
	return (
		tui.mode === "regular" &&
		typeof (tui as Partial<MainScreenTui>).captureRenderState === "function" &&
		typeof (tui as Partial<MainScreenTui>).restoreRenderState === "function"
	);
}

function canRedrawVisibleViewport(tui: TUI, state: TuiMainScreenRenderState): boolean {
	const width = tui.terminal.columns;
	const height = tui.terminal.rows;
	if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
		return false;
	}
	if (!Array.isArray(state.previousLines) || state.previousLines.length === 0) return false;
	if (state.previousLines.some((line) => line.includes("\x1b_G") || line.includes("\x1b]1337;File="))) {
		return false;
	}
	return Number.isSafeInteger(state.previousViewportTop) && state.previousViewportTop >= 0;
}

export class TerminalTransitionGate {
	private readonly output: TransitionOutput;
	private holding = false;
	private heldWrites: HeldWrite[] = [];
	private heldOutputBytes = 0;
	private failOpenTimer: ReturnType<typeof setTimeout> | undefined;
	private hasVisibleFrame = false;

	private hookedTerminal: TerminalWriteTarget | undefined;
	private instanceOriginalWrite: ((data: string) => void) | undefined;

	private guardTimer: ReturnType<typeof setInterval> | undefined;

	constructor(output: TransitionOutput = process.stdout) {
		this.output = output;
	}

	hookTerminal(terminal: TerminalWriteTarget): void {
		if (this.hookedTerminal === terminal) return;
		this.stopGuardTimer();
		if (this.hookedTerminal && this.instanceOriginalWrite) {
			this.hookedTerminal.write = this.instanceOriginalWrite;
		}
		const originalWrite = terminal.write;
		this.hookedTerminal = terminal;
		this.instanceOriginalWrite = originalWrite;
		const gate = this;
		terminal.write = (data: string): void => {
			if (!gate.holding) {
				originalWrite.call(terminal, data);
				return;
			}
			gate.captureWrite(terminal, data);
		};
	}

	private writeThrough(data: string): void {
		if (this.hookedTerminal && this.instanceOriginalWrite) {
			this.instanceOriginalWrite.call(this.hookedTerminal, data);
			return;
		}
		this.output.write(data);
	}

	isHolding(): boolean {
		return this.holding;
	}

	hold(tui?: TUI, options: TransitionHoldOptions = {}): boolean {
		if (!this.output.isTTY) return false;
		if (this.holding) {
			if (options.clearVisibleScreen) this.clearVisibleScreen(tui);
			return true;
		}

		if (!this.hasVisibleFrame || options.clearVisibleScreen) {
			this.writeThrough(CLEAR_VISIBLE_SCREEN);
		}

		this.holding = true;
		this.heldWrites = [];
		this.heldOutputBytes = 0;
		this.armFailOpen();
		this.startGuardTimer();
		return true;
	}

	private startGuardTimer(): void {
		if (this.guardTimer || this.hookedTerminal) return;
		this.guardTimer = setInterval(() => {
			if (!this.holding || this.hookedTerminal) {
				this.stopGuardTimer();
				return;
			}

			this.output.write(CLEAR_VISIBLE_SCREEN);
		}, GUARD_CLEAR_INTERVAL_MS);
		this.guardTimer.unref?.();
	}

	private stopGuardTimer(): void {
		if (!this.guardTimer) return;
		clearInterval(this.guardTimer);
		this.guardTimer = undefined;
	}

	private clearVisibleScreen(_tui?: TUI): void {
		this.writeThrough(CLEAR_VISIBLE_SCREEN);
	}

	reveal(tui: TUI): boolean {
		if (!this.holding) return false;

		try {

			tui.renderNow(false);
			if (isMainScreenTui(tui)) {
				const state = tui.captureRenderState();
				if (canRedrawVisibleViewport(tui, state)) {
					const height = tui.terminal.rows;
					const maxViewportTop = Math.max(0, state.previousLines.length - height);
					const top = Math.min(state.previousViewportTop, maxViewportTop);
					const bottom = Math.min(state.previousLines.length, top + height);
					tui.restoreRenderState({
						...state,
						hardwareCursorRow: Math.max(top, bottom - 1),
					});
					this.release(false);
					const visibleLines = state.previousLines.slice(top, bottom);
					this.writeThrough(
						`${BEGIN_SYNCHRONIZED_OUTPUT}\x1b[H${visibleLines.join("\r\n")}\x1b[J${END_SYNCHRONIZED_OUTPUT}`,
					);
					this.hasVisibleFrame = true;

					tui.renderNow(false);
					return true;
				}
			}

			this.release(false);
			tui.renderNow(true);
			this.hasVisibleFrame = true;
			return true;
		} catch {
			this.release(true);
			try {
				tui.renderNow(true);
			} catch {
				// 已回放被拦截的输出，不能再安全恢复时保持宿主当前终端状态。
			}
			return false;
		}
	}

	release(replayHeldOutput = false): void {
		if (!this.holding) return;
		this.stopGuardTimer();
		this.holding = false;
		this.clearFailOpenTimer();
		const heldWrites = this.heldWrites;
		this.heldWrites = [];
		this.heldOutputBytes = 0;
		if (!replayHeldOutput) return;

		for (const held of heldWrites) {
			held.terminal.write(held.data);
		}
	}

	private captureWrite(terminal: TerminalWriteTarget, data: string): void {
		this.heldWrites.push({ terminal, data });
		this.heldOutputBytes += Buffer.byteLength(data);
		if (this.heldOutputBytes > MAX_HELD_OUTPUT_BYTES) this.release(true);
	}

	private armFailOpen(): void {
		this.clearFailOpenTimer();
		this.failOpenTimer = setTimeout(() => this.release(true), FAIL_OPEN_AFTER_MS);
		this.failOpenTimer.unref?.();
	}

	private clearFailOpenTimer(): void {
		if (!this.failOpenTimer) return;
		clearTimeout(this.failOpenTimer);
		this.failOpenTimer = undefined;
	}
}

export function getTerminalTransitionGate(
	output: TransitionOutput = process.stdout,
): TerminalTransitionGate {
	const globalState = globalThis as typeof globalThis & Record<string, unknown>;
	const existing = globalState[GLOBAL_GATE_KEY];
	if (
		existing !== null &&
		typeof existing === "object" &&
		"hold" in existing &&
		typeof existing.hold === "function" &&
		"reveal" in existing &&
		typeof existing.reveal === "function" &&
		"release" in existing &&
		typeof existing.release === "function"
	) {
		const gate = existing as TerminalTransitionGate;

		Object.setPrototypeOf(gate, TerminalTransitionGate.prototype);

		if (typeof (gate as unknown as { hasVisibleFrame?: unknown }).hasVisibleFrame !== "boolean") {
			(gate as unknown as { hasVisibleFrame: boolean }).hasVisibleFrame = true;
		}
		return gate;
	}
	const gate = new TerminalTransitionGate(output);
	globalState[GLOBAL_GATE_KEY] = gate;
	return gate;
}
