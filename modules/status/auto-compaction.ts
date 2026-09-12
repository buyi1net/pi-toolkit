// status 模块数据源：自动压缩开关的读取与监听（从 tui/status/ 整体迁入，工单 11）。
//
// 设置文件的监视器与控制器都归数据模块；`status.compaction` 句柄透出当前开关，
// 渲染（footer 用量行里的 Auto/Off 段）留在 tui 侧。
//
// 重绘节奏属于 tui（工单 18）：控制器不持重绘回调，开关值变化体现为快照上的变更序号，
// tui 心跳按序号变化决定是否重绘。

import { watch } from "node:fs";

export function watchAgentSettings(agentDir: string, onChange: () => void): () => void {
	try {
		const watcher = watch(agentDir, { persistent: false }, (_eventType, filename) => {
			if (filename && filename.toString().toLowerCase() !== "settings.json") return;
			onChange();
		});
		watcher.on("error", () => {});
		return () => watcher.close();
	} catch {
		return () => {};
	}
}

/** `status.compaction` 快照：开关值 + 变更序号（序号由控制器在值变化时递增） */
export interface AutoCompactionSnapshot {
	enabled: boolean;
	revision: number;
}

export class AutoCompactionStatusController {
	private enabled: boolean;
	private revision = 0;
	private readonly readEnabled: () => boolean;
	private readonly stopWatching: () => void;
	private disposed = false;

	constructor(
		readEnabled: () => boolean,
		subscribe: (onChange: () => void) => () => void,
	) {
		this.readEnabled = readEnabled;
		this.enabled = this.readCurrentValue();
		try {
			this.stopWatching = subscribe(() => this.refresh());
		} catch {
			this.stopWatching = () => {};
		}
	}

	getSnapshot(): AutoCompactionSnapshot {
		return { enabled: this.enabled, revision: this.revision };
	}

	refresh(): void {
		if (this.disposed) return;
		const enabled = this.readCurrentValue();
		if (enabled === this.enabled) return;
		this.enabled = enabled;
		this.revision += 1;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		try {
			this.stopWatching();
		} catch {
			// 文件监听清理失败不能阻断其余 UI 组件的回滚。
		}
	}

	private readCurrentValue(): boolean {
		try {
			return this.readEnabled();
		} catch {
			return false;
		}
	}
}
