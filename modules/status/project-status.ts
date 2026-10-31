import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sanitizeSingleLine } from "../../shared/sanitize.ts";
import type { RuntimeStatusSnapshot } from "./runtime-status.ts";
import type { TurnTimerSnapshot } from "./turn-timer.ts";

export type GitRefreshState = "idle" | "loading" | "ready" | "error";
export type ProjectStatusSegmentId = "project" | "session" | "git" | "duration" | "runtime";

export interface GitStatusCodeCount {

	code: string;
	count: number;
	unmerged: boolean;
}

export interface GitStatusDetails {
	branch: string | null;
	detached: boolean;
	unborn: boolean;
	oid?: string;
	exactTag?: string;
	upstream?: string;
	ahead: number;
	behind: number;
	stashed: number;
	statusCodes: GitStatusCodeCount[];
	dirty: boolean;
}

export interface ProjectStatusSnapshot extends Partial<GitStatusDetails> {
	cwd: string;
	branch: string | null;
	refreshState?: GitRefreshState;
	runtime?: RuntimeStatusSnapshot | null;
	duration?: TurnTimerSnapshot;

	sessionShort?: string | null;
}

export type GitStatusQuery = (
	cwd: string,
	signal: AbortSignal,
) => Promise<GitStatusDetails | undefined>;

export function createGitStatusQuery(exec: ExtensionAPI["exec"]): GitStatusQuery {
	return async (cwd, signal) => {
		try {
			const result = await exec(
				"git",
				[
					"--no-optional-locks",
					"status",
					"--porcelain=v2",
					"--branch",
					"--show-stash",
					"--untracked-files=normal",
					"--ignore-submodules=dirty",
				],
				{ cwd, signal, timeout: 2000 },
			);
			if (result.killed || result.code !== 0) return undefined;
			const status = parseGitStatusV2(result.stdout);
			if (!status.detached || !status.oid) return status;

			const tags = await exec(
				"git",
				["--no-optional-locks", "tag", "--points-at", status.oid, "--sort=refname"],
				{ cwd, signal, timeout: 2000 },
			);
			if (tags.killed || tags.code !== 0) return status;
			const exactTag = tags.stdout
				.split("\n")
				.map((tag) => tag.trim())
				.filter(Boolean)[0];
			return exactTag ? { ...status, exactTag } : status;
		} catch {
			return undefined;
		}
	};
}

