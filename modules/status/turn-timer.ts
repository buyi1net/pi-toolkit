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
