// tui 渲染半：段位布局模块（工单 20 / C6：editor 与 footer 共用的段位类型与压缩循环）。
//
// 段位是一段可压缩的状态文本：id、完整文本、可选紧凑文本、压缩优先级与 required
// 标记。压缩规则只在本文件实现一处：优先级降序、同优先级按次序升序、每段先取紧凑
// 文本再隐藏、required 段只可压缩不可隐藏、全部压完仍超预算时截断兜底。
//
// 输出组装保留两种形态，二者共用这里的压缩循环：
// - editor 左右两栏：layoutEditorStatus；
// - footer 单行：renderStatusLineSegments。
// 工单 27：两栏布局的显式预算入口 layoutTwoColumnSegments 供子代理状态行
// 复用（边框 chrome 2 列），editor 的 chrome 包装保持不变。

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const SEGMENT_SEPARATOR = " · ";
const EDITOR_STATUS_CHROME_WIDTH = 11;

export interface StatusSegment {
	readonly id: string;
	readonly text: string;
	readonly compactText?: string;
	/** 数值越大越早压缩或隐藏。 */
	readonly priority: number;
	/** required 段只可压缩、不可隐藏；宽度不足时由截断兜底。 */
	readonly required?: boolean;
}

export interface EditorStatusLayout {
	left: string;
	right: string;
}

/** 压缩状态槽：段位在压缩循环中的可变形态，组装时按 side/separator 取文本。 */
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

/** 该槽是否还能取紧凑文本（空文本段位初始即隐藏，不参与压缩）。 */
function canCompact(slot: SegmentSlot): boolean {
	const compact = slot.segment.compactText;
	return !slot.compacted && compact !== undefined && compact !== slot.text;
}

/** 下一处可压缩/可隐藏的段位：优先级降序，同优先级按次序升序（次序稳定）。 */
function nextReduction(slots: readonly SegmentSlot[]): SegmentSlot | undefined {
	return slots
		.filter((slot) => !slot.hidden && (canCompact(slot) || !slot.segment.required))
		.sort((left, right) =>
			right.segment.priority - left.segment.priority || left.order - right.order,
		)[0];
}

/** 先压缩后隐藏：能取紧凑文本就压缩；否则隐藏（required 段不会进入隐藏分支）。 */
function reduceSlot(slot: SegmentSlot): void {
	if (canCompact(slot)) {
		slot.text = slot.segment.compactText!;
		slot.compacted = true;
		return;
	}
	slot.hidden = true;
}

/** 单一压缩循环：压到预算内为止；无可再压时返回，由调用方截断兜底。 */
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

/** 压缩后仍超预算（只剩 required 段）：按左右两栏的优先顺序截断到预算内。 */
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

/** editor 输出组装：左右两栏布局，共用段位压缩循环。 */
export function layoutEditorStatus(
	left: readonly StatusSegment[],
	right: readonly StatusSegment[],
	terminalWidth: number,
): EditorStatusLayout {
	return layoutTwoColumnSegments(left, right, Math.max(0, terminalWidth - EDITOR_STATUS_CHROME_WIDTH));
}

/**
 * 两栏段位布局（显式内容预算）：与 layoutEditorStatus 同一套压缩循环与
 * 截断兑底，只是预算由调用方直接给出（工单 27：子代理状态行的边框 chrome
 * 是 2 列，与 editor 顶边不同，不重复造宽度算法）。
 */
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

/** 可见段位（非隐藏且有文本）。 */
function visibleSlots(slots: readonly SegmentSlot[]): SegmentSlot[] {
	return slots.filter((slot) => !slot.hidden && slot.text);
}

/**
 * footer 的截断兜底：压缩后仍超预算（只剩 required 段）时，对可见段位轮转裁剪
 * （每轮裁当前可见宽度最大的段 1 列，同宽按段次序靠前者先裁），直到整行进入预算；
 * 每个可见段至少保留 1 字符，分隔符随裁剪结果重算。整行截断会把尾部（含 required）
 * 整段吞掉，所以单段场景保持改动前的整行截断字节；多段场景只有预算连「每段 1 字符
 * + 分隔符」都放不下时，才退回整行 truncateToWidth。
 */
function truncateSegmentLine(slots: readonly SegmentSlot[], budget: number, separator: string): string {
	const line = () => renderSegmentLine(slots, separator);
	if (visibleWidth(line()) <= budget) return line();
	const visible = visibleSlots(slots);
	// 单段（或无可见段）：维持整行截断，字节与改动前一致（既有用例基准）。
	if (visible.length <= 1) return truncateToWidth(line(), budget, "…");
	// 预算放不下「每段至少 1 字符 + 分隔符」：没有轮转空间，退回整行截断。
	const separatorWidth = visibleWidth(separator);
	const floorWidth = visible.length + separatorWidth * (visible.length - 1);
	if (budget < floorWidth) return truncateToWidth(line(), budget, "…");
	// 每段保留原始文本，每轮从原文重新截断，不在已截断的串上叠加 ANSI 复位。
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
			// 该段已到宽字符下限（再裁会丢光）：标记不可裁，本轮换下一段。
			target.width = 1;
			continue;
		}
		target.width = clippedWidth;
		target.slot.text = clipped;
	}
	// 轮转到底仍放不下（宽字符下限）：退回整行截断，保证不越界。
	const result = line();
	return visibleWidth(result) <= budget ? result : truncateToWidth(result, budget, "…");
}

/** footer 输出组装：单行渲染，共用段位压缩循环。 */
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
