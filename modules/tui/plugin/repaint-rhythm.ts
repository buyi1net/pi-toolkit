export interface RepaintRevisioned {
	readonly revision: number;
}

export interface RepaintSource {
	readonly id: string;
	read(): RepaintRevisioned | undefined;
}

export interface RepaintRhythmOptions {
	readonly sources: readonly RepaintSource[];

	readonly requestRender: () => void;

	readonly intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 1_000;

export class RepaintRhythm {
	private readonly sources: readonly RepaintSource[];
	private readonly requestRender: () => void;
	private readonly intervalMs: number;

	private readonly lastSeen = new Map<string, number | undefined>();
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(options: RepaintRhythmOptions) {
		this.sources = options.sources;
		this.requestRender = options.requestRender;
		this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
	}

	start(): void {
		if (this.timer) return;
		this.lastSeen.clear();
		this.timer = setInterval(() => {
			this.tick();
		}, this.intervalMs);
		this.timer.unref?.();
	}

	stop(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = undefined;
	}

	tick(): boolean {
		let changed = false;
		for (const source of this.sources) {
			const revision = this.readRevision(source);
			if (this.lastSeen.has(source.id) && this.lastSeen.get(source.id) !== revision) changed = true;
			this.lastSeen.set(source.id, revision);
		}
		if (changed) this.requestRender();
		return changed;
	}

	private readRevision(source: RepaintSource): number | undefined {
		try {
			return source.read()?.revision;
		} catch {
			return undefined;
		}
	}
}
