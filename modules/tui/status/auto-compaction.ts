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

export class AutoCompactionStatusController {
	private enabled: boolean;
	private readonly readEnabled: () => boolean;
	private readonly requestRender: () => void;
	private readonly stopWatching: () => void;
	private disposed = false;

	constructor(
		readEnabled: () => boolean,
		subscribe: (onChange: () => void) => () => void,
		requestRender: () => void,
	) {
		this.readEnabled = readEnabled;
		this.requestRender = requestRender;
		this.enabled = this.readCurrentValue();
		try {
			this.stopWatching = subscribe(() => this.refresh());
		} catch {
			this.stopWatching = () => {};
		}
	}

	getSnapshot(): boolean {
		return this.enabled;
	}

	refresh(): void {
		if (this.disposed) return;
		const enabled = this.readCurrentValue();
		if (enabled === this.enabled) return;
		this.enabled = enabled;
		this.requestRender();
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
