import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const SEGMENT_SEPARATOR = " · ";
const EDITOR_STATUS_CHROME_WIDTH = 11;

export interface StatusSegment {
	readonly id: string;
	readonly text: string;
	readonly compactText?: string;

	readonly priority: number;

	readonly required?: boolean;
}

export interface EditorStatusLayout {
	left: string;
	right: string;
}

interface SegmentSlot {
	readonly segment: StatusSegment;
	readonly order: number;
	text: string;
	compacted: boolean;
	hidden: boolean;
}

function createSlot(segment: StatusSegment, order: number): SegmentSlot {
	return {
		segment,
		order,
		text: segment.text,
		compacted: false,
		hidden: !segment.text,
	};
}

function canCompact(slot: SegmentSlot): boolean {
	const compact = slot.segment.compactText;
	return !slot.compacted && compact !== undefined && compact !== slot.text;
}

function nextReduction(slots: readonly SegmentSlot[]): SegmentSlot | undefined {
	return slots
		.filter((slot) => !slot.hidden && (canCompact(slot) || !slot.segment.required))
		.sort((left, right) =>
			right.segment.priority - left.segment.priority || left.order - right.order,
		)[0];
}

function reduceSlot(slot: SegmentSlot): void {
	if (canCompact(slot)) {
		slot.text = slot.segment.compactText!;
		slot.compacted = true;
		return;
	}
	slot.hidden = true;
}

function reduceToBudget(slots: SegmentSlot[], budget: number, measure: () => number): void {
	while (measure() > budget) {
		const candidate = nextReduction(slots);
		if (!candidate) break;
		reduceSlot(candidate);
	}
}

interface EditorSlot extends SegmentSlot {
	readonly side: "left" | "right";
}

function renderEditorSide(slots: readonly EditorSlot[], side: EditorSlot["side"]): string {
	return slots
		.filter((slot) => slot.side === side && !slot.hidden && slot.text)
		.map((slot) => slot.text)
		.join(side === "right" ? " " : SEGMENT_SEPARATOR);
}

function renderEditorLayout(slots: readonly EditorSlot[]): EditorStatusLayout {
	return {
		left: renderEditorSide(slots, "left"),
		right: renderEditorSide(slots, "right"),
	};
}

function editorLayoutWidth(layout: EditorStatusLayout): number {
	const gap = layout.left && layout.right ? 1 : 0;
	return visibleWidth(layout.left) + visibleWidth(layout.right) + gap;
}

function truncateEditorLayout(layout: EditorStatusLayout, budget: number): EditorStatusLayout {
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
	return layoutTwoColumnSegments(left, right, Math.max(0, terminalWidth - EDITOR_STATUS_CHROME_WIDTH));
}

export function layoutTwoColumnSegments(
	left: readonly StatusSegment[],
	right: readonly StatusSegment[],
	budget: number,
): EditorStatusLayout {
	const slots: EditorSlot[] = [
		...left.map((segment, order) => ({
			...createSlot(segment, order),
			side: "left" as const,
		})),
		...right.map((segment, order) => ({
			...createSlot(segment, left.length + order),
			side: "right" as const,
		})),
	];

	reduceToBudget(slots, budget, () => editorLayoutWidth(renderEditorLayout(slots)));
	const layout = renderEditorLayout(slots);
	return editorLayoutWidth(layout) <= budget ? layout : truncateEditorLayout(layout, budget);
}

function renderSegmentLine(slots: readonly SegmentSlot[], separator: string): string {
	return slots
		.filter((slot) => !slot.hidden && slot.text)
		.map((slot) => slot.text)
		.join(separator);
}

function visibleSlots(slots: readonly SegmentSlot[]): SegmentSlot[] {
	return slots.filter((slot) => !slot.hidden && slot.text);
}

function truncateSegmentLine(slots: readonly SegmentSlot[], budget: number, separator: string): string {
	const line = () => renderSegmentLine(slots, separator);
	if (visibleWidth(line()) <= budget) return line();
	const visible = visibleSlots(slots);

	if (visible.length <= 1) return truncateToWidth(line(), budget, "…");

	const separatorWidth = visibleWidth(separator);
	const floorWidth = visible.length + separatorWidth * (visible.length - 1);
	if (budget < floorWidth) return truncateToWidth(line(), budget, "…");

	const clip = visible.map((slot) => ({
		slot,
		source: slot.text,
		width: visibleWidth(slot.text),
	}));
	while (visibleWidth(line()) > budget) {
		const target = clip
			.filter((entry) => entry.width >= 2)
			.sort((left, right) => right.width - left.width || left.slot.order - right.slot.order)[0];
		if (!target) break;
		const clipped = truncateToWidth(target.source, target.width - 1, "");
		const clippedWidth = visibleWidth(clipped);
		if (clippedWidth < 1 || clippedWidth >= target.width) {

			target.width = 1;
			continue;
		}
		target.width = clippedWidth;
		target.slot.text = clipped;
	}

	const result = line();
	return visibleWidth(result) <= budget ? result : truncateToWidth(result, budget, "…");
}

export function renderStatusLineSegments(
	segments: readonly StatusSegment[],
	width: number,
	separator = SEGMENT_SEPARATOR,
): string {
	if (width <= 0) return "";
	const slots = segments.map((segment, order) => createSlot(segment, order));
	reduceToBudget(slots, width, () => visibleWidth(renderSegmentLine(slots, separator)));
	return truncateSegmentLine(slots, width, separator);
}
