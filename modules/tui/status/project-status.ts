// tui 渲染半：项目状态行的布局、截断与着色（工单 11 从原 status/project-status.ts 切出）。
//
// 数据半（git 查询 / 解析 / 类型 / 控制器）已迁 modules/status/：本文件只从
// status 模块的静态导出面取类型，快照由 `status.workspace` 句柄提供（footer 装配时接线）。
// 切分口径见工单 07 定案 7：查询/解析/状态类型归 status，布局/截断/渲染归 tui。

import { posix, win32 } from "node:path";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeSingleLine } from "../../../shared/sanitize.ts";
import type {
	ProjectStatusSegmentId,
	ProjectStatusSnapshot,
} from "../../status/api.ts";
import { formatLeadingIcon, type IconGlyphs, resolveGlyphs } from "../renderer/icons.ts";
import { durationStatusColor, formatElapsed } from "./status-segments.ts";

const SEPARATOR = " · ";
const MIN_SEGMENT_WIDTH = 8;
// git 段低于此宽度整段丢弃（工单 48 修正：短码优先于 git，git 先裁）
const MIN_GIT_WIDTH = 8;
const DEFAULT_GLYPHS = resolveGlyphs("unicode");
const DEFAULT_PROJECT_STATUS_SEGMENTS: readonly ProjectStatusSegmentId[] = ["project", "git"];

export type ProjectStatusRole =
	| "path"
	| "session"
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
	session: "warning",
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

/** 路径 + 会话短码的宽度分配（工单 48 修正）：短码原样优先保留，路径吃剩余宽度；
 * 短码放不下时先让路径整段让位（去掉组内分隔符），最后才退到只渲染路径。 */
function fitPathSessionParts(
	path: string,
	sessionParts: readonly ProjectStatusPart[],
	width: number,
	glyphs: IconGlyphs,
): ProjectStatusPart[] {
	if (width <= 0) return [];
	const sessionWidth = partsWidth(sessionParts);
	const sessionOnly = sessionParts[0]?.role === "separator" ? sessionParts.slice(1) : sessionParts;
	if (sessionWidth <= width) {
		const pathWidth = width - sessionWidth;
		if (pathWidth > 0) {
			return [{ text: fitProjectPath(path, pathWidth, glyphs), role: "path" }, ...sessionParts];
		}
		return [...sessionOnly];
	}
	if (partsWidth(sessionOnly) <= width) return [...sessionOnly];
	return [{ text: fitProjectPath(path, width, glyphs), role: "path" }];
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
			segment === "project" ||
			segment === "session" ||
			segment === "git" ||
			segment === "duration" ||
			segment === "runtime",
	);
	const showPath = order.includes("project");
	const showSession = order.includes("session");
	const showGit = order.includes("git");
	const showDuration = order.includes("duration");
	const showRuntime = order.includes("runtime");
	if (!showPath && !showSession && !showGit && !showDuration && !showRuntime) return [];
	const path = formatProjectPath(snapshot.cwd, home);
	const projectPath = `${formatLeadingIcon(glyphs.project)}${path}`;
	const fullPath: ProjectStatusPart[] = showPath ? [{ text: projectPath, role: "path" }] : [];
	// 会话短码与路径同组（工单 48）：组内自带分隔符，随路径一起参与压缩与降级；
	// 取不到合法短码时整段隐藏
	if (showSession && snapshot.sessionShort) {
		// 路径未启用时不带组内分隔符，避免行首出现孤立的分隔符
		if (fullPath.length > 0) fullPath.push({ text: SEPARATOR, role: "separator" });
		fullPath.push({ text: `#${snapshot.sessionShort}`, role: "session" });
	}
	const fullGit = showGit ? projectGitParts(snapshot, glyphs) : [];
	const fullDuration = showDuration ? projectDurationParts(snapshot, glyphs) : [];
	const fullRuntime = showRuntime ? projectRuntimeParts(snapshot, glyphs) : [];
	if (fullPath.length === 0 && fullGit.length === 0 && fullDuration.length === 0) {
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
				(segment): segment is ProjectStatusSegmentId =>
					segment === "project" || segment === "session" || segment === "git",
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
	// 会话短码（工单 48 修正）：路径组内路径之后的部分（组内自带分隔符）。
	const sessionParts = showPath ? fullPath.slice(1) : fullPath;
	const sessionWidth = partsWidth(sessionParts);
	if (!showPath) {
		if (sessionWidth === 0) return fitGitParts(snapshot, width, glyphs);
		// 无项目段：短码原样优先，git 只用剩余宽度，放不下整段丢
		const gitBudget = width - sessionWidth - visibleWidth(SEPARATOR);
		if (fullGit.length > 0 && gitBudget >= MIN_GIT_WIDTH) {
			return [
				...sessionParts,
				{ text: SEPARATOR, role: "separator" },
				...fitGitParts(snapshot, gitBudget, glyphs),
			];
		}
		return sessionWidth <= width ? [...sessionParts] : [];
	}
	if (fullGit.length === 0) {
		// 无 git 段：路径按剩余宽度拟合，会话短码原样保留（工单 48）
		return fitPathSessionParts(path, sessionParts, width, glyphs);
	}

	const fullWidth = partsWidth(fullPath) + visibleWidth(SEPARATOR) + partsWidth(fullGit);
	if (fullWidth <= width) {
		return joinProjectStatusGroups(fullPath, fullGit, [], [], reducedOrder);
	}
	// 超宽降级（工单 48 修正）：git 只用「路径 + 短码」之外的剩余宽度并在不足时整段丢，
	// 短码尽量保到最后一档，路径随后才压缩与截断。
	const gitBudget = width - partsWidth(fullPath) - visibleWidth(SEPARATOR);
	if (gitBudget >= MIN_GIT_WIDTH) {
		return joinProjectStatusGroups(
			fullPath,
			fitGitParts(snapshot, gitBudget, glyphs),
			[],
			[],
			reducedOrder,
		);
	}
	return fitPathSessionParts(path, sessionParts, width, glyphs);
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
