// Codex checkpoint 的摘要恢复（工单 05 从上游 checkpoint-recovery.ts 提取）。
//
// 上游对应：reference/Pi生态/pi-codex-compact/source/src/checkpoint-recovery.ts
// （MIT，来源登记见 ../UPSTREAM.md）。语义：远程压缩失败但分支上已有已提交的
// opaque checkpoint 时，用一次普通推理请求把「checkpoint replacement history +
// 保留尾之前的历史」翻成明文续接摘要——这是有损回退（上游口径：调用方拥有
// 有损回退的策略决定权），不是又一次远程压缩。
//
// 适配点（与上游的差异）：
// - 请求形状走本仓 04 的 CodexRemoteCompactionRequest（owner 组装同一条接缝）；
// - 上游经 pi-ai 的 onProviderStreamEvent 校验终端 response.completed 的形状并
//   提取终端文本；本仓依赖版本没有该回调，终端观察移到 fetch 边界的
//   TransformStream（字节透传的同时解析 ≤64 KiB 的完整数据帧），校验口径与上游
//   一致：状态 completed、无 error / incomplete_details、输出只含 reasoning 或
//   纯 output_text 的 assistant 消息、终端只出现一次；
// - 归属：本单只交付模块与 fake stream 测试；owner 的失败矩阵（工单 04：有声明
//   → 取消并保留）不变，恢复的接线（何时替代取消）由协调者随 mod.ts 装配决策
//   ——规格允许「兼容的恢复、保留原状态并取消、严格错误」三选一。
//
// Pi 契约：返回 CompactionResult（summary / firstKeptEntryId / tokensBefore /
// usage / details={readFiles, modifiedFiles}），与 Pi 原生 compact 的结果同形。

