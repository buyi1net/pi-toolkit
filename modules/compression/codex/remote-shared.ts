// Codex 远程压缩的共享收集工具（工单 05 从上游 remote-shared.ts / remote-types.ts 提取）。
//
// 上游对应：reference/Pi生态/pi-codex-compact/source/src/remote-shared.ts 与
// remote-types.ts（MIT，来源登记见 ../UPSTREAM.md）。提取与适配：
// - collectProviderUsage（遍历 provider 事件流收集 usage）与 abortError /
//   assertPreparedInput / MAX_SSE_BYTES 保留上游算法；
// - 类型不从 pi-ai 直接导入（pi-ai 不是本包直接依赖、package.json 不动）：
//   provider 流与 usage 的形状从 pi-coding-agent 公开导出结构推导（与 04 的
//   remote.ts 同款口径）；
// - providerStreamContext：上游经 pi-ai 的 normalizeContext 把 Context 折成
//   TranscriptContext；本仓依赖版本（pi-coding-agent 0.85.1 的 pi-ai）的
//   provider.stream 直接接受 { systemPrompt?, messages, tools? } 形状，这里做
//   同义的只读转写（readonly 数组 → 可变数组），不引入版本外的接缝。
//
// 工单 06（responses/compact）与 07（Context Management）的协议适配器可复用
// 本文件；三单各自只改自己的协议文件。

import type { JsonObject } from "./protocol.ts";
import { isJsonObject } from "./protocol.ts";
import type { CodexRemoteProvider, CodexRemoteUsage } from "./remote.ts";

/** 上游同款 SSE 尺寸上限（远端响应收集的字节预算） */
export const MAX_SSE_BYTES = 8 * 1024 * 1024;

/** provider 事件流类型（pi-ai AssistantMessageEventStream 的结构推导形） */
export type CodexProviderStream = ReturnType<CodexRemoteProvider["stream"]>;

/** provider.stream 的第二参（请求上下文；pi-ai Context 的结构推导形） */
export type CodexProviderStreamContext = Parameters<CodexRemoteProvider["stream"]>[1];

/** provider.stream 的工具元素形（parameters 是 provider 侧 schema） */
type CodexProviderTool = NonNullable<CodexProviderStreamContext["tools"]>[number];

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
 * 把压缩请求上下文（CodexRemoteContext，readonly）转写成 provider.stream 接受的
 * 请求上下文。不增删语义字段；克隆一层避免调用方共享引用。
 */
export function providerStreamContext(context: {
  readonly systemPrompt?: string;
  readonly messages: readonly unknown[];
  readonly tools?: readonly { readonly name: string; readonly description: string; readonly parameters: unknown }[];
}): CodexProviderStreamContext {
  return {
    ...(context.systemPrompt === undefined ? {} : { systemPrompt: context.systemPrompt }),
    messages: [...context.messages] as CodexProviderStreamContext["messages"],
    ...(context.tools === undefined
      ? {}
      : {
          tools: context.tools.map(
            (tool): CodexProviderTool => ({
              name: tool.name,
              description: tool.description,
              // 压缩请求的工具 schema 对 provider 侧是透传的不透明值
              parameters: tool.parameters as CodexProviderTool["parameters"],
            }),
          ),
        }),
  };
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
