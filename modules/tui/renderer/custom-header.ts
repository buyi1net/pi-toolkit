import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatProjectPath } from "../status/project-status.ts";
import type { IconGlyphs } from "./icons.ts";
import {
	PI_INSTALLER_LOGO_DURATIONS_MS,
	PI_INSTALLER_LOGO_FRAMES,
	PI_INSTALLER_LOGO_WIDTH,
	type PiInstallerLogoFrame,
	type PiLogoColor,
} from "./pi-installer-logo.ts";

/**
 * 基于 amosblomqvist/pi-config 的 custom-header.ts 思路改造：
 * 用 Pi 公开的 Header 组件绘制启动横幅，并保留本项目的宽度与主题适配。
 * 参考：https://github.com/amosblomqvist/pi-config/blob/main/extensions/custom-header.ts
 */

const BANNER_MIN_WIDTH = 32;
const BANNER_GAP = 1;
const BANNER_PADDING_X = 1;
export const CUSTOM_HEADER_LOGO_FRAMES = PI_INSTALLER_LOGO_FRAMES;
export const CUSTOM_HEADER_ANIMATION_DURATIONS_MS = PI_INSTALLER_LOGO_DURATIONS_MS;

const LOGO_THEME_COLORS: Record<PiLogoColor, ThemeColor | undefined> = {
	panel: undefined,
	cyan: "accent",
	red: "error",
	green: "success",
	orange: "warning",
	white: "text",
	flash: "warning",
};

export interface CustomHeaderSnapshot {
	version: string;
	model: string;
	thinking: string;
	cwd: string;
}

function joinSides(left: string, right: string, width: number): string {
	if (!right) return truncateToWidth(left, width);
	const gap = width - visibleWidth(left) - visibleWidth(right);
	if (gap >= 1) return `${left}${" ".repeat(gap)}${right}`;
	return truncateToWidth(`${left} · ${right}`, width);
}

function joinColumns(
	left: string,
	right: string,
	width: number,
	leftColumnWidth = visibleWidth(left),
): string {
	const leftWidth = visibleWidth(left);
	const availableRightWidth = width - leftColumnWidth - BANNER_GAP;
	if (availableRightWidth < 1) return truncateToWidth(left, width);
	const paddedLeft = `${left}${" ".repeat(Math.max(0, leftColumnWidth - leftWidth))}`;
	return `${paddedLeft}${" ".repeat(BANNER_GAP)}${truncateToWidth(right, availableRightWidth)}`;
}

function renderLogoFrame(frame: PiInstallerLogoFrame, theme: Theme): string[] {
	return frame.map((row) => {
		let line = "";
		let run = "";
		let runColor: ThemeColor | undefined;

		const flush = (): void => {
			if (!run) return;
			line += runColor ? theme.fg(runColor, run) : run;
			run = "";
		};

		for (const cell of row) {
			const color = LOGO_THEME_COLORS[cell];
			if (color !== runColor && run) flush();
			runColor = color;
			// 对应官方安装器的 panel_cell="  " 与各色 cell="██"。
			run += cell === "panel" ? "  " : "██";
		}
		flush();
		return line.trimEnd();
	});
}

function formatHeaderModel(model: string): string {
	const separator = model.lastIndexOf("/");
	return separator >= 0 ? model.slice(separator + 1) : model;
}

function alignRowsToBottom(rows: readonly string[], height: number): string[] {
	const visibleRows = rows.slice(-height);
	const leadingEmptyRows = height - visibleRows.length;
	return Array.from({ length: height }, (_, index) => visibleRows[index - leadingEmptyRows] ?? "");
}

function renderCompactHeader(
	snapshot: CustomHeaderSnapshot,
	width: number,
	theme: Theme,
	glyphs: IconGlyphs,
): string[] {
	const brand = theme.bold(theme.fg("border", `${glyphs.brand} Pi Tui`));
	const version = theme.fg("muted", `Pi v${snapshot.version}`);
	const first = joinSides(brand, version, width);
	if (width < 32) return [first];

	const model = theme.fg("accent", `${glyphs.model} ${snapshot.model}`);
	const thinking = snapshot.thinking
		? theme.fg("muted", `${glyphs.thinking} ${snapshot.thinking}`)
		: "";
	const left = thinking ? `${model} · ${thinking}` : model;
	const path = `${theme.fg("accent", glyphs.project)}${theme.fg(
		"dim",
		` ${formatProjectPath(snapshot.cwd)}`,
	)}`;
	return [first, joinSides(left, path, width)];
}

export function renderCustomHeader(
	snapshot: CustomHeaderSnapshot,
	width: number,
	theme: Theme,
	glyphs: IconGlyphs,
	logoFrame: PiInstallerLogoFrame = CUSTOM_HEADER_LOGO_FRAMES.at(-1)!,
): string[] {
	if (width <= 0) return [];
	const paddingX = width >= BANNER_PADDING_X * 2 + 1 ? BANNER_PADDING_X : 0;
	const contentWidth = Math.max(1, width - paddingX * 2);
	if (width < BANNER_MIN_WIDTH) {
		const compact = renderCompactHeader(snapshot, contentWidth, theme, glyphs);
		return compact.map((line) => `${" ".repeat(paddingX)}${line}`);
	}

	const logo = renderLogoFrame(logoFrame, theme).map((line) => theme.bold(line));
	const logoWidth = PI_INSTALLER_LOGO_WIDTH;
	const title = `${theme.bold(theme.fg("border", "Pi"))}${theme.fg("dim", ` v${snapshot.version}`)}`;
	const modelName = formatHeaderModel(snapshot.model);
	const modelDetails = snapshot.thinking ? `${modelName} · ${snapshot.thinking}` : modelName;
	const model = theme.fg("dim", modelDetails);
	const path = theme.fg("dim", formatProjectPath(snapshot.cwd));
	const shortcuts = theme.fg(
		"dim",
		"Escape interrupt · Ctrl+C/Ctrl+D clear/exit · / commands · ! bash · Ctrl+O more",
	);
	const details = [
		title,
		model,
		path,
		shortcuts,
	];
	const alignedDetails = alignRowsToBottom(details, logo.length);

	return logo.map(
		(line, index) => `${" ".repeat(paddingX)}${joinColumns(line, alignedDetails[index] ?? "", contentWidth, logoWidth)}`,
	);
}