import type { CompactionResult, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { expandRemoteCompactionPayload, MAX_COMPACTION_ITEM_BYTES } from "./protocol.ts";
import type { CodexAgentMessage } from "./checkpoint.ts";
import {
  abortError,
  assertPreparedInput,
  type CodexProviderStream,
  MAX_SSE_BYTES,
  providerTranscriptContext,
} from "./remote-shared.ts";
import { isJsonObject } from "./protocol.ts";
import type { CodexRemoteCompactionRequest } from "./remote.ts";

export const RECOVERY_INSTRUCTION =
  "Summarize the preceding conversation and encrypted checkpoint into a plaintext continuation checkpoint. Preserve user goals, constraints, decisions, completed work, pending tasks, and relevant file paths. Do not continue the task, call tools, or emit another encrypted checkpoint. Later retained messages are provided separately by the client.";

/** provider 事件流 done 消息（pi-ai AssistantMessage 的结构推导形） */
type CodexStreamEvent = CodexProviderStream extends AsyncIterable<infer TEvent> ? TEvent : never;
type CodexDoneEvent = Extract<CodexStreamEvent, { type: "done" }>;
type CodexAssistantMessage = CodexDoneEvent["message"];

/** 恢复请求里的终端观察状态（fetch 边界的 SSE 帧解析维护） */
interface TerminalObservation {
  seen: boolean;
  text: string | undefined;
}

/**
 * 摘要恢复的前缀视图：当前请求消息去掉与保留尾完全一致的末段（指纹逐条比对）。
 * 保留尾对不上（分支已漂移）时抛错——不能带着错位的上下文去翻摘要。
 */
export function summaryPrefix(
  messages: CodexAgentMessage[],
  kept: CodexAgentMessage[],
  fingerprint: (message: CodexAgentMessage) => string,
): CodexAgentMessage[] {
  if (kept.length > messages.length) throw new Error("Checkpoint recovery cut point cannot be projected safely");
  const prefixLength = messages.length - kept.length;
  if (!kept.every((message, index) => fingerprint(message) === fingerprint(messages[prefixLength + index]))) {
    throw new Error("Checkpoint recovery retained tail does not match the active context");
  }
  return messages.slice(0, prefixLength);
}

function isSafeOutputText(item: unknown): boolean {
  return (
    isJsonObject(item) &&
    item.type === "message" &&
    item.role === "assistant" &&
    Array.isArray(item.content) &&
    item.content.every(
      (part) => isJsonObject(part) && part.type === "output_text" && typeof part.text === "string",
    )
  );
}

/** 观察一帧终端事件（response.completed / response.done）：校验形状并提取文本 */
function observeTerminalFrame(raw: unknown, terminal: TerminalObservation): void {
  if (!isJsonObject(raw)) return;
  if (raw.type !== "response.completed" && raw.type !== "response.done") return;
  const response = raw.response;
  if (
    terminal.seen ||
    !isJsonObject(response) ||
    response.status !== "completed" ||
    response.error != null ||
    response.incomplete_details != null ||
    !Array.isArray(response.output)
  )
    throw new Error("Checkpoint recovery did not complete safely");
  if (
    !response.output.every(
      (item) =>
        isJsonObject(item) &&
        (item.status === undefined || item.status === "completed") &&
        (item.type === "reasoning" || isSafeOutputText(item)),
    )
  )
    throw new Error("Unsafe checkpoint recovery terminal output");
  // Pi 对每条消息只产出一个文本块（拼接其 output_text 部分）；消息之间以 \n 相连
  terminal.text = response.output
    .flatMap((item) =>
      isJsonObject(item) && Array.isArray(item.content)
        ? [item.content.map((part: { text: string }) => part.text).join("")]
        : [],
    )
    .join("\n");
  terminal.seen = true;
}

/**
 * 把已提交 checkpoint 恢复成明文续接摘要。这是一次推理请求（provider.stream），
 * 不是又一次远程压缩协议调用：payload 不带 compaction_trigger、不带
 * context_management / previous_response_id，工具清空；超时与取消信号独立于父
 * 压缩信号（本函数自己的控制器 + 定时器），结束即释放。
 */
export async function recoverCheckpoint(
  request: CodexRemoteCompactionRequest,
  event: SessionBeforeCompactEvent,
): Promise<CompactionResult> {
  if (!request.priorCheckpoint) throw new Error("Checkpoint recovery requires a compatible checkpoint");
  if (request.signal.aborted) throw abortError();
  const controller = new AbortController();
  const signal = AbortSignal.any([request.signal, controller.signal]);
  const timer = setTimeout(
    () => controller.abort(new Error("Checkpoint recovery timed out")),
    request.requestTimeoutMs ?? 300_000,
  );
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    abortListener = () => reject(signal.reason instanceof Error ? signal.reason : abortError());
    signal.addEventListener("abort", abortListener, { once: true });
  });
  // provider 可能同步失败（收集竞争装好之前）；先挂接避免未处理拒绝。
  void aborted.catch(() => undefined);
  const baseFetch = request.fetch ?? globalThis.fetch;
  let stream: CodexProviderStream | undefined;
  let payloadSeen = false;
  let successes = 0;
  const terminal: TerminalObservation = { seen: false, text: undefined };
  try {
    stream = request.provider.stream(
      request.model,
      providerTranscriptContext(request.context),
      {
        ...(request.apiKey === undefined ? {} : { apiKey: request.apiKey }),
        ...(request.headers === undefined ? {} : { headers: request.headers }),
        ...(request.env === undefined ? {} : { env: request.env }),
        signal,
        transport: "sse",
        cacheRetention: "none",
        maxTokens: Math.max(
          1,
          Math.min(
            Math.floor(event.preparation.settings.reserveTokens * 0.8),
            request.model.maxTokens > 0 ? request.model.maxTokens : Number.POSITIVE_INFINITY,
          ),
        ),
        ...(request.maxRetries === undefined ? {} : { maxRetries: request.maxRetries }),
        ...(request.requestTimeoutMs === undefined ? {} : { timeoutMs: request.requestTimeoutMs }),
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const response = await baseFetch(input, {
            ...init,
            signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]),
          });
          if (signal.aborted) {
            void response.body?.cancel().catch(() => undefined);
            throw abortError();
          }
          if (!response.body) return response;
          if (response.ok) successes += 1;
          let bytes = 0;
          let pendingText = "";
          const decoder = new TextDecoder();
          // 单管道同时拥有两侧读者：abort/错误直接取消上游，不产生 tee 死锁；
          // 字节透传给 provider，同时有界解析完整数据帧观察终端事件。
          const body = response.body.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, destination) {
                bytes += chunk.byteLength;
                if (bytes > MAX_SSE_BYTES) throw new Error("Checkpoint recovery stream exceeded the size limit");
                destination.enqueue(chunk);
                pendingText += decoder.decode(chunk, { stream: true });
                for (;;) {
                  const boundary = /\r?\n\r?\n/.exec(pendingText);
                  if (!boundary) break;
                  const frame = pendingText.slice(0, boundary.index);
                  pendingText = pendingText.slice(boundary.index + boundary[0].length);
                  if (Buffer.byteLength(frame) > 64 * 1024) continue;
                  const data = frame
                    .split(/\r?\n/)
                    .filter((line) => line.startsWith("data:"))
                    .map((line) => line.slice(5).trimStart())
                    .join("\n");
                  if (data.length === 0) continue;
                  let raw: unknown;
                  try {
                    raw = JSON.parse(data);
                  } catch {
                    continue;
                  }
                  observeTerminalFrame(raw, terminal);
                }
              },
            }),
            { signal },
          );
          return new Response(body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        },
        onPayload: (payload: unknown) => {
          if (signal.aborted) throw abortError();
          const expanded = expandRemoteCompactionPayload(payload, request.priorCheckpoint);
          const input = assertPreparedInput(expanded);
          if (input.some((item) => item.type === "compaction_trigger"))
            throw new Error("Recovery input contains a compaction trigger");
          const prepared: Record<string, unknown> = {
            ...expanded,
            input: [
              ...input,
              {
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text:
                      RECOVERY_INSTRUCTION +
                      (event.customInstructions ? `\nAdditional focus: ${event.customInstructions}` : ""),
                  },
                ],
              },
            ],
            tools: [],
            tool_choice: "none",
            store: false,
            stream: true,
          };
          delete prepared.context_management;
          delete prepared.previous_response_id;
          if (Buffer.byteLength(JSON.stringify(prepared)) > MAX_SSE_BYTES)
            throw new Error("Checkpoint recovery request exceeded the size limit");
          payloadSeen = true;
          return prepared;
        },
      },
    );
    const activeStream = stream;
    const collect = async (): Promise<CompactionResult> => {
      let completed: CodexAssistantMessage | undefined;
      for await (const item of activeStream) {
        if (signal.aborted) throw abortError();
        if (item.type === "error") throw new Error(item.error.errorMessage ?? "Checkpoint recovery failed");
        if (item.type === "done") {
          if (
            completed ||
            item.reason !== "stop" ||
            item.message.stopReason !== "stop" ||
            item.message.content.some((block) => block.type !== "text" && block.type !== "thinking")
          )
            throw new Error("Unsafe checkpoint recovery completion");
          completed = item.message;
        }
      }
      if (!completed || !payloadSeen || successes !== 1 || !terminal.seen)
        throw new Error("Checkpoint recovery ended without validated completion");
      const summary = completed.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
      if (summary !== terminal.text)
        throw new Error("Checkpoint recovery terminal text conflicts with provider completion");
      if (!summary.trim() || Buffer.byteLength(summary) > MAX_COMPACTION_ITEM_BYTES)
        throw new Error("Checkpoint recovery returned an empty or oversized summary");
      const modifiedFiles = [
        ...new Set([...event.preparation.fileOps.written, ...event.preparation.fileOps.edited]),
      ].sort();
      const readFiles = [...event.preparation.fileOps.read].filter((path) => !modifiedFiles.includes(path)).sort();
      const finalSummary =
        summary +
        (readFiles.length ? `\n\n<read-files>\n${readFiles.join("\n")}\n</read-files>` : "") +
        (modifiedFiles.length ? `\n\n<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>` : "");
      if (Buffer.byteLength(finalSummary) > MAX_COMPACTION_ITEM_BYTES)
        throw new Error("Checkpoint recovery summary and file metadata exceeded the size limit");
      return {
        summary: finalSummary,
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        usage: completed.usage,
        details: { readFiles, modifiedFiles },
      };
    };
    return await Promise.race([collect(), aborted]);
  } finally {
    clearTimeout(timer);
    if (abortListener) signal.removeEventListener("abort", abortListener);
    controller.abort();
    // 即使自定义 provider 忽略 abort 信号，也解除消费者的阻塞
    stream?.end();
  }
}