export function parseGitStatusV2(stdout: string, exactTag?: string): GitStatusDetails {
	const status: GitStatusDetails = {
		branch: null,
		detached: false,
		unborn: false,
		ahead: 0,
		behind: 0,
		stashed: 0,
		statusCodes: [],
		dirty: false,
	};
	const statusCodes = new Map<string, GitStatusCodeCount>();
	const addStatusCode = (code: string, unmerged: boolean): void => {
		const previous = statusCodes.get(code);
		if (previous) {
			previous.count += 1;
			previous.unmerged ||= unmerged;
			return;
		}
		statusCodes.set(code, { code, count: 1, unmerged });
	};

	for (const line of stdout.split("\n")) {
		if (line.startsWith("# branch.oid ")) {
			const value = line.slice("# branch.oid ".length).trim();
			if (value === "(initial)") status.unborn = true;
			else if (value) status.oid = value;
			continue;
		}
		if (line.startsWith("# branch.head ")) {
			const value = sanitizeSingleLine(line.slice("# branch.head ".length));
			status.detached = value === "(detached)";
			status.branch = status.detached ? null : value || null;
			continue;
		}
		if (line.startsWith("# branch.upstream ")) {
			status.upstream = sanitizeSingleLine(line.slice("# branch.upstream ".length)) || undefined;
			continue;
		}
		if (line.startsWith("# branch.ab ")) {
			const match = line.match(/^# branch\.ab \+(\d+) -(\d+)$/);
			if (match) {
				status.ahead = Number.parseInt(match[1] ?? "0", 10);
				status.behind = Number.parseInt(match[2] ?? "0", 10);
			}
			continue;
		}
		if (line.startsWith("# stash ")) {
			const count = Number.parseInt(line.slice("# stash ".length).trim(), 10);
			if (Number.isFinite(count)) status.stashed = count;
			continue;
		}
		const unmerged = line.match(/^u ([.MTADRCU]{2}) /);
		if (unmerged) {
			addStatusCode(unmerged[1] ?? "UU", true);
			status.dirty = true;
			continue;
		}
		if (line.startsWith("? ")) {
			addStatusCode("?", false);
			status.dirty = true;
			continue;
		}

		const tracked = line.match(/^[12] ([.MTADRCU]{2}) /);
		if (!tracked) continue;
		addStatusCode(tracked[1] ?? "..", false);
		status.dirty = true;
	}

	status.statusCodes = [...statusCodes.values()];
	if (status.detached && exactTag) status.exactTag = sanitizeSingleLine(exactTag) || undefined;
	return status;
}

export class ProjectStatusController {
	private readonly cwd: string;
	private readonly queryGitStatus: GitStatusQuery;
	private readonly debounceMs: number;
	private readonly pollIntervalMs: number;
	private details: GitStatusDetails | undefined;
	private refreshState: GitRefreshState = "idle";
	private refreshTimer: ReturnType<typeof setTimeout> | undefined;
	private pollTimer: ReturnType<typeof setInterval> | undefined;
	private refreshInFlight = false;
	private refreshPending = false;
	private abortController: AbortController | undefined;
	private connected = false;
	private disposed = false;

	constructor(cwd: string, queryGitStatus: GitStatusQuery, debounceMs = 120, pollIntervalMs = 1000) {
		this.cwd = cwd;
		this.queryGitStatus = queryGitStatus;
		this.debounceMs = debounceMs;
		this.pollIntervalMs = pollIntervalMs;
	}

	connect(): void {
		this.disconnect();
		if (this.disposed) return;
		this.connected = true;
		this.requestRefresh(0);
		if (this.pollIntervalMs > 0) {
			this.pollTimer = setInterval(() => this.requestPollRefresh(), this.pollIntervalMs);
			this.pollTimer.unref();
		}
	}

	disconnect(): void {
		this.connected = false;
		if (this.pollTimer) clearInterval(this.pollTimer);
		this.pollTimer = undefined;
	}

	getSnapshot(): ProjectStatusSnapshot {
		return {
			cwd: this.cwd,
			branch: this.details?.branch ?? null,
			...this.details,
			refreshState: this.refreshState,
		};
	}

	requestRefresh(delay = this.debounceMs): void {
		if (this.disposed || !this.connected || this.refreshTimer) return;
		if (this.refreshInFlight) {
			this.refreshPending = true;
			return;
		}
		this.scheduleRefresh(delay);
	}

	private requestPollRefresh(): void {
		if (this.disposed || !this.connected || this.refreshTimer || this.refreshInFlight) return;
		this.scheduleRefresh(0);
	}

	private scheduleRefresh(delay: number): void {
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = undefined;
			void this.refresh();
		}, delay);
	}

	async refresh(): Promise<void> {
		if (this.disposed || !this.connected) return;
		if (this.refreshInFlight) {
			this.refreshPending = true;
			return;
		}

		this.refreshInFlight = true;
		if (this.refreshState === "idle") this.refreshState = "loading";
		const abortController = new AbortController();
		this.abortController = abortController;
		try {
			const result = await this.queryGitStatus(this.cwd, abortController.signal);
			if (this.disposed) return;
			if (!result) {
				this.refreshState = "error";
				return;
			}
			this.details = result;
			this.refreshState = "ready";
		} finally {
			if (this.abortController === abortController) this.abortController = undefined;
			this.refreshInFlight = false;
			if (this.refreshPending && !this.disposed) {
				this.refreshPending = false;
				this.requestRefresh(0);
			}
		}
	}

	dispose(): void {
		this.disposed = true;
		if (this.refreshTimer) clearTimeout(this.refreshTimer);
		this.refreshTimer = undefined;
		this.abortController?.abort();
		this.abortController = undefined;
		this.disconnect();
	}
}
