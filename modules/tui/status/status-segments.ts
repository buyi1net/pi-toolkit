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

/** 四档全展示（s / m+s / h+m+s / d+h+m+s）：秒数永不省略，数字不补零；
 * 字段宽度不在此截断，由段位布局的压缩降级负责。 */
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
