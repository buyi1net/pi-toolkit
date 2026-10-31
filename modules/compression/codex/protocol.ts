export type JsonObject = Record<string, unknown>;

export const MAX_COMPACTION_ITEM_BYTES = 2 * 1024 * 1024;

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

export function isCompactionItem(value: unknown): value is JsonObject {
  return (
    isJsonObject(value) &&
    value.type === "compaction" &&
    typeof value.encrypted_content === "string" &&
    value.encrypted_content.length > 0
  );
}

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
