// 跨域通用纯函数：终端文本单行清洗（不属于任何功能域，工单 07 定案 3 指定落位）。
//
// 搬到这里的两个函数原住在 tui 的 status/project-status.ts：数据半迁出 status 模块后，
// 它们同时被状态数据处理（git 解析、会话采集）与渲染清洗（footer、editor、供应商段）消费，
// 按「跨域通用工具进 shared/」的定案集中到本文件。行为与迁出前逐字节一致。

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

/**
 * 扩展状态允许保留自身的 SGR 颜色，但不能把光标、清屏、标题等终端控制序列
 * 带进主界面。先暂存白名单内的 SGR，再使用 Pi TUI 的完整终端序列清理器。
 */
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
