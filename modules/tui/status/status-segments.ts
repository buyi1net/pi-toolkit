import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const SEGMENT_SEPARATOR = " · ";
const EDITOR_STATUS_CHROME_WIDTH = 11;

export interface StatusSegment {
	readonly id: string;
	readonly text: string;
	readonly compactText?: string;
	/** 数值越大越早压缩或隐藏。 */
	readonly priority: number;
	readonly required?: boolean;
}

export interface EditorStatusLayout {
	left: string;
	right: string;
}

interface SegmentState {
	readonly segment: StatusSegment;
	readonly side: "left" | "right";
	readonly order: number;
	text: string;
	compacted: boolean;
	hidden: boolean;
}

function renderSide(states: readonly SegmentState[], side: SegmentState["side"]): string {
	return states
		.filter((state) => state.side === side && !state.hidden && state.text)
		.map((state) => state.text)
		.join(side === "right" ? " " : SEGMENT_SEPARATOR);
}

function layoutWidth(layout: EditorStatusLayout): number {
	const gap = layout.left && layout.right ? 1 : 0;
	return visibleWidth(layout.left) + visibleWidth(layout.right) + gap;
}

function renderLayout(states: readonly SegmentState[]): EditorStatusLayout {
	return {
		left: renderSide(states, "left"),
		right: renderSide(states, "right"),
	};
}

function nextReduction(states: readonly SegmentState[]): SegmentState | undefined {
	return states
		.filter((state) => {
			if (state.hidden) return false;
			const compact = state.segment.compactText;
			return (!state.compacted && compact !== undefined && compact !== state.text) || !state.segment.required;
		})
		.sort((left, right) =>
			right.segment.priority - left.segment.priority || left.order - right.order,
		)[0];
}

function reduceState(state: SegmentState): void {
	const compact = state.segment.compactText;
	if (!state.compacted && compact !== undefined && compact !== state.text) {
		state.text = compact;
		state.compacted = true;
		return;
	}
	state.hidden = true;
}

function truncateRequiredLayout(layout: EditorStatusLayout, budget: number): EditorStatusLayout {
	if (budget <= 0) return { left: "", right: "" };
	if (!layout.left) return { left: "", right: truncateToWidth(layout.right, budget, "") };
	if (!layout.right) return { left: truncateToWidth(layout.left, budget, "…"), right: "" };

	const rightBudget = Math.min(visibleWidth(layout.right), Math.max(1, Math.floor(budget * 0.4)));
	const right = truncateToWidth(layout.right, rightBudget, "");
	const leftBudget = Math.max(0, budget - visibleWidth(right) - 1);
	return {
		left: truncateToWidth(layout.left, leftBudget, "…"),
		right,
	};
}

export function layoutEditorStatus(
	left: readonly StatusSegment[],
	right: readonly StatusSegment[],
	terminalWidth: number,
): EditorStatusLayout {
	const budget = Math.max(0, terminalWidth - EDITOR_STATUS_CHROME_WIDTH);
	const states: SegmentState[] = [
		...left.map((segment, order) => ({
			segment,
			side: "left" as const,
			order,
			text: segment.text,
			compacted: false,
			hidden: !segment.text,
		})),
		...right.map((segment, order) => ({
			segment,
			side: "right" as const,
			order: left.length + order,
			text: segment.text,
			compacted: false,
			hidden: !segment.text,
		})),
	];

	let layout = renderLayout(states);
	while (layoutWidth(layout) > budget) {
		const candidate = nextReduction(states);
		if (!candidate) break;
		reduceState(candidate);
		layout = renderLayout(states);
	}

	return layoutWidth(layout) <= budget ? layout : truncateRequiredLayout(layout, budget);
}

export type TurnTimerState = "idle" | "working" | "done";

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

export interface TurnTimerSnapshot {
	state: TurnTimerState;
	elapsedMs: number;
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

export class TurnTimerController {
	private readonly requestRender: () => void;
	private readonly intervalMs: number;
	private readonly now: () => number;
	private startedAt: number | undefined;
	private completedElapsedMs: number | undefined;
	private interval: ReturnType<typeof setInterval> | undefined;
	private disposed = false;

	constructor(
		requestRender: () => void,
		intervalMs = 1000,
		now: () => number = Date.now,
		completedElapsedMs?: number,
	) {
		this.requestRender = requestRender;
		this.intervalMs = intervalMs;
		this.now = now;
		if (Number.isFinite(completedElapsedMs) && (completedElapsedMs ?? -1) >= 0) {
			this.completedElapsedMs = completedElapsedMs;
		}
	}

	start(): void {
		if (this.disposed) return;
		this.stopInterval();
		this.startedAt = this.now();
		this.completedElapsedMs = undefined;
		this.interval = setInterval(() => this.requestRender(), this.intervalMs);
		this.interval.unref();
		this.requestRender();
	}

	end(): number | undefined {
		if (this.disposed || this.startedAt === undefined) return undefined;
		this.completedElapsedMs = Math.max(0, this.now() - this.startedAt);
		this.startedAt = undefined;
		this.stopInterval();
		this.requestRender();
		return this.completedElapsedMs;
	}

	restore(elapsedMs: number): void {
		if (this.disposed || !Number.isFinite(elapsedMs) || elapsedMs < 0) return;
		this.startedAt = undefined;
		this.completedElapsedMs = elapsedMs;
		this.stopInterval();
		this.requestRender();
	}

	getSnapshot(): TurnTimerSnapshot {
		if (this.startedAt !== undefined) {
			return {
				state: "working",
				elapsedMs: Math.max(0, this.now() - this.startedAt),
			};
		}
		if (this.completedElapsedMs !== undefined) {
			return { state: "done", elapsedMs: this.completedElapsedMs };
		}
		return { state: "idle", elapsedMs: 0 };
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.stopInterval();
	}

	private stopInterval(): void {
		if (this.interval) clearInterval(this.interval);
		this.interval = undefined;
	}
}
