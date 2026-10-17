// tui 渲染半：回合遥测条目的渲染器（工单 11 从原 status/turn-telemetry.ts 切出）。
//
// 数据半（采集器、条目 schema、解析函数）在 modules/status/：渲染器注册与
// 遥测行排版留在 tui，条目类型与解析从 status 模块的静态导出面取。

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import {
	TURN_DURATION_ENTRY_TYPE,
	TURN_TELEMETRY_ENTRY_TYPE,
	readTurnTelemetryEntryData,
	type PersistedTurnDuration,
	type PersistedTurnTelemetry,
	type TurnTelemetrySnapshot,
} from "../../status/api.ts";
import { formatTokenCount } from "./session-status.ts";
import { formatElapsed } from "./status-segments.ts";
import { renderStatusLineSegments, type StatusSegment } from "./segment-layout.ts";

export function registerTurnTelemetryRenderers(
	pi: Pick<ExtensionAPI, "registerEntryRenderer">,
): void {
	pi.registerEntryRenderer?.<PersistedTurnTelemetry>(
		TURN_TELEMETRY_ENTRY_TYPE,
		(entry, _options, theme) => {
			const telemetry = readTurnTelemetryEntryData(entry.data);
			if (!telemetry) return undefined;
			return new TurnTelemetryEntryComponent(telemetry, theme);
		},
	);
	pi.registerEntryRenderer?.<PersistedTurnDuration>(TURN_DURATION_ENTRY_TYPE, () => undefined);
}

function formatTelemetryDuration(ms: number): string {
	return ms < 60_000 ? `${(Math.max(0, ms) / 1_000).toFixed(1)}s` : formatElapsed(ms);
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

function buildTurnTelemetrySegments(telemetry: TurnTelemetrySnapshot): StatusSegment[] {
	const speed = telemetry.tokensPerSecond === null
		? "TPS:—"
		: `TPS:${formatTokensPerSecond(telemetry.tokensPerSecond)}tok/s`;
	return [
		{
			id: "total",
			text: `Total:${formatElapsed(telemetry.totalMs)}`,
			priority: 0,
			required: true,
		},
		{
			id: "ttft",
			text: `TTFT:${formatTelemetryDuration(telemetry.ttftMs)}`,
			priority: 0,
			required: true,
		},
		{ id: "tps", text: speed, priority: 0, required: true },
		telemetry.inputTokens > 0
			? { id: "input", text: `↑${formatTokenCount(telemetry.inputTokens)}`, priority: 3 }
			: undefined,
		telemetry.outputTokens > 0
			? { id: "output", text: `↓${formatTokenCount(telemetry.outputTokens)}`, priority: 2 }
			: undefined,
		telemetry.cacheReadTokens !== null
		&& telemetry.cacheWriteTokens !== null
		&& (telemetry.cacheReadTokens > 0 || telemetry.cacheWriteTokens > 0)
			? { id: "cache", text: `R${formatTokenCount(telemetry.cacheReadTokens)}`, priority: 4 }
			: undefined,
		telemetry.costUsd > 0
			? { id: "cost", text: formatEstimatedCost(telemetry.costUsd), priority: 0, required: true }
			: undefined,
	].filter((segment): segment is StatusSegment => segment !== undefined);
}

class TurnTelemetryEntryComponent implements Component {
	private readonly telemetry: TurnTelemetrySnapshot;
	private readonly theme: Theme;

	constructor(telemetry: TurnTelemetrySnapshot, theme: Theme) {
		this.telemetry = telemetry;
		this.theme = theme;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const contentWidth = Math.max(1, width - 2);
		const line = renderStatusLineSegments(buildTurnTelemetrySegments(this.telemetry), contentWidth, " ");
		return new Text(this.theme.fg("dim", line), 1, 0).render(width);
	}
}

export function formatTurnTelemetry(
	telemetry: TurnTelemetrySnapshot,
): string {
	return buildTurnTelemetrySegments(telemetry).map((segment) => segment.text).join(" ");
}
