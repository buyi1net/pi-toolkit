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

	// 实例级拦截：宿主真实 terminal（jiti 双副本下 prototype patch 拦不到宿主）。
	private hookedTerminal: TerminalWriteTarget | undefined;
	private instanceOriginalWrite: ((data: string) => void) | undefined;
	// 拦截挂接前的看门狗：holding 且 hook 未挂期间宿主仍在渲染原生帧（真实配置
	// 下扩展初始化可达数秒），以约一帧的间隔清屏，落屏帧最多存活 16ms——
	// 低于单行文字的感知阈值；空屏上的清屏是视觉 no-op，不会闪烁。
	private guardTimer: ReturnType<typeof setInterval> | undefined;

	constructor(output: TransitionOutput = process.stdout) {
		this.output = output;
	}

	/** 同一实例重复挂接不叠加拦截；换绑时先恢复旧实例，避免旧终端继续持闸。 */
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

	/** 清屏和揭示必须绕过拦截，否则控制序列也会被持闸。 */
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

		// 首次启动时隐藏宿主的未装饰帧；reload 时保留当前画面，最终帧会原位覆盖，
		// 避免 Windows Terminal 把整屏清除前的内容留进回滚历史形成重复残影。
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
			// 经 output 直写清屏：此时 hook 未挂，宿主 write 不经闸门。
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
			// 闸门关闭期间仍让 Pi 完成一次内部渲染，随后直接揭示准备好的可见区。
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
					// 状态已经与最终帧一致；这一轮只让 Pi 恢复 IME 硬件光标。
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
		// 已解除持闸，按捕获来源回放；换绑后的当前直写通道不再属于旧终端。
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
		// jiti 会在 /reload 时载入新的模块实例，但全局闸门必须沿用同一份拦截状态。
		// 把旧实例升级到当前原型，避免同一 Pi 进程一直执行上一个版本的方法。
		Object.setPrototypeOf(gate, TerminalTransitionGate.prototype);
		// 能复用全局实例说明当前进程已经展示过上一版插件界面；旧实例没有该字段。
		if (typeof (gate as unknown as { hasVisibleFrame?: unknown }).hasVisibleFrame !== "boolean") {
			(gate as unknown as { hasVisibleFrame: boolean }).hasVisibleFrame = true;
		}
		return gate;
	}
	const gate = new TerminalTransitionGate(output);
	globalState[GLOBAL_GATE_KEY] = gate;
	return gate;
}
