// status 模块数据源：回合计时器的状态与控制器（工单 11 从 tui/status/status-segments.ts 切出）。
//
// 计时状态归数据模块：控制器由 status 模块装配时创建并经 `status.timer` 句柄透出；
// 渲染（顶边 duration 段的颜色与排版）留在 tui 侧（status-segments.ts、plugin/editor.ts）。
//
// 重绘节奏属于 tui：本文件不再持有 requestRender 的调用权，构造参数保留 `() => void`
// 只是接口形态（status 模块传空操作），tui 侧按自己的心跳读快照后重绘。

export type TurnTimerState = "idle" | "working" | "done";

export interface TurnTimerSnapshot {
	state: TurnTimerState;
	elapsedMs: number;
}

export class TurnTimerController {
	private readonly requestRender: () => void;
	private readonly intervalMs: number;
	private readonly now: () => number;
	private startedAt: number | undefined;
	private completedElapsedMs: number | undefined;
	private interval: ReturnType<typeof setInterval> | undefined;
	private disposed = false;

	constructor(
		requestRender: () => void = () => {},
		intervalMs = 1000,
		now: () => number = Date.now,
		completedElapsedMs?: number,
	) {
		this.requestRender = requestRender;
		this.intervalMs = intervalMs;
		this.now = now;
		if (Number.isFinite(completedElapsedMs) && (completedElapsedMs ?? -1) >= 0) {
			this.completedElapsedMs = completedElapsedMs;
		}
	}

	start(): void {
		if (this.disposed) return;
		this.stopInterval();
		this.startedAt = this.now();
		this.completedElapsedMs = undefined;
		this.interval = setInterval(() => this.requestRender(), this.intervalMs);
		this.interval.unref();
		this.requestRender();
	}

	end(): number | undefined {
		if (this.disposed || this.startedAt === undefined) return undefined;
		this.completedElapsedMs = Math.max(0, this.now() - this.startedAt);
		this.startedAt = undefined;
		this.stopInterval();
		this.requestRender();
		return this.completedElapsedMs;
	}

	restore(elapsedMs: number): void {
		if (this.disposed || !Number.isFinite(elapsedMs) || elapsedMs < 0) return;
		this.startedAt = undefined;
		this.completedElapsedMs = elapsedMs;
		this.stopInterval();
		this.requestRender();
	}

	getSnapshot(): TurnTimerSnapshot {
		if (this.startedAt !== undefined) {
			return {
				state: "working",
				elapsedMs: Math.max(0, this.now() - this.startedAt),
			};
		}
		if (this.completedElapsedMs !== undefined) {
			return { state: "done", elapsedMs: this.completedElapsedMs };
		}
		return { state: "idle", elapsedMs: 0 };
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.stopInterval();
	}

	private stopInterval(): void {
		if (this.interval) clearInterval(this.interval);
		this.interval = undefined;
	}
}
