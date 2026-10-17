// Codex 协议公共形状：opaque compaction item 的校验与 Responses payload 的
// checkpoint marker 改写（工单 04 从上游 pi-codex-compact 提取的共享核心）。
//
// 上游对应：reference/Pi生态/pi-codex-compact/source/src/protocol.ts
// （MIT，来源登记见 ../UPSTREAM.md）。本仓提取范围：isCompactionItem /
// validateCompactionItem / rewriteCheckpointMarker / appendCompactionTrigger /
// expandRemoteCompactionPayload / prepareRemoteCompactionPayload /
// hasCheckpointMarker 与尺寸常量——即 checkpoint 核心与回放投影依赖的
// payload 形状函数。SSE 收集（collectCompactionSse / collectCompactResponse）
// 与 responses-compact 响应校验（validateCompactedResponse）归工单 05/06 的
// 协议适配器，不在本文件。
//
// 工单 05/06/07 的协议适配器在本形状上工作：远端必须返回「恰好一个」
// type=compaction 且 encrypted_content 非空的 item；marker 在 payload.input
// 中恰好出现一次时才能被替换成 replacement history。

/** JSON 对象形状（opaque 历史与 provider payload 的通用底层类型） */
export type JsonObject = Record<string, unknown>;

export const MAX_COMPACTION_ITEM_BYTES = 2 * 1024 * 1024;

/** 协议级错误：响应不含合法 compaction item / payload 形状不符 / marker 数量异常 */
export class CodexCompactionProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexCompactionProtocolError";
  }
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** 远端 opaque compaction item 的形状：type=compaction 且 encrypted_content 非空 */
export function isCompactionItem(value: unknown): value is JsonObject {
  return (
    isJsonObject(value) &&
    value.type === "compaction" &&
    typeof value.encrypted_content === "string" &&
    value.encrypted_content.length > 0
  );
}

/** 校验并克隆一个 opaque compaction item（超尺寸或形状不符抛协议错误） */
export function validateCompactionItem(value: unknown, maxBytes = MAX_COMPACTION_ITEM_BYTES): JsonObject {
  if (!isCompactionItem(value)) {
    throw new CodexCompactionProtocolError("Remote response did not contain a valid compaction item");
  }
  if (byteLength(value) > maxBytes) {
    throw new CodexCompactionProtocolError("Remote compaction item exceeded the size limit");
  }
  return structuredClone(value);
}

function markerTextFromItem(item: unknown): string | undefined {
  if (!isJsonObject(item) || item.role !== "user" || !Array.isArray(item.content)) return undefined;
  if (item.content.length !== 1) return undefined;
  const content = item.content[0];
  if (!isJsonObject(content) || content.type !== "input_text" || typeof content.text !== "string") {
    return undefined;
  }
  return content.text;
}

/**
 * 把 provider payload 中恰好一个 checkpoint marker 消息替换成 replacement
 * history（工单 04/05/06/07 的 before_provider_request 回放改写）。marker 出现
 * 0 次或多次都视为协议异常——静默继续会让 opaque 历史丢失或重复注入。
 */
export function rewriteCheckpointMarker(
  payload: unknown,
  marker: string,
  replacementHistory: readonly unknown[],
): JsonObject {
  if (!isJsonObject(payload) || !Array.isArray(payload.input)) {
    throw new CodexCompactionProtocolError("Codex Responses payload is missing an input array");
  }
  const matches = payload.input
    .map((item, index) => (markerTextFromItem(item) === marker ? index : -1))
    .filter((index) => index >= 0);
  if (matches.length !== 1) {
    throw new CodexCompactionProtocolError(
      `Provider payload contained ${matches.length} checkpoint markers; expected exactly one`,
    );
  }
  const index = matches[0];
  return {
    ...payload,
    input: [
      ...payload.input.slice(0, index),
      ...structuredClone(replacementHistory),
      ...payload.input.slice(index + 1),
    ],
  };
}

export function appendCompactionTrigger(payload: unknown): JsonObject {
  if (!isJsonObject(payload) || !Array.isArray(payload.input)) {
    throw new CodexCompactionProtocolError("Codex Responses payload is missing an input array");
  }
  if (payload.input.some((item) => isJsonObject(item) && item.type === "compaction_trigger")) {
    throw new CodexCompactionProtocolError("Provider payload already contains a compaction trigger");
  }
  return { ...payload, input: [...payload.input, { type: "compaction_trigger" }] };
}

export function expandRemoteCompactionPayload(
  payload: unknown,
  checkpoint?: { marker: string; replacementHistory: readonly unknown[] },
): JsonObject {
  if (checkpoint) {
    return rewriteCheckpointMarker(payload, checkpoint.marker, checkpoint.replacementHistory);
  }
  if (!isJsonObject(payload) || !Array.isArray(payload.input)) {
    throw new CodexCompactionProtocolError("Responses payload is missing an input array");
  }
  return structuredClone(payload);
}

export function prepareRemoteCompactionPayload(
  payload: unknown,
  checkpoint?: { marker: string; replacementHistory: readonly unknown[] },
): JsonObject {
  return appendCompactionTrigger(expandRemoteCompactionPayload(payload, checkpoint));
}

export function hasCheckpointMarker(payload: unknown, marker: string): boolean {
  return (
    isJsonObject(payload) &&
    Array.isArray(payload.input) &&
    payload.input.some((item) => markerTextFromItem(item) === marker)
  );
}
