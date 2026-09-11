import type {
	AgentEndEvent,
	AgentSettledEvent,
	AgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
	Theme,
	TurnEndEvent,
	TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { resolveGlyphs, type IconGlyphs } from "../renderer/icons.ts";
import { formatTokenCount } from "./session-status.ts";
import { formatElapsed, type TurnTimerController } from "./status-segments.ts";

export const TURN_TELEMETRY_ENTRY_TYPE = "pi-tui.turn-telemetry";
export const TURN_DURATION_ENTRY_TYPE = "pi-tui.turn-duration";

type TurnTelemetryEvent =
	| AgentStartEvent
	| AgentSettledEvent
	| TurnStartEvent
	| MessageStartEvent
	| MessageUpdateEvent
	| MessageEndEvent
	| TurnEndEvent;

type AgentMessage = MessageStartEvent["message"];
type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

interface MessageTiming {
	firstOutputMs: number | null;
}

interface TurnTiming {
	startMs: number;
	firstTokenMs: number | null;
	currentMessage: MessageTiming | null;
	messages: AssistantMessage[];
	generationMs: number;
}

export interface TurnTelemetrySnapshot {
	tokensPerSecond: number | null;
	ttftMs: number;
	totalMs: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number | null;
	cacheWriteTokens: number | null;
	generationMs: number;
	costUsd: number;
}

export interface PersistedTurnTelemetry {
	schemaVersion: 1;
	telemetry: TurnTelemetrySnapshot;
}

export interface PersistedTurnDuration {
	schemaVersion: 1;
	elapsedMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isNonNegativeFinite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNullableNonNegativeFinite(value: unknown): value is number | null {
	return value === null || isNonNegativeFinite(value);
}

function isTurnTelemetrySnapshot(value: unknown): value is TurnTelemetrySnapshot {
	if (!isRecord(value)) return false;
	return (
		isNullableNonNegativeFinite(value.tokensPerSecond) &&
		isNonNegativeFinite(value.ttftMs) &&
		isNonNegativeFinite(value.totalMs) &&
		isNonNegativeFinite(value.inputTokens) &&
		isNonNegativeFinite(value.outputTokens) &&
		(value.cacheReadTokens === undefined || isNullableNonNegativeFinite(value.cacheReadTokens)) &&
		(value.cacheWriteTokens === undefined || isNullableNonNegativeFinite(value.cacheWriteTokens)) &&
		isNonNegativeFinite(value.generationMs) &&
		isNonNegativeFinite(value.costUsd)
	);
}

export function createTurnTelemetryEntryData(
	telemetry: TurnTelemetrySnapshot,
): PersistedTurnTelemetry {
	return { schemaVersion: 1, telemetry: { ...telemetry } };
}

export function readTurnTelemetryEntryData(value: unknown): TurnTelemetrySnapshot | undefined {
	if (!isRecord(value) || value.schemaVersion !== 1 || !isTurnTelemetrySnapshot(value.telemetry)) {
		return undefined;
	}
	return {
		...value.telemetry,
		cacheReadTokens: value.telemetry.cacheReadTokens ?? null,
		cacheWriteTokens: value.telemetry.cacheWriteTokens ?? null,
	};
}

export function createTurnDurationEntryData(elapsedMs: number): PersistedTurnDuration {
	return { schemaVersion: 1, elapsedMs: Math.max(0, elapsedMs) };
}

export function readTurnDurationEntryData(value: unknown): number | undefined {
	if (!isRecord(value) || value.schemaVersion !== 1 || !isNonNegativeFinite(value.elapsedMs)) {
		return undefined;
	}
	return value.elapsedMs;
}

export function readLatestTurnDuration(entries: readonly SessionEntry[]): number | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type !== "custom") continue;
		if (entry.customType === TURN_DURATION_ENTRY_TYPE) {
			const elapsedMs = readTurnDurationEntryData(entry.data);
			if (elapsedMs !== undefined) return elapsedMs;
		}
		if (entry.customType === TURN_TELEMETRY_ENTRY_TYPE) {
			const telemetry = readTurnTelemetryEntryData(entry.data);
			if (telemetry) return telemetry.totalMs;
		}
	}
	return undefined;
}

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

