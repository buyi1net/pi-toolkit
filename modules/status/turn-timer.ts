// status 模块数据源：回合计时器的状态与控制器（工单 11 从 tui/status/status-segments.ts 切出）。
//
// 计时状态归数据模块：控制器由 status 模块装配时创建并经 `status.timer` 句柄透出；
// 渲染（顶边 duration 段的颜色与排版）留在 tui 侧（status-segments.ts、plugin/editor.ts）。
//
// 重绘节奏属于 tui（工单 18）：控制器不持重绘回调、也不自带定时器；快照内容（working 期间的
// 毫秒级 elapsedMs）变化由 `status.timer` 句柄按内容比较体现为变更序号，tui 心跳按序号重绘。

export type TurnTimerState = "idle" | "working" | "done";

export interface TurnTimerSnapshot {
	state: TurnTimerState;
	elapsedMs: number;
}

export class TurnTimerController {
	private readonly now: () => number;
	private startedAt: number | undefined;
	private completedElapsedMs: number | undefined;
	private disposed = false;

	constructor(now: () => number = Date.now, completedElapsedMs?: number) {
		this.now = now;
		if (Number.isFinite(completedElapsedMs) && (completedElapsedMs ?? -1) >= 0) {
			this.completedElapsedMs = completedElapsedMs;
		}
	}

	start(): void {
		if (this.disposed) return;
		this.startedAt = this.now();
		this.completedElapsedMs = undefined;
	}

	end(): number | undefined {
		if (this.disposed || this.startedAt === undefined) return undefined;
		this.completedElapsedMs = Math.max(0, this.now() - this.startedAt);
		this.startedAt = undefined;
		return this.completedElapsedMs;
	}

	restore(elapsedMs: number): void {
		if (this.disposed || !Number.isFinite(elapsedMs) || elapsedMs < 0) return;
		this.startedAt = undefined;
		this.completedElapsedMs = elapsedMs;
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
		this.disposed = true;
	}
}
