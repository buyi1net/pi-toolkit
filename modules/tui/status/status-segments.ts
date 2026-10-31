import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import type { TurnTimerState } from "../../status/api.ts";

const THINKING_COLORS: Readonly<Record<string, ThemeColor>> = {
	off: "thinkingOff",
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
	max: "thinkingMax",
};

export function thinkingStatusColor(level: string | undefined): ThemeColor {
	return THINKING_COLORS[level ?? "off"] ?? "thinkingOff";
}

export function cacheHitStatusColor(percent: number | null | undefined): ThemeColor {
	if (percent === null || percent === undefined || !Number.isFinite(percent) || percent < 0) return "muted";
	if (percent < 30) return "error";
	if (percent < 70) return "warning";
	if (percent < 90) return "accent";
	return "success";
}

export function contextUsageStatusColor(percent: number | null | undefined): ThemeColor {
	if (percent === null || percent === undefined || !Number.isFinite(percent) || percent <= 0) return "muted";
	if (percent > 90) return "error";
	if (percent > 70) return "warning";
	return "muted";
}

export function turnStatusColor(turns: number): ThemeColor {
	if (!Number.isFinite(turns) || turns <= 10) return "muted";
	if (turns <= 20) return "success";
	if (turns < 40) return "warning";
	return "error";
}

export function durationStatusColor(state: TurnTimerState): ThemeColor {
	if (state === "working") return "accent";
	if (state === "done") return "success";
	return "dim";
}

export function formatElapsed(elapsedMs: number): string {
	const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
	const seconds = totalSeconds % 60;
	const totalMinutes = Math.floor(totalSeconds / 60);
	if (totalMinutes < 1) return `${seconds}s`;
	const minutes = totalMinutes % 60;
	const totalHours = Math.floor(totalMinutes / 60);
	if (totalHours < 1) return `${minutes}m ${seconds}s`;
	const hours = totalHours % 24;
	const days = Math.floor(totalHours / 24);
	if (days < 1) return `${hours}h ${minutes}m ${seconds}s`;
	return `${days}d ${hours}h ${minutes}m ${seconds}s`;
}
