// status 模块数据源：会话状态采集（tui/status/session-status.ts 的数据半，工单 11 切分）。
//
// 采集（collectSessionStatus）与会话快照类型 / 段位 id 归数据模块，从 `status.session`
// 句柄按需取快照（消费方每帧调用，采集是纯读取，无缓存）。渲染半
// （buildEditorUsageSegments / renderSessionStatusLine）留在 tui/status/session-status.ts；
// renderStatusLineSegments 的段位压缩已迁 modules/tui/status/segment-layout.ts（工单 20），
// 由该模块同时供 editor 两栏与 footer 单行使用。

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sanitizeSingleLine } from "../../shared/sanitize.ts";

export type SessionStatusSegmentId = "session" | "tokens" | "cache" | "cost";
export type EditorUsageSegmentId = "tokens" | "cache" | "context";

export interface SessionStatusSnapshot {
	sessionId: string;
	sessionName?: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	/** 最新 assistant 消息的缓存命中率，口径与 Pi 原生 Footer 一致。 */
	cacheHitPercent?: number;
	cost: number;
	turns: number;
	compactions: number;
}

interface UsageValue {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
}

function safeAmount(value: number): number {
	return Number.isFinite(value) && value > 0 ? value : 0;
}

function addUsage(snapshot: SessionStatusSnapshot, usage: UsageValue): void {
	snapshot.inputTokens += safeAmount(usage.input);
	snapshot.outputTokens += safeAmount(usage.output);
	snapshot.cacheReadTokens += safeAmount(usage.cacheRead);
	snapshot.cacheWriteTokens += safeAmount(usage.cacheWrite);
	snapshot.cost += safeAmount(usage.cost.total);
}

export function collectSessionStatus(
	sessionManager: ExtensionContext["sessionManager"],
): SessionStatusSnapshot {
	const entries = sessionManager.getEntries();
	const branchEntries = sessionManager.getBranch?.() ?? entries;
	const snapshot: SessionStatusSnapshot = {
		sessionId: sanitizeSingleLine(sessionManager.getSessionId()),
		sessionName: sanitizeSingleLine(sessionManager.getSessionName() ?? "") || undefined,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		cost: 0,
		turns: branchEntries.filter((entry) => entry.type === "message" && entry.message.role === "user").length,
		compactions: branchEntries.filter((entry) => entry.type === "compaction").length,
	};

	// 命中率只取最新 assistant 请求，口径与 Pi 原生 Footer 一致；
	// toolResult / compaction 的 usage 不参与 CH。
	let latestCacheHitPercent: number | undefined;

	for (const entry of entries) {
		let usage: UsageValue | undefined;
		if (entry.type === "message" && entry.message.role === "assistant") {
			usage = entry.message.usage as UsageValue | undefined;
			if (usage) {
				const promptTokens = safeAmount(usage.input) + safeAmount(usage.cacheRead) + safeAmount(usage.cacheWrite);
				latestCacheHitPercent = promptTokens > 0
					? (safeAmount(usage.cacheRead) / promptTokens) * 100
					: undefined;
			}
		} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
			usage = entry.message.usage as UsageValue;
		} else if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
			usage = entry.usage as UsageValue;
		}
		if (usage) addUsage(snapshot, usage);
	}
	snapshot.cacheHitPercent = latestCacheHitPercent;

	return snapshot;
}