interface TurnTelemetryDependencies {
	isEnabled: () => boolean;
	getTimer: () => Pick<TurnTimerController, "start" | "end" | "restore"> | undefined;
	appendEntry: ExtensionAPI["appendEntry"];
}

export class TurnTelemetryController {
	private readonly dependencies: TurnTelemetryDependencies;
	private readonly tracker: TurnTelemetryTracker;

	constructor(dependencies: TurnTelemetryDependencies, now?: () => number) {
		this.dependencies = dependencies;
		this.tracker = new TurnTelemetryTracker(now);
	}

	handle(event: Exclude<TurnTelemetryEvent, AgentSettledEvent> | AgentEndEvent): void {
		const { isEnabled, getTimer, appendEntry } = this.dependencies;
		// 耗时段独立于回复尾遥测开关，禁用采集仍需冻结并恢复本轮耗时。
		if (event.type === "agent_end") {
			const elapsedMs = getTimer()?.end();
			if (elapsedMs !== undefined) {
				appendEntry(TURN_DURATION_ENTRY_TYPE, createTurnDurationEntryData(elapsedMs));
			}
			return;
		}
		if (isEnabled()) this.tracker.handle(event);
		if (event.type === "agent_start") getTimer()?.start();
	}

	settle(event: AgentSettledEvent, mode: ExtensionContext["mode"]): void {
		const { isEnabled, getTimer, appendEntry } = this.dependencies;
		if (!isEnabled()) return;
		// agent_end 后宿主可能继续重试；settled 才是整次回复的落盘时机。
		const telemetry = this.tracker.handle(event);
		if (!telemetry || mode !== "tui") return;
		getTimer()?.restore(telemetry.totalMs);
		appendEntry(TURN_TELEMETRY_ENTRY_TYPE, createTurnTelemetryEntryData(telemetry));
	}

	reset(): void {
		// 计时器由装配层销毁；这里只清除尚未持久化的回复，避免跨会话串账。
		this.tracker.reset();
	}
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	return message.role === "assistant";
}

function finitePositive(value: number | undefined): number {
	return Number.isFinite(value) && (value ?? 0) > 0 ? value! : 0;
}

function round(value: number, decimals: number): number {
	const factor = 10 ** decimals;
	return Math.round(value * factor) / factor;
}

function aggregateTelemetry(
	turns: readonly TurnTelemetrySnapshot[],
	totalMs: number,
): TurnTelemetrySnapshot | undefined {
	if (turns.length === 0) return undefined;

	const inputTokens = turns.reduce((sum, turn) => sum + turn.inputTokens, 0);
	const outputTokens = turns.reduce((sum, turn) => sum + turn.outputTokens, 0);
	const hasCacheTelemetry = turns.every(
		(turn) => turn.cacheReadTokens !== null && turn.cacheWriteTokens !== null,
	);
	const cacheReadTokens = hasCacheTelemetry
		? turns.reduce((sum, turn) => sum + turn.cacheReadTokens!, 0)
		: null;
	const cacheWriteTokens = hasCacheTelemetry
		? turns.reduce((sum, turn) => sum + turn.cacheWriteTokens!, 0)
		: null;
	const costUsd = turns.reduce((sum, turn) => sum + turn.costUsd, 0);
	const generationMs = turns.reduce((sum, turn) => sum + turn.generationMs, 0);
	const tokensPerSecond = outputTokens > 0 && generationMs > 0
		? round(outputTokens / (generationMs / 1_000), 1)
		: null;

	return {
		tokensPerSecond,
		ttftMs: turns[0]!.ttftMs,
		totalMs: Math.max(0, totalMs),
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		generationMs,
		costUsd,
	};
}

/**
 * 统计一次完整 Agent run。每个 LLM turn 从 turn_start 计到 assistant
 * message_end，工具执行夹在两个 turn 之间，因此不会污染 TPS。
 */
export class TurnTelemetryTracker {
	private readonly now: () => number;
	private turn: TurnTiming | undefined;
	private agentStartMs: number | null = null;
	private agentTurns: TurnTelemetrySnapshot[] = [];

	constructor(now: () => number = () => performance.now()) {
		this.now = now;
	}

