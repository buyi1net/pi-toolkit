import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

function plainLine(line: string): string {
	return stripTerminalSequences(line);
}

function isEditorBorder(line: string): boolean {
	const plain = plainLine(line);
	return /^─+$/.test(plain) || /^─── [↑↓] \d+ more (?:─+|\.{1,3})$/.test(plain);
}

function scrollLabel(line: string): string | undefined {
	return plainLine(line).match(/[↑↓] \d+ more/)?.[0];
}

export function hasTruncatedScrollBorder(lines: readonly string[]): boolean {
	return lines.some((line, index) => {
		if (index !== 0 && index < 2) return false;
		const plain = plainLine(line);
		return plain.endsWith("...") && (/^─/.test(plain) || /[↑↓]/.test(plain));
	});
}

function findBottomBorder(lines: readonly string[]): number {
	for (let index = lines.length - 1; index >= 2; index -= 1) {
		if (isEditorBorder(lines[index] ?? "")) return index;
	}
	return -1;
}

export function splitNativeEditorRender(lines: readonly string[]): {
	editor: string[];
	autocomplete: string[];
} {
	const bottomBorderIndex = findBottomBorder(lines);
	if (bottomBorderIndex < 2) return { editor: [...lines], autocomplete: [] };
	return {
		editor: lines.slice(0, bottomBorderIndex + 1),
		autocomplete: lines.slice(bottomBorderIndex + 1),
	};
}

export interface TopBorderStatusOptions {
	left: string;
	borderColor: (text: string) => string;
}

/**
 * 轻插入：Pi 原生上下横线边框保持原样，只在顶边左端嵌入状态文本。
 * 顶边不是纯横线（滚动标签等原生动态形态）时原样返回，不与原生行为竞争。
 */
export function insertTopBorderStatus(
	baseLines: readonly string[],
	options: TopBorderStatusOptions,
): string[] {
	if (baseLines.length === 0) return [...baseLines];
	const top = baseLines[0] ?? "";
	const plain = plainLine(top);
	if (!/^─+$/.test(plain)) return [...baseLines];

	const segment = options.left ? ` ${options.left} ` : "";
	const segmentWidth = visibleWidth(segment);
	const lineWidth = visibleWidth(plain);
	// 两侧至少各留两列横线；放不下时保持原生顶边
	if (segmentWidth === 0 || segmentWidth > lineWidth - 4) return [...baseLines];

	const fill = "─".repeat(lineWidth - segmentWidth - 2);
	const decorated = `${options.borderColor("──")}${segment}${options.borderColor(fill)}`;
	return [decorated, ...baseLines.slice(1)];
}
