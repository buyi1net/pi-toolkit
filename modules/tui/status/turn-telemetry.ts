// tui 渲染半：回合遥测条目的渲染器（工单 11 从原 status/turn-telemetry.ts 切出）。
//
// 数据半（采集器、条目 schema、解析函数）在 modules/status/：渲染器注册与
// 遥测行排版留在 tui，条目类型与解析从 status 模块的静态导出面取。

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	TURN_DURATION_ENTRY_TYPE,
	TURN_TELEMETRY_ENTRY_TYPE,
	readTurnTelemetryEntryData,
	type PersistedTurnDuration,
	type PersistedTurnTelemetry,
	type TurnTelemetrySnapshot,
} from "../../status/api.ts";
import { resolveGlyphs, type IconGlyphs } from "../renderer/icons.ts";
import { formatTokenCount } from "./session-status.ts";
import { formatElapsed } from "./status-segments.ts";

export function registerTurnTelemetryRenderers(
	pi: Pick<ExtensionAPI, "registerEntryRenderer">,
	getGlyphs: () => IconGlyphs,
): void {
	pi.registerEntryRenderer?.<PersistedTurnTelemetry>(
		TURN_TELEMETRY_ENTRY_TYPE,
		(entry, _options, theme) => {
			const telemetry = readTurnTelemetryEntryData(entry.data);
			if (!telemetry) return undefined;
			return new Text(formatTurnTelemetry(telemetry, theme, getGlyphs()), 1, 0);
		},
	);
	pi.registerEntryRenderer?.<PersistedTurnDuration>(TURN_DURATION_ENTRY_TYPE, () => undefined);
}

function formatTelemetryDuration(ms: number): string {
	return ms < 60_000 ? `${(Math.max(0, ms) / 1_000).toFixed(1)}s` : formatElapsed(ms);
}

function getTtftColor(ttftMs: number): "success" | "accent" | "warning" | "error" {
	if (ttftMs < 3_000) return "success";
	if (ttftMs < 8_000) return "accent";
	if (ttftMs < 15_000) return "warning";
	return "error";
}

function formatTokensPerSecond(value: number): string {
	const factor = 10;
	return (Math.round(value * factor) / factor).toString();
}

function formatEstimatedCost(costUsd: number): string {
	if (costUsd < 0.0001) return "<$0.0001";
	const decimals = costUsd < 1 ? 4 : 2;
	const amount = costUsd.toFixed(decimals).replace(/\.?0+$/, "");
	return `$${amount}`;
}

export function formatTurnTelemetry(
	telemetry: TurnTelemetrySnapshot,
	theme: Theme,
	glyphs: IconGlyphs = resolveGlyphs("unicode"),
): string {
	const parts: string[] = [];
	const speed = telemetry.tokensPerSecond === null
		? "—"
		: `${formatTokensPerSecond(telemetry.tokensPerSecond)} tok/s`;
	parts.push(theme.fg(
		getTtftColor(telemetry.ttftMs),
		`${glyphs.latency} ${formatTelemetryDuration(telemetry.ttftMs)}`,
	));
	parts.push(theme.fg(
		telemetry.tokensPerSecond === null ? "muted" : "accent",
		`${glyphs.speed} ${speed}`,
	));
	const contextParts: string[] = [];
	if (telemetry.inputTokens > 0) {
		contextParts.push(theme.fg("muted", `${glyphs.inputTokens}${formatTokenCount(telemetry.inputTokens)}`));
	}
	if (telemetry.outputTokens > 0) {
		contextParts.push(theme.fg("muted", `${glyphs.outputTokens}${formatTokenCount(telemetry.outputTokens)}`));
	}
	if (
		telemetry.cacheReadTokens !== null
		&& telemetry.cacheWriteTokens !== null
		&& (telemetry.cacheReadTokens > 0 || telemetry.cacheWriteTokens > 0)
	) {
		contextParts.push(theme.fg("muted", `R${formatTokenCount(telemetry.cacheReadTokens)}`));
	}
	if (contextParts.length > 0) parts.push(contextParts.join(" "));
	if (telemetry.costUsd > 0) {
		parts.push(theme.fg("warning", formatEstimatedCost(telemetry.costUsd)));
	}

	const separator = glyphs.cost === "$" ? "|" : "·";
	return parts.join(` ${theme.fg("dim", separator)} `);
}
