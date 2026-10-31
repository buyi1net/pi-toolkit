import * as piAi from "@earendil-works/pi-ai";
import type { JsonObject } from "./protocol.ts";
import { isJsonObject } from "./protocol.ts";
import type { CodexRemoteContext, CodexRemoteProvider, CodexRemoteUsage } from "./remote.ts";

export const MAX_SSE_BYTES = 8 * 1024 * 1024;

export type CodexProviderStream = ReturnType<CodexRemoteProvider["stream"]>;

export type CodexProviderTranscriptContext = Parameters<CodexRemoteProvider["stream"]>[1];

export function abortError(): DOMException {
  return new DOMException("Compaction aborted", "AbortError");
}

export function assertPreparedInput(payload: JsonObject): JsonObject[] {
  if (!Array.isArray(payload.input) || !payload.input.every(isJsonObject)) {
    throw new Error("Prepared compaction payload has invalid input items");
  }
  return structuredClone(payload.input);
}

export class ProviderTranscriptContextUnsupportedError extends Error {
  constructor() {
    super(
      "Host @earendil-works/pi-ai does not provide normalizeContext (Pi 1.3.0+ required); " +
        "Codex remote compaction cannot build the provider.stream TranscriptContext without it",
    );
    this.name = "ProviderTranscriptContextUnsupportedError";
  }
}

export function resolveNormalizeContext(piAiNamespace: typeof piAi = piAi): typeof piAi.normalizeContext {
  const normalize = piAiNamespace?.normalizeContext;
  if (typeof normalize !== "function") throw new ProviderTranscriptContextUnsupportedError();
  return normalize;
}

export function providerTranscriptContext(context: CodexRemoteContext): CodexProviderTranscriptContext {
  const normalizeContext = resolveNormalizeContext();
  return normalizeContext({
    ...(context.systemPrompt === undefined ? {} : { systemPrompt: context.systemPrompt }),
    messages: [...context.messages],
    ...(context.tools === undefined ? {} : { tools: [...context.tools] }),
  });
}

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