	handle(event: TurnTelemetryEvent): TurnTelemetrySnapshot | undefined {
		switch (event.type) {
			case "agent_start":
				if (this.agentStartMs === null) {
					this.agentStartMs = this.now();
					this.agentTurns = [];
				}
				return undefined;
			case "agent_settled":
				return this.endAgent();
			case "turn_start":
				this.startTurn();
				return undefined;
			case "message_start":
				this.startMessage(event.message);
				return undefined;
			case "message_update":
				this.updateMessage(event);
				return undefined;
			case "message_end":
				this.endMessage(event.message);
				return undefined;
			case "turn_end":
				this.endTurnAndCollect();
				return undefined;
		}
	}

	reset(): void {
		this.turn = undefined;
		this.agentStartMs = null;
		this.agentTurns = [];
	}

	private startTurn(): void {
		this.turn = {
			startMs: this.now(),
			firstTokenMs: null,
			currentMessage: null,
			messages: [],
			generationMs: 0,
		};
	}

	private startMessage(message: AgentMessage): void {
		if (!this.turn || !isAssistantMessage(message)) return;
		this.turn.currentMessage = {
			firstOutputMs: null,
		};
	}

	private updateMessage(event: MessageUpdateEvent): void {
		const streamEvent = event.assistantMessageEvent;
		if (
			streamEvent.type !== "text_delta" &&
			streamEvent.type !== "thinking_delta" &&
			streamEvent.type !== "toolcall_delta"
		) return;
		if (streamEvent.delta.length === 0) return;

		const turn = this.turn;
		const current = turn?.currentMessage;
		if (!turn || !current || !isAssistantMessage(event.message)) return;

		if (current.firstOutputMs === null) {
			const now = this.now();
			current.firstOutputMs = now;
			turn.firstTokenMs ??= now;
		}
	}

	private endMessage(message: AgentMessage): void {
		const turn = this.turn;
		if (!turn || !isAssistantMessage(message)) return;

		if (turn.currentMessage) {
			const endMs = this.now();
			if (turn.currentMessage.firstOutputMs !== null) {
				turn.generationMs += Math.max(0, endMs - turn.currentMessage.firstOutputMs);
			}
			if (turn.currentMessage.firstOutputMs === null && finitePositive(message.usage?.output) > 0) {
				turn.firstTokenMs ??= endMs;
			}
			turn.currentMessage = null;
		}
		turn.messages.push(message);
	}

	private endTurnAndCollect(): void {
		const telemetry = this.endTurn();
		if (telemetry && this.agentStartMs !== null) this.agentTurns.push(telemetry);
	}

	private endTurn(): TurnTelemetrySnapshot | undefined {
		const turn = this.turn;
		this.turn = undefined;
		if (!turn || turn.firstTokenMs === null || turn.messages.length === 0) return undefined;

		const inputTokens = turn.messages.reduce(
			(sum, message) => sum + finitePositive(message.usage?.input),
			0,
		);
		const outputTokens = turn.messages.reduce(
			(sum, message) => sum + finitePositive(message.usage?.output),
			0,
		);
		const cacheReadTokens = turn.messages.reduce(
			(sum, message) => sum + finitePositive(message.usage?.cacheRead),
			0,
		);
		const cacheWriteTokens = turn.messages.reduce(
			(sum, message) => sum + finitePositive(message.usage?.cacheWrite),
			0,
		);
		const costUsd = turn.messages.reduce(
			(sum, message) => sum + finitePositive(message.usage?.cost?.total),
			0,
		);
		const tokensPerSecond = outputTokens > 0 && turn.generationMs > 0
			? round(outputTokens / (turn.generationMs / 1_000), 1)
			: null;

		return {
			tokensPerSecond,
			ttftMs: turn.firstTokenMs - turn.startMs,
			totalMs: this.now() - turn.startMs,
			inputTokens,
			outputTokens,
			cacheReadTokens,
			cacheWriteTokens,
			generationMs: turn.generationMs,
			costUsd,
		};
	}

	private endAgent(): TurnTelemetrySnapshot | undefined {
		const startMs = this.agentStartMs;
		const turns = this.agentTurns;
		this.reset();
		return startMs === null ? undefined : aggregateTelemetry(turns, this.now() - startMs);
	}
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
	return round(value, 1).toString();
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
