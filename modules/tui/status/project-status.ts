// tui 渲染半：项目状态行的布局、截断与着色（工单 11 从原 status/project-status.ts 切出）。
//
// 数据半（git 查询 / 解析 / 类型 / 控制器）已迁 modules/status/：本文件只从
// status 模块的静态导出面取类型，快照由 `status.workspace` 句柄提供（footer 装配时接线）。
// 切分口径见工单 07 定案 7：查询/解析/状态类型归 status，布局/截断/渲染归 tui。

import { posix, win32 } from "node:path";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeSingleLine } from "../../../shared/sanitize.ts";
import type {
	ProjectStatusSegmentId,
	ProjectStatusSnapshot,
} from "../../status/api.ts";
import { formatLeadingIcon, type IconGlyphs, resolveGlyphs } from "../renderer/icons.ts";
import { durationStatusColor, formatElapsed } from "./status-segments.ts";

const SEPARATOR = " · ";
const NATIVE_FOOTER_SEPARATOR = " · ";
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

function fitProjectPath(path: string, width: number, glyphs: IconGlyphs, showIcons: boolean): string {
	const prefix = showIcons ? formatLeadingIcon(glyphs.project) : "";
	const prefixWidth = visibleWidth(prefix);
	if (width <= prefixWidth) return truncateFromEnd(showIcons ? glyphs.project : path, width);
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
	showIcons: boolean,
): ProjectStatusPart[] {
	const branch = branchName(snapshot);
	// Git 未就绪时保留弱化占位：Footer 结构首帧定型，查询完成后原地替换，
	// 避免揭示帧与补帧之间的结构跳变（会话 Token 零值占位采用同一策略）。
	// 仅在控制器处于查询流程（loading，含首轮）时占位；未启用 Git 段不渲染。
	if (!branch) {
		if (snapshot.refreshState === "loading" || snapshot.refreshState === "idle") {
			return [{ text: showIcons ? `${glyphs.gitBranch} …` : "…", role: "branch-pending" }];
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
		{ text: showIcons ? `${glyphs.gitBranch} ${branch}` : `(${branch})`, role: "branch" },
	];
	if (changed > 0) parts.push({ text: showIcons ? ` ${glyphs.changed}${changed}` : ` +${changed}`, role: "changed" });
	if (untracked > 0) parts.push({ text: showIcons ? ` ${glyphs.untracked}${untracked}` : ` ~${untracked}`, role: "untracked" });
	if ((snapshot.ahead ?? 0) > 0) {
		parts.push({ text: showIcons ? ` ${glyphs.ahead}${snapshot.ahead}` : ` ahead ${snapshot.ahead}`, role: "ahead" });
	}
	if ((snapshot.behind ?? 0) > 0) {
		parts.push({ text: showIcons ? ` ${glyphs.behind}${snapshot.behind}` : ` behind ${snapshot.behind}`, role: "behind" });
	}
	return parts;
}

function projectRuntimeParts(
	snapshot: ProjectStatusSnapshot,
	glyphs: IconGlyphs,
	showIcons: boolean,
): ProjectStatusPart[] {
	if (!snapshot.runtime) return [];
	const name = sanitizeSingleLine(snapshot.runtime.name);
	if (!name) return [];
	const version = sanitizeSingleLine(snapshot.runtime.version ?? "");
	return [{
		text: showIcons
			? `${glyphs.runtime} ${name}${version ? ` ${version}` : ""}`
			: `${name}${version ? ` ${version}` : ""}`,
		role: "runtime",
	}];
}

function projectDurationParts(
	snapshot: ProjectStatusSnapshot,
	glyphs: IconGlyphs,
	showIcons: boolean,
): ProjectStatusPart[] {
	if (!snapshot.duration) return [];
	return [{
		text: showIcons ? `${glyphs.duration} ${formatElapsed(snapshot.duration.elapsedMs)}` : formatElapsed(snapshot.duration.elapsedMs),
		role: "duration",
	}];
}

function fitGitParts(
	snapshot: ProjectStatusSnapshot,
	width: number,
	glyphs: IconGlyphs,
	showIcons: boolean,
): ProjectStatusPart[] {
	if (width <= 0) return [];
	const full = projectGitParts(snapshot, glyphs, showIcons);
	if (partsWidth(full) <= width) return full;

	const branch = full[0];
	if (!branch) return [];
	const suffix = full.slice(1);
	while (
		suffix.length > 0 &&
		visibleWidth(showIcons ? `${glyphs.gitBranch} …` : "…") + partsWidth(suffix) > width
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
	showIcons: boolean,
): ProjectStatusPart[] {
	if (width <= 0) return [];
	const sessionWidth = partsWidth(sessionParts);
	const sessionOnly = sessionParts[0]?.role === "separator" ? sessionParts.slice(1) : sessionParts;
	if (sessionWidth <= width) {
		const pathWidth = width - sessionWidth;
		if (pathWidth > 0) {
			return [{ text: fitProjectPath(path, pathWidth, glyphs, showIcons), role: "path" }, ...sessionParts];
		}
		return [...sessionOnly];
	}
	if (partsWidth(sessionOnly) <= width) return [...sessionOnly];
	return [{ text: fitProjectPath(path, width, glyphs, showIcons), role: "path" }];
}

function joinProjectStatusGroups(
	path: ProjectStatusPart[],
	git: ProjectStatusPart[],
	duration: ProjectStatusPart[],
	runtime: ProjectStatusPart[],
	order: readonly ProjectStatusSegmentId[],
	groupSeparator = SEPARATOR,
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
		: [{ text: groupSeparator, role: "separator" } as ProjectStatusPart, ...group]);
}

function projectStatusPartsText(parts: readonly ProjectStatusPart[]): string {
	return parts.map((part) => part.text).join("");
}

function truncateProjectStatusParts(parts: readonly ProjectStatusPart[], width: number): ProjectStatusPart[] {
	if (width <= 0) return [];
	const result: ProjectStatusPart[] = [];
	let remaining = width;
	for (const part of parts) {
		if (remaining <= 0) break;
		const partWidth = visibleWidth(part.text);
		if (partWidth <= remaining) {
			result.push(part);
			remaining -= partWidth;
			continue;
		}
		const truncated = truncateToWidth(part.text, remaining, "");
		if (truncated) result.push({ ...part, text: truncated });
		break;
	}
	return result;
}

function nativeFooterStatusParts(
	snapshot: ProjectStatusSnapshot,
	glyphs: IconGlyphs,
	order: readonly ProjectStatusSegmentId[],
): ProjectStatusPart[] {
	const groups: ProjectStatusPart[][] = [];
	if (order.includes("git")) groups.push(projectGitParts(snapshot, glyphs, true));
	if (order.includes("duration")) groups.push(projectDurationParts(snapshot, glyphs, true));
	if (order.includes("runtime")) groups.push(projectRuntimeParts(snapshot, glyphs, true));
	return groups
		.filter((group) => group.length > 0)
		.flatMap((group, index) => index === 0
			? group
			: [{ text: NATIVE_FOOTER_SEPARATOR, role: "separator" } as ProjectStatusPart, ...group]);
}

function nativeFooterProjectStatusParts(
	snapshot: ProjectStatusSnapshot,
	width: number,
	home: string | undefined,
	glyphs: IconGlyphs,
	segments: readonly ProjectStatusSegmentId[],
): ProjectStatusPart[] {
	if (width <= 0) return [];
	const order = [...new Set(segments)];
	const pathText = order.includes("project") ? formatProjectPath(snapshot.cwd, home) : "";
	const sessionText = order.includes("session") && snapshot.sessionShort ? `#${snapshot.sessionShort}` : "";
	const pathParts: ProjectStatusPart[] = pathText ? [{ text: pathText, role: "path" }] : [];
	const sessionParts: ProjectStatusPart[] = sessionText ? [{ text: sessionText, role: "session" }] : [];
	const pathAndSession = pathParts.length > 0 && sessionParts.length > 0
		? [...pathParts, { text: NATIVE_FOOTER_SEPARATOR, role: "separator" } as ProjectStatusPart, ...sessionParts]
		: [...pathParts, ...sessionParts];
	const statusParts = nativeFooterStatusParts(snapshot, glyphs, order);
	const full = statusParts.length > 0 && pathAndSession.length > 0
		? [...pathAndSession, { text: NATIVE_FOOTER_SEPARATOR, role: "separator" } as ProjectStatusPart, ...statusParts]
		: [...pathAndSession, ...statusParts];
	if (partsWidth(full) <= width) return full;

	if (sessionParts.length > 0) {
		if (partsWidth(pathAndSession) <= width) {
			const statusBudget = width - partsWidth(pathAndSession) - visibleWidth(NATIVE_FOOTER_SEPARATOR);
			if (statusParts.length > 0 && statusBudget >= MIN_GIT_WIDTH) {
				return [
					...pathAndSession,
					{ text: NATIVE_FOOTER_SEPARATOR, role: "separator" },
					...truncateProjectStatusParts(statusParts, statusBudget),
				];
			}
			return pathAndSession;
		}
		if (width < partsWidth(sessionParts)) {
			const fallback = pathText || projectStatusPartsText(statusParts);
			return fallback
				? [{ text: truncateToWidth(fallback, width, "…"), role: pathText ? "path" : "branch" }]
				: [];
		}
		const pathBudget = width - partsWidth(sessionParts) - visibleWidth(NATIVE_FOOTER_SEPARATOR);
		if (pathBudget > 0 && pathParts.length > 0) {
			return [
				{ ...pathParts[0]!, text: truncateFromStart(pathText, pathBudget) },
				{ text: NATIVE_FOOTER_SEPARATOR, role: "separator" },
				...sessionParts,
			];
		}
		return [{ ...sessionParts[0]!, text: truncateToWidth(sessionText, width, "…") }];
	}

	const fullText = projectStatusPartsText(full);
	return fullText
		? [{ text: truncateToWidth(fullText, width, "…"), role: pathText ? "path" : "branch" }]
		: [];
}

function formatNativeFooterProjectStatusLine(
	snapshot: ProjectStatusSnapshot,
	width: number,
	home: string | undefined,
	glyphs: IconGlyphs,
	segments: readonly ProjectStatusSegmentId[],
): string {
	return projectStatusPartsText(nativeFooterProjectStatusParts(snapshot, width, home, glyphs, segments));
}

function renderNativeFooterProjectStatusLine(
	snapshot: ProjectStatusSnapshot,
	width: number,
	theme: Theme,
	home: string | undefined,
	glyphs: IconGlyphs,
	segments: readonly ProjectStatusSegmentId[],
): string {
	return nativeFooterProjectStatusParts(snapshot, width, home, glyphs, segments)
		.map((part) => {
			const color = part.role === "path"
				? "dim"
				: part.role === "separator"
					? ROLE_COLORS.separator
					: part.role === "duration"
					? durationStatusColor(snapshot.duration?.state ?? "idle")
					: ROLE_COLORS[part.role];
			return theme.fg(color, part.text);
		})
		.join("");
}

export function layoutProjectStatusLine(
	snapshot: ProjectStatusSnapshot,
	width: number,
	home = process.env.HOME ?? process.env.USERPROFILE,
	glyphs: IconGlyphs = DEFAULT_GLYPHS,
	segments: readonly ProjectStatusSegmentId[] = DEFAULT_PROJECT_STATUS_SEGMENTS,
	showIcons = true,
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
	const projectPath = showIcons ? `${formatLeadingIcon(glyphs.project)}${path}` : path;
	const fullPath: ProjectStatusPart[] = showPath ? [{ text: projectPath, role: "path" }] : [];
	// 会话短码与路径同组（工单 48）：组内自带分隔符，随路径一起参与压缩与降级；
	// 取不到合法短码时整段隐藏
	if (showSession && snapshot.sessionShort) {
		// 路径未启用时不带组内分隔符，避免行首出现孤立的分隔符
		if (fullPath.length > 0) fullPath.push({ text: SEPARATOR, role: "separator" });
		fullPath.push({ text: `#${snapshot.sessionShort}`, role: "session" });
	}
	const fullGit = showGit ? projectGitParts(snapshot, glyphs, showIcons) : [];
	const fullDuration = showDuration ? projectDurationParts(snapshot, glyphs, showIcons) : [];
	const fullRuntime = showRuntime ? projectRuntimeParts(snapshot, glyphs, showIcons) : [];
	if (fullPath.length === 0 && fullGit.length === 0 && fullDuration.length === 0) {
		return fullRuntime.length > 0
			? [{ ...fullRuntime[0]!, text: truncateFromEnd(fullRuntime[0]!.text, width) }]
			: [];
	}
	const groupSeparator = showIcons ? SEPARATOR : " ";
	const allGroups = joinProjectStatusGroups(fullPath, fullGit, fullDuration, fullRuntime, order, groupSeparator);
	if (partsWidth(allGroups) <= width) return allGroups;

	if (fullDuration.length > 0) {
		const durationWidth = partsWidth(fullDuration);
		const baseWidth = width - durationWidth - visibleWidth(groupSeparator);
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
				showIcons,
			);
			if (base.length > 0) {
				return [...base, { text: groupSeparator, role: "separator" }, ...fullDuration];
			}
		}
	}

	const reducedOrder = order.filter((segment) => segment !== "duration");
	// 会话短码（工单 48 修正）：路径组内路径之后的部分（组内自带分隔符）。
	const sessionParts = showPath ? fullPath.slice(1) : fullPath;
	const sessionWidth = partsWidth(sessionParts);
	if (!showPath) {
		if (sessionWidth === 0) return fitGitParts(snapshot, width, glyphs, showIcons);
		// 无项目段：短码原样优先，git 只用剩余宽度，放不下整段丢
		const gitBudget = width - sessionWidth - visibleWidth(groupSeparator);
		if (fullGit.length > 0 && gitBudget >= MIN_GIT_WIDTH) {
			return [
				...sessionParts,
				{ text: groupSeparator, role: "separator" },
				...fitGitParts(snapshot, gitBudget, glyphs, showIcons),
			];
		}
		return sessionWidth <= width ? [...sessionParts] : [];
	}
	if (fullGit.length === 0) {
		// 无 git 段：路径按剩余宽度拟合，会话短码原样保留（工单 48）
		return fitPathSessionParts(path, sessionParts, width, glyphs, showIcons);
	}

	const fullWidth = partsWidth(fullPath) + visibleWidth(groupSeparator) + partsWidth(fullGit);
	if (fullWidth <= width) {
		return joinProjectStatusGroups(fullPath, fullGit, [], [], reducedOrder, groupSeparator);
	}
	// 超宽降级（工单 48 修正）：git 只用「路径 + 短码」之外的剩余宽度并在不足时整段丢，
	// 短码尽量保到最后一档，路径随后才压缩与截断。
	const gitBudget = width - partsWidth(fullPath) - visibleWidth(groupSeparator);
	if (gitBudget >= MIN_GIT_WIDTH) {
			return joinProjectStatusGroups(
				fullPath,
				fitGitParts(snapshot, gitBudget, glyphs, showIcons),
				[],
				[],
				reducedOrder,
				groupSeparator,
			);
	}
	return fitPathSessionParts(path, sessionParts, width, glyphs, showIcons);
}

export function formatProjectStatusLine(
	snapshot: ProjectStatusSnapshot,
	width: number,
	home = process.env.HOME ?? process.env.USERPROFILE,
	glyphs: IconGlyphs = DEFAULT_GLYPHS,
	segments: readonly ProjectStatusSegmentId[] = DEFAULT_PROJECT_STATUS_SEGMENTS,
	showIcons = true,
): string {
	if (!showIcons) {
		return formatNativeFooterProjectStatusLine(snapshot, width, home, glyphs, segments);
	}
	return layoutProjectStatusLine(snapshot, width, home, glyphs, segments, showIcons)
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
	showIcons = true,
): string {
	if (!showIcons) {
		return renderNativeFooterProjectStatusLine(snapshot, width, theme, home, glyphs, segments);
	}
	return layoutProjectStatusLine(snapshot, width, home, glyphs, segments, showIcons)
		.map((part) => {
			if (showIcons && part.role === "path" && part.text.startsWith(glyphs.project)) {
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
