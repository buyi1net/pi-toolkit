import { visibleWidth } from "@earendil-works/pi-tui";

export type IconMode = "auto" | "nerd" | "unicode" | "ascii";
export type ResolvedIconMode = Exclude<IconMode, "auto">;

/**
 * 组件只依赖语义键，不感知当前字体模式，也不自行选择字形。
 * 新状态段需要图标时必须先在这里增加语义，再同时补齐三套 glyph。
 */
export interface IconGlyphs {
	readonly brand: string;
	readonly project: string;
	readonly runtime: string;
	readonly gitBranch: string;
	readonly model: string;
	readonly thinking: string;
	readonly context: string;
	readonly duration: string;
	readonly latency: string;
	readonly speed: string;
	readonly session: string;
	readonly inputTokens: string;
	readonly outputTokens: string;
	readonly cache: string;
	readonly cost: string;
	readonly provider: string;
	readonly usage: string;
	readonly turns: string;
	readonly compaction: string;
	readonly extensions: string;
	readonly changed: string;
	readonly untracked: string;
	readonly ahead: string;
	readonly behind: string;
}

const NERD_GLYPHS: IconGlyphs = Object.freeze({
	brand: "",
	project: "",
	runtime: "",
	gitBranch: "",
	model: "󰚩",
	thinking: "",
	context: "",
	duration: "",
	latency: "⏳",
	speed: "",
	session: "",
	inputTokens: "",
	outputTokens: "",
	cache: "",
	cost: "",
	usage: "📶",
	turns: "💬",
	provider: "",
	compaction: "📦",
	extensions: "",
	changed: "+",
	untracked: "~",
	ahead: "↑",
	behind: "↓",
});

const UNICODE_GLYPHS: IconGlyphs = Object.freeze({
	brand: "◇",
	project: "📂",
	runtime: "◩",
	gitBranch: "⎇",
	model: "◆",
	thinking: "✦",
	context: "🪟",
	duration: "⏱️",
	latency: "⏳",
	speed: "⚡",
	session: "●",
	inputTokens: "↑",
	outputTokens: "↓",
	cache: "↻",
	cost: "¤",
	usage: "📶",
	turns: "💬",
	provider: "◈",
	compaction: "📦",
	extensions: "◇",
	changed: "+",
	untracked: "~",
	ahead: "↑",
	behind: "↓",
});

const ASCII_GLYPHS: IconGlyphs = Object.freeze({
	brand: "pi",
	project: "dir",
	runtime: "runtime",
	gitBranch: "git",
	model: "model",
	thinking: "think",
	context: "ctx",
	duration: "time",
	latency: "~",
	speed: ">",
	session: "session",
	inputTokens: "in",
	outputTokens: "out",
	cache: "cache",
	cost: "$",
	usage: "sig",
	turns: "msg",
	provider: "provider",
	compaction: "cmp",
	extensions: "ext",
	changed: "+",
	untracked: "~",
	ahead: "^",
	behind: "v",
});

/** 为状态栏左侧图标预留两列，再追加一列文字间距。 */
export function formatLeadingIcon(glyph: string): string {
	return `${glyph}${" ".repeat(Math.max(1, 3 - visibleWidth(glyph)))}`;
}

function isAsciiOnlyTerminal(env: Readonly<Record<string, string | undefined>>): boolean {
	const locale = env.LC_ALL ?? env.LC_CTYPE ?? env.LANG;
	return /^(?:c|posix)$/i.test(locale?.trim() ?? "");
}

export function resolveIconMode(
	mode: IconMode,
	env: Readonly<Record<string, string | undefined>> = process.env,
): ResolvedIconMode {
	if (mode !== "auto") return mode;
	if (isAsciiOnlyTerminal(env)) return "ascii";
	return "unicode";
}

export function resolveGlyphs(
	mode: IconMode,
	env: Readonly<Record<string, string | undefined>> = process.env,
): IconGlyphs {
	switch (resolveIconMode(mode, env)) {
		case "nerd":
			return NERD_GLYPHS;
		case "ascii":
			return ASCII_GLYPHS;
		default:
			return UNICODE_GLYPHS;
	}
}
