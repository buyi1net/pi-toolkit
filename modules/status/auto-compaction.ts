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
