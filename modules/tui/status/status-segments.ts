// tui 渲染半：段位配色与格式化（工单 07 定案 5：整文件留在 tui 侧，实为渲染辅助）。
//
// 工单 11：回合计时器的状态与控制器（TurnTimerController / TurnTimerSnapshot /
// TurnTimerState）已切到 modules/status/turn-timer.ts（数据半）。
// 工单 20：段位类型与压缩循环统一迁到 segment-layout.ts（editor 与 footer 共用），
// 本文件只保留各段的语义色与耗时格式化。

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
	if (percent <= 10) return "success";
	if (percent <= 30) return "accent";
	if (percent <= 60) return "warning";
	return "error";
}

export function turnStatusColor(turns: number): ThemeColor {
	if (!Number.isFinite(turns) || turns <= 10) return "muted";
	if (turns <= 20) return "success";
	if (turns < 40) return "warning";
	return "error";
}

export function compactionStatusColor(compactions: number): ThemeColor {
	if (!Number.isFinite(compactions) || compactions <= 0) return "muted";
	if (compactions === 1) return "success";
	if (compactions === 2) return "accent";
	if (compactions === 3) return "warning";
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
	const hours = Math.floor(totalMinutes / 60);
	if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
	return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}
