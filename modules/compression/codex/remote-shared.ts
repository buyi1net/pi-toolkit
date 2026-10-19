// Codex 远程压缩的共享收集工具（工单 05 从上游 remote-shared.ts / remote-types.ts 提取）。
//
// 上游对应：reference/Pi生态/pi-codex-compact/source/src/remote-shared.ts 与
// remote-types.ts（MIT，来源登记见 ../UPSTREAM.md）。提取与适配：
// - collectProviderUsage（遍历 provider 事件流收集 usage）与 abortError /
//   assertPreparedInput / MAX_SSE_BYTES 保留上游算法；
// - 类型口径：pi-ai 已按宿主依赖规则登记为 peer/dev 依赖（Pi 1.3.0），provider 流
//   与 usage 的形状继续从 pi-coding-agent 公开导出结构推导，provider-context helper
//   经命名空间导入调用 pi-ai 1.3.0 官方 normalizeContext（宿主缺该导出时由
//   resolveNormalizeContext 抛 ProviderTranscriptContextUnsupportedError，不做版本
//   探测、不回退旧输入形状）；
// - providerTranscriptContext：与上游同源——经 pi-ai 的 normalizeContext 把
//   Context（systemPrompt + tools + messages）折成带 brand 的 TranscriptContext，
//   system prompt 与工具声明折入 leading system message，其余消息原顺序保留；
//   这是 Pi 1.3.0 provider.stream 的唯一合法输入形状（旧版 { systemPrompt,
//   messages, tools } 直传不再提供）。
//
// 工单 06（responses/compact）、07（Context Management）与 checkpoint recovery 的
// 协议适配器共用本文件的 provider-context helper 与收集工具。

import * as piAi from "@earendil-works/pi-ai";
import type { JsonObject } from "./protocol.ts";
import { isJsonObject } from "./protocol.ts";
import type { CodexRemoteContext, CodexRemoteProvider, CodexRemoteUsage } from "./remote.ts";

/** 上游同款 SSE 尺寸上限（远端响应收集的字节预算） */
export const MAX_SSE_BYTES = 8 * 1024 * 1024;

/** provider 事件流类型（pi-ai AssistantMessageEventStream 的结构推导形） */
export type CodexProviderStream = ReturnType<CodexRemoteProvider["stream"]>;

/** provider.stream 的第二参（Pi 1.3.0 的 TranscriptContext，官方 normalizeContext 产出） */
export type CodexProviderTranscriptContext = Parameters<CodexRemoteProvider["stream"]>[1];

export function abortError(): DOMException {
  return new DOMException("Compaction aborted", "AbortError");
}

/** 校验 provider payload 的 input 形状并克隆（onPayload 改写后的统一出口） */
export function assertPreparedInput(payload: JsonObject): JsonObject[] {
  if (!Array.isArray(payload.input) || !payload.input.every(isJsonObject)) {
    throw new Error("Prepared compaction payload has invalid input items");
  }
  return structuredClone(payload.input);
}

/**
 * 宿主 pi-ai 缺 Pi 1.3.0 normalizeContext 的显式失败（单向升级：只报宿主不支持，
 * 不探测版本、不回退旧版 { systemPrompt, messages, tools } 直传口径）。
 */
export class ProviderTranscriptContextUnsupportedError extends Error {
  constructor() {
    super(
      "Host @earendil-works/pi-ai does not provide normalizeContext (Pi 1.3.0+ required); " +
        "Codex remote compaction cannot build the provider.stream TranscriptContext without it",
    );
    this.name = "ProviderTranscriptContextUnsupportedError";
  }
}

/**
 * 从宿主 pi-ai 命名空间取 normalizeContext：缺导出或导出不是函数，一律按「宿主
 * 不支持」受控报错。命名空间可注入，能力检查本身可单测；生产路径用默认参数即
 * 宿主真实导出（命名空间导入，缺导出不会在插件加载期把整个模块图链接失败）。
 */
export function resolveNormalizeContext(piAiNamespace: typeof piAi = piAi): typeof piAi.normalizeContext {
  const normalize = piAiNamespace?.normalizeContext;
  if (typeof normalize !== "function") throw new ProviderTranscriptContextUnsupportedError();
  return normalize;
}

/**
 * 把压缩请求上下文（CodexRemoteContext，readonly 的 Context 结构形状）交给官方
 * normalizeContext 折成 provider.stream 要求的 TranscriptContext：system prompt 与
 * 工具声明由官方折入 leading system message，messages 顺序与只读内容原样保留。
 * 四条 Codex 路径（Remote V2 / responses-compact / Context Management / checkpoint
 * recovery）共用本 helper；除官方 normalizeContext 外不构造 provider 输入形状。
 */
export function providerTranscriptContext(context: CodexRemoteContext): CodexProviderTranscriptContext {
  const normalizeContext = resolveNormalizeContext();
  return normalizeContext({
    ...(context.systemPrompt === undefined ? {} : { systemPrompt: context.systemPrompt }),
    messages: [...context.messages],
    ...(context.tools === undefined ? {} : { tools: [...context.tools] }),
  });
}

/**
 * 收集 provider 事件流的最终 usage（上游 remote-shared 同款）：
 * error 事件即抛错；done 事件取 message.usage；流结束仍无 usage 视为协议失败。
 */
export async function collectProviderUsage(
  stream: CodexProviderStream,
  signal: AbortSignal,
): Promise<CodexRemoteUsage> {
  let usage: CodexRemoteUsage | undefined;
  for await (const event of stream) {
    if (signal.aborted) throw abortError();
    if (event.type === "error") {
      throw new Error(event.error.errorMessage ?? "Responses compaction request failed");
    }
    if (event.type === "done") usage = event.message.usage;
  }
  if (signal.aborted) throw abortError();
  if (!usage) throw new Error("Responses provider stream ended without completion usage");
  return usage;
}
