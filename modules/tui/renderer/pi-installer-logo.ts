/**
 * Pi 官方安装器 Logo 动画的 TypeScript 适配。
 *
 * 坐标、方块落位顺序、闪烁阶段和时序均对应 pi.dev/install.sh 中的
 * pi_logo_animation；这里只把安装器的 8×9 方格裁剪为横幅使用的 6×4 小尺寸，
 * 每个方格仍保持安装器原始的两个终端字符宽度。
 * 来源：https://pi.dev/install.sh
 */

export type PiLogoColor = "panel" | "cyan" | "red" | "green" | "orange" | "white" | "flash";
export type PiInstallerLogoFrame = readonly (readonly PiLogoColor[])[];

export interface PiInstallerLogoAnimationFrame {
	frame: PiInstallerLogoFrame;
	durationMs: number;
}

const SOURCE_WIDTH = 8;
const SOURCE_HEIGHT = 9;
// 安装器的源网格按 x=1..8 绘制；裁剪 x=2..7 以去掉左侧空列。
const CROP_LEFT = 1;
const CROP_TOP = 3;
const CROP_WIDTH = 6;
const CROP_HEIGHT = 4;

const LEFT_PIECE: readonly [number, number][] = [
	[0, 0],
	[1, 0],
	[1, 1],
	[2, 0],
];
const TOP_PIECE: readonly [number, number][] = [
	[0, 0],
	[0, 1],
	[0, 2],
	[1, 2],
];
const RIGHT_PIECE: readonly [number, number][] = [
	[0, 0],
	[1, 0],
	[2, 0],
	[2, 1],
];

const WHITE_CELLS: readonly [number, number][] = [
	[3, 2],
	[3, 3],
	[3, 4],
	[4, 2],
	[4, 4],
	[5, 2],
	[5, 3],
	[5, 5],
	[6, 2],
	[6, 5],
];

const CYAN_CELLS: readonly [number, number][] = [
	[2, 2],
	[2, 3],
	[2, 4],
	[3, 4],
];
const RED_CELLS: readonly [number, number][] = [
	[3, 2],
	[4, 2],
	[4, 3],
	[5, 2],
];
const GREEN_CELLS: readonly [number, number][] = [
	[4, 5],
	[5, 5],
	[6, 5],
	[6, 6],
];

function contains(cells: readonly [number, number][], y: number, x: number): boolean {
	return cells.some(([cellY, cellX]) => cellY === y && cellX === x);
}

function containsPiece(
	cells: readonly [number, number][],
	y: number,
	x: number,
	pieceY: number,
	pieceX: number,
): boolean {
	return cells.some(([dy, dx]) => y === pieceY + dy && x === pieceX + dx);
}

function sourceCellColor(
	phase: number,
	active: "none" | "left" | "top" | "right",
	activeX: number,
	activeY: number,
	flash: boolean,
	white: boolean,
	y: number,
	x: number,
): PiLogoColor {
	if (white) return contains(WHITE_CELLS, y, x) ? "white" : "panel";
	if (flash && y === 6 && x >= 1 && x <= 6) return "flash";

	if (active === "left" && containsPiece(LEFT_PIECE, y, x, activeY, activeX)) return "red";
	if (active === "top" && containsPiece(TOP_PIECE, y, x, activeY, activeX)) return "cyan";
	if (active === "right" && containsPiece(RIGHT_PIECE, y, x, activeY, activeX)) return "green";

	if (phase === 4) {
		if (contains(CYAN_CELLS, y, x)) return "cyan";
		if (contains(RED_CELLS, y, x)) return "red";
		if (contains([[4, 5], [5, 5]] as const, y, x)) return "green";
		return "panel";
	}

	if (phase >= 5) {
		if (contains([[3, 2], [3, 3], [3, 4], [4, 4]] as const, y, x)) return "cyan";
		if (contains([[4, 2], [5, 2], [5, 3], [6, 2]] as const, y, x)) return "red";
		if (contains([[5, 5], [6, 5]] as const, y, x)) return "green";
		return "panel";
	}

	if (phase <= 3 && contains([[6, 1], [6, 2], [6, 3], [6, 4]] as const, y, x)) return "orange";
	if (phase >= 2 && contains(CYAN_CELLS, y, x)) return "cyan";
	if (phase >= 1 && contains(RED_CELLS, y, x)) return "red";
	if (phase >= 3 && contains(GREEN_CELLS, y, x)) return "green";
	return "panel";
}

function makeFrame(
	phase: number,
	active: "none" | "left" | "top" | "right",
	activeX: number,
	activeY: number,
	flash: boolean,
	white: boolean,
): PiInstallerLogoFrame {
	const source = Array.from({ length: SOURCE_HEIGHT }, (_, y) =>
		Array.from({ length: SOURCE_WIDTH }, (_, x) =>
			sourceCellColor(phase, active, activeX, activeY, flash, white, y, x + 1),
		),
	);

	return Array.from({ length: CROP_HEIGHT }, (_, row) =>
		source.slice(CROP_TOP, CROP_TOP + CROP_HEIGHT)[row].slice(CROP_LEFT, CROP_LEFT + CROP_WIDTH),
	);
}

const animationFrames: PiInstallerLogoAnimationFrame[] = [];
const addFrame = (
	phase: number,
	active: "none" | "left" | "top" | "right",
	activeX: number,
	activeY: number,
	flash: boolean,
	white: boolean,
	durationMs: number,
): void => {
	animationFrames.push({
		frame: makeFrame(phase, active, activeX, activeY, flash, white),
		durationMs,
	});
};

for (const y of [0, 1, 2, 3]) addFrame(0, "left", 2, y, false, false, 75);
for (const y of [0, 1, 2]) addFrame(1, "top", 2, y, false, false, 75);
for (const y of [0, 1, 2, 3, 4]) addFrame(2, "right", 5, y, false, false, 75);
addFrame(3, "none", 0, 0, false, false, 250);
addFrame(3, "none", 0, 0, true, false, 80);
addFrame(3, "none", 0, 0, false, false, 80);
addFrame(3, "none", 0, 0, true, false, 80);
addFrame(4, "none", 0, 0, false, false, 100);
addFrame(5, "none", 0, 0, false, false, 450);
addFrame(5, "none", 0, 0, false, true, 120);
addFrame(5, "none", 0, 0, false, false, 120);
addFrame(5, "none", 0, 0, false, true, 450);

function frameWidth(frame: PiInstallerLogoFrame): number {
	let maxCell = 0;
	for (const row of frame) {
		for (let index = row.length - 1; index >= 0; index -= 1) {
			if (row[index] !== "panel") {
				maxCell = Math.max(maxCell, index + 1);
				break;
			}
		}
	}
	return maxCell * 2;
}

export const PI_INSTALLER_LOGO_ANIMATION = animationFrames;
export const PI_INSTALLER_LOGO_FRAMES = animationFrames.map(({ frame }) => frame);
export const PI_INSTALLER_LOGO_DURATIONS_MS = animationFrames.map(({ durationMs }) => durationMs);
// 按完整动画的最大实际占用宽度固定右侧锚点，避免动画帧之间文字跳动。
export const PI_INSTALLER_LOGO_WIDTH = Math.max(...PI_INSTALLER_LOGO_FRAMES.map(frameWidth));
