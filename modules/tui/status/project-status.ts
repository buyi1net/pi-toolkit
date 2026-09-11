import { posix, win32 } from "node:path";
import type {
	ExtensionAPI,
	ReadonlyFooterDataProvider,
	Theme,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
	formatLeadingIcon,
	resolveGlyphs,
	type IconGlyphs,
} from "../renderer/icons.ts";
import type { RuntimeStatusSnapshot } from "./runtime-status.ts";
import {
	durationStatusColor,
	formatElapsed,
	type TurnTimerSnapshot,
} from "./status-segments.ts";

const SEPARATOR = " · ";
const MIN_SEGMENT_WIDTH = 8;
const DEFAULT_GLYPHS = resolveGlyphs("unicode");
const DEFAULT_PROJECT_STATUS_SEGMENTS: readonly ProjectStatusSegmentId[] = ["project", "git"];
const SAFE_SGR_SEQUENCE = /\x1b\[[0-9:;]*m/g;
const STYLE_MARKER_START = "\ufdd0";
const STYLE_MARKER_END = "\ufdd1";
const STYLE_MARKER_SEQUENCE = /\ufdd0(\d+)\ufdd1/g;

export type GitRefreshState = "idle" | "loading" | "ready" | "error";
export type ProjectStatusSegmentId = "project" | "git" | "duration" | "runtime";

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

export interface ProjectStatusSnapshot extends Partial<GitStatusDetails> {
	cwd: string;
	branch: string | null;
	refreshState?: GitRefreshState;
	runtime?: RuntimeStatusSnapshot | null;
	duration?: TurnTimerSnapshot;
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

export type ProjectStatusRole =
	| "path"
	| "separator"
	| "branch"
	| "branch-pending"
	| "changed"
	| "untracked"
	| "ahead"
	| "behind"
	| "duration"
	| "runtime";

export interface ProjectStatusPart {
	text: string;
	role: ProjectStatusRole;
}

const ROLE_COLORS: Readonly<Record<ProjectStatusRole, ThemeColor>> = {
	path: "text",
	separator: "text",
	branch: "accent",
	"branch-pending": "dim",
	changed: "success",
	untracked: "error",
	ahead: "warning",
	behind: "warning",
	duration: "dim",
	runtime: "success",
};

export function sanitizeSingleLine(text: string): string {
	return stripTerminalSequences(text)
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/**
 * 扩展状态允许保留自身的 SGR 颜色，但不能把光标、清屏、标题等终端控制序列
 * 带进主界面。先暂存白名单内的 SGR，再使用 Pi TUI 的完整终端序列清理器。
 */
export function sanitizeStyledSingleLine(text: string): string {
	const styles: string[] = [];
	const input = text.replaceAll(STYLE_MARKER_START, "").replaceAll(STYLE_MARKER_END, "");
	const masked = input.replace(SAFE_SGR_SEQUENCE, (sequence) => {
		const index = styles.push(sequence) - 1;
		return `${STYLE_MARKER_START}${index}${STYLE_MARKER_END}`;
	});
	const restored = sanitizeSingleLine(masked).replace(
		STYLE_MARKER_SEQUENCE,
		(_match, index: string) => styles[Number(index)] ?? "",
	);
	if (!stripTerminalSequences(restored).trim()) return "";
	return styles.length > 0 ? `${restored}\x1b[0m` : restored;
}

export function formatProjectPath(cwd: string, home?: string): string {
	const safeCwd = sanitizeSingleLine(cwd).replaceAll("\\", "/") || ".";
	if (!home) return safeCwd;

	const pathApi = win32.isAbsolute(cwd) || win32.isAbsolute(home) ? win32 : posix;
	const resolvedCwd = pathApi.resolve(cwd);
	const resolvedHome = pathApi.resolve(home);
	const relativeToHome = pathApi.relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." &&
			!relativeToHome.startsWith(`..${pathApi.sep}`) &&
			!pathApi.isAbsolute(relativeToHome));
	if (!isInsideHome) return safeCwd;
	const displayRelative = sanitizeSingleLine(relativeToHome).replaceAll("\\", "/");
	return relativeToHome === "" ? "~" : `~/${displayRelative}`;
}

function truncateFromStart(text: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	if (width === 1) return "…";

	let suffix = "";
	for (const character of Array.from(text).reverse()) {
		if (visibleWidth(`…${character}${suffix}`) > width) break;
		suffix = `${character}${suffix}`;
	}
	return `…${suffix}`;
}

function truncateFromEnd(text: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	if (width === 1) return "…";

	let prefix = "";
	for (const character of Array.from(text)) {
		if (visibleWidth(`${prefix}${character}…`) > width) break;
		prefix += character;
	}
	return `${prefix}…`;
}

function fitProjectPath(path: string, width: number, glyphs: IconGlyphs): string {
	const prefix = formatLeadingIcon(glyphs.project);
	const prefixWidth = visibleWidth(prefix);
	if (width <= prefixWidth) return truncateFromEnd(glyphs.project, width);
	return `${prefix}${truncateFromStart(path, width - prefixWidth)}`;
}

function partsWidth(parts: readonly ProjectStatusPart[]): number {
	return parts.reduce((width, part) => width + visibleWidth(part.text), 0);
}

function branchName(snapshot: ProjectStatusSnapshot): string | null {
	if (snapshot.detached || snapshot.branch === "detached" || snapshot.branch === "(detached)") {
		return "(detached)";
	}
	const branch = sanitizeSingleLine(snapshot.branch ?? "");
	return branch || null;
}

function projectGitParts(
	snapshot: ProjectStatusSnapshot,
	glyphs: IconGlyphs,
): ProjectStatusPart[] {
	const branch = branchName(snapshot);
	// Git 未就绪时保留弱化占位：Footer 结构首帧定型，查询完成后原地替换，
	// 避免揭示帧与补帧之间的结构跳变（会话 Token 零值占位采用同一策略）。
	// 仅在控制器处于查询流程（loading，含首轮）时占位；未启用 Git 段不渲染。
	if (!branch) {
		if (snapshot.refreshState === "loading" || snapshot.refreshState === "idle") {
			return [{ text: `${glyphs.gitBranch} …`, role: "branch-pending" }];
		}
		return [];
	}

	let changed = 0;
	let untracked = 0;
	for (const entry of snapshot.statusCodes ?? []) {
		if (entry.code === "?") untracked += entry.count;
		else changed += entry.count;
	}

	const parts: ProjectStatusPart[] = [
		{ text: `${glyphs.gitBranch} ${branch}`, role: "branch" },
	];
	if (changed > 0) parts.push({ text: ` ${glyphs.changed}${changed}`, role: "changed" });
	if (untracked > 0) parts.push({ text: ` ${glyphs.untracked}${untracked}`, role: "untracked" });
	if ((snapshot.ahead ?? 0) > 0) {
		parts.push({ text: ` ${glyphs.ahead}${snapshot.ahead}`, role: "ahead" });
	}
	if ((snapshot.behind ?? 0) > 0) {
		parts.push({ text: ` ${glyphs.behind}${snapshot.behind}`, role: "behind" });
	}
	return parts;
}

function projectRuntimeParts(
	snapshot: ProjectStatusSnapshot,
	glyphs: IconGlyphs,
): ProjectStatusPart[] {
	if (!snapshot.runtime) return [];
	const name = sanitizeSingleLine(snapshot.runtime.name);
	if (!name) return [];
	const version = sanitizeSingleLine(snapshot.runtime.version ?? "");
	return [{
		text: `${glyphs.runtime} ${name}${version ? ` ${version}` : ""}`,
		role: "runtime",
	}];
}

function projectDurationParts(
	snapshot: ProjectStatusSnapshot,
	glyphs: IconGlyphs,
): ProjectStatusPart[] {
	if (!snapshot.duration) return [];
	return [{
		text: `${glyphs.duration} ${formatElapsed(snapshot.duration.elapsedMs)}`,
		role: "duration",
	}];
}

function fitGitParts(
	snapshot: ProjectStatusSnapshot,
	width: number,
	glyphs: IconGlyphs,
): ProjectStatusPart[] {
	if (width <= 0) return [];
	const full = projectGitParts(snapshot, glyphs);
	if (partsWidth(full) <= width) return full;

	const branch = full[0];
	if (!branch) return [];
	const suffix = full.slice(1);
	while (
		suffix.length > 0 &&
		visibleWidth(`${glyphs.gitBranch} …`) + partsWidth(suffix) > width
	) {
		suffix.pop();
	}
	const branchWidth = Math.max(1, width - partsWidth(suffix));
	return [{ ...branch, text: truncateFromEnd(branch.text, branchWidth) }, ...suffix];
}

function joinProjectStatusGroups(
	path: ProjectStatusPart[],
	git: ProjectStatusPart[],
	duration: ProjectStatusPart[],
	runtime: ProjectStatusPart[],
	order: readonly ProjectStatusSegmentId[],
): ProjectStatusPart[] {
	const groups = order
		.map((segment) => {
			if (segment === "project") return path;
			if (segment === "git") return git;
			if (segment === "duration") return duration;
			return runtime;
		})
		.filter((group) => group.length > 0);
	if (groups.length === 0) return [];
	return groups.flatMap((group, index) => index === 0
		? group
		: [{ text: SEPARATOR, role: "separator" } as ProjectStatusPart, ...group]);
}

export function layoutProjectStatusLine(
	snapshot: ProjectStatusSnapshot,
	width: number,
	home = process.env.HOME ?? process.env.USERPROFILE,
	glyphs: IconGlyphs = DEFAULT_GLYPHS,
	segments: readonly ProjectStatusSegmentId[] = DEFAULT_PROJECT_STATUS_SEGMENTS,
): ProjectStatusPart[] {
	if (width <= 0) return [];
	const order = [...new Set(segments)].filter(
		(segment): segment is ProjectStatusSegmentId =>
			segment === "project" || segment === "git" || segment === "duration" || segment === "runtime",
	);
	const showPath = order.includes("project");
	const showGit = order.includes("git");
	const showDuration = order.includes("duration");
	const showRuntime = order.includes("runtime");
	if (!showPath && !showGit && !showDuration && !showRuntime) return [];
	const path = formatProjectPath(snapshot.cwd, home);
	const projectPath = `${formatLeadingIcon(glyphs.project)}${path}`;
	const fullPath: ProjectStatusPart[] = showPath ? [{ text: projectPath, role: "path" }] : [];
	const fullGit = showGit ? projectGitParts(snapshot, glyphs) : [];
	const fullDuration = showDuration ? projectDurationParts(snapshot, glyphs) : [];
	const fullRuntime = showRuntime ? projectRuntimeParts(snapshot, glyphs) : [];
	if (!showPath && fullGit.length === 0 && fullDuration.length === 0) {
		return fullRuntime.length > 0
			? [{ ...fullRuntime[0]!, text: truncateFromEnd(fullRuntime[0]!.text, width) }]
			: [];
	}
	const allGroups = joinProjectStatusGroups(fullPath, fullGit, fullDuration, fullRuntime, order);
	if (partsWidth(allGroups) <= width) return allGroups;

	if (fullDuration.length > 0) {
		const durationWidth = partsWidth(fullDuration);
		const baseWidth = width - durationWidth - visibleWidth(SEPARATOR);
		if (baseWidth >= MIN_SEGMENT_WIDTH) {
			const baseOrder = order.filter(
				(segment): segment is ProjectStatusSegmentId => segment === "project" || segment === "git",
			);
			const base = layoutProjectStatusLine(
				{ ...snapshot, duration: undefined, runtime: undefined },
				baseWidth,
				home,
				glyphs,
				baseOrder,
			);
			if (base.length > 0) {
				return [...base, { text: SEPARATOR, role: "separator" }, ...fullDuration];
			}
		}
	}

	const reducedOrder = order.filter((segment) => segment !== "duration");
	if (fullGit.length === 0 && showPath) {
		return [{ text: fitProjectPath(path, width, glyphs), role: "path" }];
	}
	if (!showPath) return fitGitParts(snapshot, width, glyphs);

	const fullWidth = visibleWidth(projectPath) + visibleWidth(SEPARATOR) + partsWidth(fullGit);
	if (fullWidth <= width) {
		return joinProjectStatusGroups(fullPath, fullGit, [], [], reducedOrder);
	}
	const minProjectWidth = MIN_SEGMENT_WIDTH + visibleWidth(formatLeadingIcon(glyphs.project));
	if (width < visibleWidth(SEPARATOR) + MIN_SEGMENT_WIDTH * 2) {
		return [{ text: fitProjectPath(path, width, glyphs), role: "path" }];
	}

	const contentWidth = width - visibleWidth(SEPARATOR);
	const gitBudget = contentWidth - minProjectWidth;
	const fittedGit = fitGitParts(snapshot, gitBudget, glyphs);
	const pathWidth = contentWidth - partsWidth(fittedGit);
	return joinProjectStatusGroups(
		[{ text: fitProjectPath(path, pathWidth, glyphs), role: "path" }],
		fittedGit,
		[],
		[],
		reducedOrder,
	);
}

export function formatProjectStatusLine(
	snapshot: ProjectStatusSnapshot,
	width: number,
	home = process.env.HOME ?? process.env.USERPROFILE,
	glyphs: IconGlyphs = DEFAULT_GLYPHS,
	segments: readonly ProjectStatusSegmentId[] = DEFAULT_PROJECT_STATUS_SEGMENTS,
): string {
	return layoutProjectStatusLine(snapshot, width, home, glyphs, segments)
		.map((part) => part.text)
		.join("");
}

export function renderProjectStatusLine(
	snapshot: ProjectStatusSnapshot,
	width: number,
	theme: Theme,
	home = process.env.HOME ?? process.env.USERPROFILE,
	glyphs: IconGlyphs = DEFAULT_GLYPHS,
	segments: readonly ProjectStatusSegmentId[] = DEFAULT_PROJECT_STATUS_SEGMENTS,
): string {
	return layoutProjectStatusLine(snapshot, width, home, glyphs, segments)
		.map((part) => {
			if (part.role === "path" && part.text.startsWith(glyphs.project)) {
				return `${theme.fg("accent", glyphs.project)}${theme.fg(
					ROLE_COLORS.path,
					part.text.slice(glyphs.project.length),
				)}`;
			}
			return theme.fg(
				part.role === "duration"
					? durationStatusColor(snapshot.duration?.state ?? "idle")
					: ROLE_COLORS[part.role],
				part.text,
			);
		})
		.join("");
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
	private provisionalBranch: string | null = null;
	private details: GitStatusDetails | undefined;
	private refreshState: GitRefreshState = "idle";
	private requestRender: (() => void) | undefined;
	private unsubscribeBranch: (() => void) | undefined;
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

	connect(footerData: ReadonlyFooterDataProvider, requestRender: () => void): void {
		this.disconnect();
		if (this.disposed) return;
		this.connected = true;
		this.requestRender = requestRender;
		this.provisionalBranch = footerData.getGitBranch();
		this.unsubscribeBranch = footerData.onBranchChange(() => {
			const nextBranch = footerData.getGitBranch();
			if (nextBranch !== this.provisionalBranch) {
				this.provisionalBranch = nextBranch;
				this.details = undefined;
				this.refreshState = "loading";
				this.requestRender?.();
			}
			this.requestRefresh();
		});
		this.requestRefresh(0);
		if (this.pollIntervalMs > 0) {
			this.pollTimer = setInterval(() => this.requestPollRefresh(), this.pollIntervalMs);
			this.pollTimer.unref();
		}
	}

	disconnect(): void {
		this.connected = false;
		this.unsubscribeBranch?.();
		this.unsubscribeBranch = undefined;
		if (this.pollTimer) clearInterval(this.pollTimer);
		this.pollTimer = undefined;
		this.requestRender = undefined;
	}

	getSnapshot(): ProjectStatusSnapshot {
		return {
			cwd: this.cwd,
			branch: this.details?.branch ?? this.provisionalBranch,
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
		const wasError = this.refreshState === "error";
		if (this.refreshState === "idle") this.refreshState = "loading";
		const branchAtStart = this.provisionalBranch;
		const abortController = new AbortController();
		this.abortController = abortController;
		try {
			const result = await this.queryGitStatus(this.cwd, abortController.signal);
			if (this.disposed || branchAtStart !== this.provisionalBranch) {
				this.refreshPending = !this.disposed;
				return;
			}
			if (!result) {
				this.refreshState = "error";
				if (!wasError) this.requestRender?.();
				return;
			}
			const changed = JSON.stringify(result) !== JSON.stringify(this.details);
			this.details = result;
			this.provisionalBranch = result.branch;
			this.refreshState = "ready";
			if (changed || wasError) this.requestRender?.();
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
