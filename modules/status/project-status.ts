// status 模块数据源：git 数据域（工单 07 定案 7：git 不成模块，作为 status 模块内的数据源文件）。
//
// 本文件是 tui/status/project-status.ts 的**数据半**（工单 11 切分）：
// 查询（createGitStatusQuery）、解析（parseGitStatusV2）、git 状态类型与数据侧控制器。
// 渲染半（布局 / 截断 / 颜色 / renderProjectStatusLine / formatProjectPath）留在
// tui/status/project-status.ts。git 没有独立句柄，数据经 `status.workspace` 快照透出。
//
// 与迁出前的差异（工单 11 自行定案，见工单结果）：控制器不再接收宿主 FooterData
// （ReadonlyFooterDataProvider 由 tui 的 footer 独占消费），因此去掉临时分支（provisional
// branch）与 onBranchChange 订阅；分支在首次 git 查询返回前显示占位 "…"，
// 之后由 1 秒轮询与 tool_execution_end 触发的刷新保持最新。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sanitizeSingleLine } from "../../shared/sanitize.ts";
import type { RuntimeStatusSnapshot } from "./runtime-status.ts";
import type { TurnTimerSnapshot } from "./turn-timer.ts";

export type GitRefreshState = "idle" | "loading" | "ready" | "error";
export type ProjectStatusSegmentId = "project" | "session" | "git" | "duration" | "runtime";

export interface GitStatusCodeCount {
	/** Git porcelain v2 的原始可见状态码；普通记录为 XY，未跟踪记录为 ?。 */
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

/** `status.workspace` 快照：project / git / duration / runtime 四段聚合 */
export interface ProjectStatusSnapshot extends Partial<GitStatusDetails> {
	cwd: string;
	branch: string | null;
	refreshState?: GitRefreshState;
	runtime?: RuntimeStatusSnapshot | null;
	duration?: TurnTimerSnapshot;
	/** 会话短码（工单 48，不带 #）：由 footer 现场注入；取不到时该段隐藏 */
	sessionShort?: string | null;
}

export type GitStatusQuery = (
	cwd: string,
	signal: AbortSignal,
) => Promise<GitStatusDetails | undefined>;

/** 命令失败不向界面抛错，返回 undefined 让控制器保留最后成功快照。 */
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

			// 绑定本次 status 的 oid，避免两次命令之间 HEAD 移动导致 tag 串配。
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

	/** 开始查询（含 1 秒轮询）；数据变化由 `status.workspace` 快照的变更序号带出，控制器不触发重绘 */
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
