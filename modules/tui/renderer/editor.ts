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
	right?: string;
	borderColor: (text: string) => string;
}

export function insertTopBorderStatus(
	baseLines: readonly string[],
	options: TopBorderStatusOptions,
): string[] {
	if (baseLines.length === 0) return [...baseLines];
	const top = baseLines[0] ?? "";
	const plain = plainLine(top);
	if (!/^─+$/.test(plain)) return [...baseLines];

	const leftSegment = options.left ? ` ${options.left} ` : "";
	const rightSegment = options.right ? ` ${options.right} ` : "";
	const lineWidth = visibleWidth(plain);
	const fillWidth = lineWidth - visibleWidth(leftSegment) - visibleWidth(rightSegment) - 4;

	if (!leftSegment && !rightSegment || fillWidth < 1) return [...baseLines];

	const decorated = `${options.borderColor("──")}${leftSegment}${options.borderColor("─".repeat(fillWidth))}${rightSegment}${options.borderColor("──")}`;
	return [decorated, ...baseLines.slice(1)];
}
