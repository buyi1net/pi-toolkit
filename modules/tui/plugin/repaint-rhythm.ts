// tui 统一重绘节奏（工单 18 / 决策 9）：一秒一拍，检查各状态快照上的变更序号，
// 任一条变化就请求重绘。
//
// 背景：服务注册表的句柄契约只有 snapshot/refresh，没有变更通知；git 轮询、设置文件
// 监听、供应商轮询这类外部变化不会触发宿主事件，由本模块的心跳读快照序号后补一帧。
// 宿主事件驱动的即时重绘仍留在 lifecycle 里；本模块只管心跳这一路。
//
// 本模块不依赖 TUI：requestRender 由调用方注入并自行做转场闸门保护；
// tick() 可直接驱动，便于单测注入假快照序列。

/** 参与变化检测的快照最小外形：模块内部维护、随快照带出的变更序号 */
export interface RepaintRevisioned {
	readonly revision: number;
}

/** 一条被检测的快照源；id 只用于诊断与去重 */
export interface RepaintSource {
	readonly id: string;
	read(): RepaintRevisioned | undefined;
}

export interface RepaintRhythmOptions {
	readonly sources: readonly RepaintSource[];
	/** 检测到变化时的重绘请求；调用方自行做转场闸门保护 */
	readonly requestRender: () => void;
	/** 心跳间隔，默认 1000ms */
	readonly intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 1_000;

export class RepaintRhythm {
	private readonly sources: readonly RepaintSource[];
	private readonly requestRender: () => void;
	private readonly intervalMs: number;
	/** 上一拍的序号；undefined 表示该源上一拍没有快照 */
	private readonly lastSeen = new Map<string, number | undefined>();
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(options: RepaintRhythmOptions) {
		this.sources = options.sources;
		this.requestRender = options.requestRender;
		this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
	}

	/** 开始心跳；重复调用只保留一个定时器，并从零建立检测基线 */
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

	/**
	 * 单拍检查：任一条快照的序号与本拍之前不同（含快照出现 / 消失）就请求一次重绘。
	 * 首次读到某条快照只建立基线，不重绘（安装路径自己会出帧）；返回本拍是否请求了重绘。
	 */
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

	/** 单个数据源读失败按「无快照」处理：心跳不能把异常抛进事件循环 */
	private readRevision(source: RepaintSource): number | undefined {
		try {
			return source.read()?.revision;
		} catch {
			return undefined;
		}
	}
}
