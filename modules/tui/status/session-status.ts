import type { ContextUsage, Theme } from "@earendil-works/pi-coding-agent";
import type { EditorUsageSegmentId, SessionStatusSnapshot } from "../../status/api.ts";
import { resolveGlyphs, type IconGlyphs } from "../renderer/icons.ts";
import { renderStatusLineSegments, type StatusSegment } from "./segment-layout.ts";
import {
	cacheHitStatusColor,
	contextUsageStatusColor,
	turnStatusColor,
} from "./status-segments.ts";

const DEFAULT_GLYPHS = resolveGlyphs("unicode");

export type SessionStatusSegmentId = "session" | "tokens" | "cache" | "cost";

interface CompressionLabelText {
	readonly text: string;
	readonly compactText: string;
}

const NO_COMPRESSION_LABEL: CompressionLabelText = Object.freeze({ text: "", compactText: "" });

function safeAmount(value: number): number {
	return Number.isFinite(value) && value > 0 ? value : 0;
}

export function formatTokenCount(count: number): string {
	if (count < 1_000) return String(count);
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

function formatContextTokenCount(count: number): string {
	if (count < 1_000) return String(count);
	if (count < 1_000_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
	if (count < 1_000_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
	return `${(count / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
}

function formatContextUsageTokenCount(count: number): string {
	return safeAmount(count) === 0 ? "0k" : formatContextTokenCount(count);
}

function formatCacheHitPercent(percent: number | undefined): string {
	const safePercent = Number.isFinite(percent) && percent !== undefined && percent >= 0
		? percent
		: 0;
	return safePercent.toFixed(1).replace(/\.0$/, "");
}

function compressionLabelWithCount(
	label: CompressionLabelText,
	compactions: number,
): CompressionLabelText {
	const count = Math.floor(safeAmount(compactions));
	if (!label.text || count <= 0) return label;
	const suffix = `(${count})`;
	return {
		text: `${label.text}${suffix}`,
		compactText: label.compactText ? `${label.compactText}${suffix}` : "",
	};
}

export function buildEditorUsageSegments(
	snapshot: SessionStatusSnapshot,
	contextUsage: ContextUsage | undefined,
	contextWindowFallback: number | undefined,
	theme: Theme,
	glyphs: IconGlyphs,
	segments: readonly EditorUsageSegmentId[],
	compressionLabel: CompressionLabelText = NO_COMPRESSION_LABEL,
	nativeFooter = false,
): StatusSegment[] {
	const inputTokens = safeAmount(snapshot.inputTokens);
	const outputTokens = safeAmount(snapshot.outputTokens);
	const cacheReadTokens = safeAmount(snapshot.cacheReadTokens);
	const cacheWriteTokens = safeAmount(snapshot.cacheWriteTokens);
	const cacheHitText = snapshot.cacheHitPercent !== undefined && (cacheReadTokens > 0 || cacheWriteTokens > 0)
		? `CH${formatCacheHitPercent(snapshot.cacheHitPercent)}%`
		: "";
	const turnsText = snapshot.turns > 0 ? `Turns:${snapshot.turns}` : "";
	const statsParts = nativeFooter
		? [
			inputTokens > 0 ? `↑${formatTokenCount(inputTokens)}` : "",
			outputTokens > 0 ? `↓${formatTokenCount(outputTokens)}` : "",
			cacheReadTokens > 0 ? `R${formatTokenCount(cacheReadTokens)}` : "",
			cacheWriteTokens > 0 ? `W${formatTokenCount(cacheWriteTokens)}` : "",
			cacheHitText,
			turnsText,
		].filter(Boolean)
		: [
			theme.fg("muted", `${glyphs.inputTokens}${formatTokenCount(inputTokens)}`),
			theme.fg("muted", `${glyphs.outputTokens}${formatTokenCount(outputTokens)}`),
			theme.fg("muted", `R${cacheReadTokens > 0 ? formatTokenCount(cacheReadTokens) : "0k"}`),
		];
	const cacheHit = nativeFooter
		? ""
		: theme.fg(
			cacheHitStatusColor(snapshot.cacheHitPercent),
			`CH${formatCacheHitPercent(snapshot.cacheHitPercent)}%`,
		);
	const statsSeparator = nativeFooter ? "" : theme.fg("muted", " · ");
	const statsText = nativeFooter
		? statsParts.join(" ")
		: `${statsParts.join(" ")}${statsSeparator}${cacheHit}`;
	const statsCompact = nativeFooter
		? statsText
		: `${statsParts[2]!}${statsSeparator}${cacheHit}`;
	const contextWindow = contextUsage?.contextWindow ?? contextWindowFallback;
	const contextTokens = contextUsage?.tokens ?? 0;
	const contextValue = contextWindow
		? `${formatContextUsageTokenCount(contextTokens)}/${formatContextTokenCount(contextWindow)}`
		: `${formatContextUsageTokenCount(contextTokens)}/?`;
	const contextText = `${nativeFooter ? "" : `${glyphs.context} `}${contextValue}`;
	const stats = {
		id: "tokens",
		text: statsText,
		compactText: statsCompact,
		priority: 4,
	};
	const byId: Readonly<Record<EditorUsageSegmentId, StatusSegment>> = {

		tokens: stats,
		cache: stats,
		context: {
			id: "context",
			text: theme.fg(contextUsageStatusColor(contextUsage?.percent), contextText),
			priority: 0,
			required: true,
		},
	};
	const showConversationCounts = !nativeFooter && (segments.includes("tokens")
		|| segments.includes("cache")
		|| snapshot.turns > 0
		|| snapshot.compactions > 0);
	const turnStatus: StatusSegment = {
		id: "turns",
		text: nativeFooter || snapshot.turns <= 0
			? ""
			: theme.fg(turnStatusColor(snapshot.turns), `${glyphs.turns} T${snapshot.turns}`),
		priority: 6,
	};
	const displayedCompressionLabel = compressionLabelWithCount(compressionLabel, snapshot.compactions);
	const compressionStatus: StatusSegment = {
		id: "compression",
		text: nativeFooter
			? displayedCompressionLabel.text
			: theme.fg(turnStatusColor(snapshot.turns), displayedCompressionLabel.text),
		compactText: nativeFooter
			? displayedCompressionLabel.compactText
			: theme.fg(turnStatusColor(snapshot.turns), displayedCompressionLabel.compactText),
		priority: 7,
		required: true,
	};
	const seen = new Set<string>();
	return segments.flatMap((segment) => {
		const status = byId[segment];
		if (!status.text || seen.has(status.id)) return [];
		seen.add(status.id);
		if (segment !== "context") return [status];
		const ordered = showConversationCounts
			? [turnStatus, compressionStatus, status]
			: [compressionStatus, status];
		return ordered.filter((extra) => extra.text);
	});
}

function buildSegments(
	snapshot: SessionStatusSnapshot,
	theme: Theme,
	glyphs: IconGlyphs,
): Readonly<Record<SessionStatusSegmentId, StatusSegment>> {
	const sessionLabel = snapshot.sessionName ?? snapshot.sessionId.slice(0, 8);
	const input = snapshot.inputTokens > 0
		? theme.fg("text", `${glyphs.inputTokens} ${formatTokenCount(snapshot.inputTokens)}`)
		: "";
	const compactInput = snapshot.inputTokens > 0
		? theme.fg("text", `${glyphs.inputTokens}${formatTokenCount(snapshot.inputTokens)}`)
		: "";
	const output = snapshot.outputTokens > 0
		? theme.fg("success", `${glyphs.outputTokens} ${formatTokenCount(snapshot.outputTokens)}`)
		: "";
	const compactOutput = snapshot.outputTokens > 0
		? theme.fg("success", `${glyphs.outputTokens}${formatTokenCount(snapshot.outputTokens)}`)
		: "";
	const cacheParts = [
		snapshot.cacheReadTokens > 0 ? `R${formatTokenCount(snapshot.cacheReadTokens)}` : "",
		snapshot.cacheWriteTokens > 0 ? `W${formatTokenCount(snapshot.cacheWriteTokens)}` : "",
		snapshot.cacheHitPercent !== undefined
			? `CH${snapshot.cacheHitPercent.toFixed(1)}%`
			: "",
	].filter(Boolean);
	const compactCache = snapshot.cacheHitPercent !== undefined
		? `${Math.round(snapshot.cacheHitPercent)}%`
		: formatTokenCount(snapshot.cacheReadTokens + snapshot.cacheWriteTokens);
	const costValue = `$${snapshot.cost.toFixed(3)}`;
	const costText = glyphs.cost === "$" ? costValue : `${glyphs.cost} ${costValue}`;

	return {
		session: {
			id: "session",
			text: sessionLabel ? theme.fg("accent", `${glyphs.session} ${sessionLabel}`) : "",
			compactText: sessionLabel ? theme.fg("accent", `${glyphs.session}${sessionLabel}`) : "",
			priority: 4,
		},
		tokens: {
			id: "tokens",
			text: [input, output].filter(Boolean).join(" "),
			compactText: [compactInput, compactOutput].filter(Boolean).join(" "),
			priority: 1,
		},
		cache: {
			id: "cache",
			text: cacheParts.length > 0
				? theme.fg("muted", `${glyphs.cache} ${cacheParts.join(" ")}`)
				: "",
			compactText: cacheParts.length > 0
				? theme.fg("muted", `${glyphs.cache}${compactCache}`)
				: "",
			priority: 3,
		},
		cost: {
			id: "cost",
			text: snapshot.cost > 0 ? theme.fg("warning", costText) : "",
			priority: 2,
		},
	};
}

export function renderSessionStatusLine(
	snapshot: SessionStatusSnapshot,
	width: number,
	theme: Theme,
	glyphs: IconGlyphs = DEFAULT_GLYPHS,
	segments: readonly SessionStatusSegmentId[] = ["tokens", "cost"],
	extraSegments: readonly StatusSegment[] = [],
): string {
	const byId = buildSegments(snapshot, theme, glyphs);
	const ordered = [...new Set(segments)].map((segment) => byId[segment]);
	return renderStatusLineSegments([...ordered, ...extraSegments], width);
}
