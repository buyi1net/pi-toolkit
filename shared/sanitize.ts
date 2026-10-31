import { stripTerminalSequences } from "@earendil-works/pi-tui";

const SAFE_SGR_SEQUENCE = /\x1b\[[0-9:;]*m/g;
const STYLE_MARKER_START = "\ufdd0";
const STYLE_MARKER_END = "\ufdd1";
const STYLE_MARKER_SEQUENCE = /\ufdd0(\d+)\ufdd1/g;

export function sanitizeSingleLine(text: string): string {
	return stripTerminalSequences(text)
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

export function sanitizeStyledSingleLine(text: string): string {
	const styles: string[] = [];
	const input = text.replaceAll(STYLE_MARKER_START, "").replaceAll(STYLE_MARKER_END, "");
	const masked = input.replace(SAFE_SGR_SEQUENCE, (sequence) => {
		const index = styles.push(sequence) - 1;
		return `${STYLE_MARKER_START}${index}${STYLE_MARKER_END}`;
	});
	const restored = sanitizeSingleLine(masked).replace(
		STYLE_MARKER_SEQUENCE,
		(_match, index: string) => styles[Number(index)] ?? "",
	);
	if (!stripTerminalSequences(restored).trim()) return "";
	return styles.length > 0 ? `${restored}\x1b[0m` : restored;
}
