import { providerTranscriptContext } from "./remote-shared.ts";
import {
  CodexCompactionProtocolError,
  expandRemoteCompactionPayload,
  isJsonObject,
  type JsonObject,
} from "./protocol.ts";
import type { ResponsesCompactionProfile } from "./profiles.ts";
import type {
  CodexRemoteCompactionAdapter,
  CodexRemoteCompactionRequest,
  CodexRemoteCompactionResponse,
  CodexRemoteUsage,
} from "./remote.ts";

const OFFICIAL_COMPACT_FIELDS = [
  "model",
  "input",
  "instructions",
  "previous_response_id",
  "prompt_cache_key",
  "prompt_cache_retention",
  "service_tier",
] as const;

const CODEX_COMPACT_FIELDS = [
  "model",
  "input",
  "instructions",
  "tools",
  "parallel_tool_calls",
  "reasoning",
  "service_tier",
  "prompt_cache_key",
  "text",
  "access_programs",
] as const;

function abortError(): DOMException {
  return new DOMException("Compaction aborted", "AbortError");
}

function compactPayload(payload: JsonObject, profile: ResponsesCompactionProfile): JsonObject {
  const fields = profile === "codex-responses-v1" ? CODEX_COMPACT_FIELDS : OFFICIAL_COMPACT_FIELDS;
  const result: JsonObject = {};
  for (const field of fields) {
    if (Object.hasOwn(payload, field) && payload[field] !== undefined) {
      result[field] = structuredClone(payload[field]);
    }
  }
  if (typeof result.model !== "string" || result.model.length === 0) {
    throw new CodexCompactionProtocolError("Responses payload is missing a model");
  }
  assertPreparedInput(result);
  return result;
}

function assertPreparedInput(payload: JsonObject): JsonObject[] {
  if (!Array.isArray(payload.input) || !payload.input.every(isJsonObject)) {
    throw new CodexCompactionProtocolError("Prepared compaction payload has invalid input items");
  }
  return structuredClone(payload.input);
}

function requestUrl(input: string | URL | Request): URL {
  return new URL(input instanceof Request ? input.url : String(input));
}

export function responsesCompactUrl(input: string | URL | Request): URL {
  const original = requestUrl(input);
  if (!original.pathname.endsWith("/responses")) {
    throw new CodexCompactionProtocolError("Provider request URL does not end with the Responses endpoint");
  }
  const compact = new URL(original);
  compact.pathname = `${compact.pathname}/compact`;
  if (compact.origin !== original.origin) {
    throw new CodexCompactionProtocolError("Responses Compact URL changed origin");
  }
  return compact;
}

function mergedHeaders(input: string | URL | Request, init?: RequestInit): Headers {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, name) => {
    headers.set(name, value);
  });
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.set("accept", "application/json");
  headers.set("content-type", "application/json");
  return headers;
}

function mergedSignal(
  input: string | URL | Request,
  init: RequestInit | undefined,
  ownerSignal: AbortSignal,
): AbortSignal {
  const signals = [ownerSignal];
  if (input instanceof Request) signals.push(input.signal);
  if (init?.signal) signals.push(init.signal);
  return signals.length === 1 ? ownerSignal : AbortSignal.any(signals);
}

function nonRetryableBridgeFailure(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  return Response.json(
    {
      error: {
        message,
        type: "invalid_request_error",
        code: "invalid_compact_response",
      },
    },
    { status: 400 },
  );
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function optionalUsageDetail(details: unknown, field: string): number {
  if (details === undefined || details === null) return 0;
  if (!isJsonObject(details)) {
    throw new CodexCompactionProtocolError("Responses Compact response has invalid usage details");
  }
  const value = details[field];
  if (value === undefined || value === null) return 0;
  if (!nonNegativeInteger(value)) {
    throw new CodexCompactionProtocolError(`Responses Compact response has invalid usage detail ${field}`);
  }
  return value;
}

function validatedUsage(response: JsonObject): JsonObject {
  const usage = response.usage;
  if (!isJsonObject(usage)) {
    throw new CodexCompactionProtocolError("Responses Compact response is missing usage");
  }
  for (const field of ["input_tokens", "output_tokens", "total_tokens"] as const) {
    if (!nonNegativeInteger(usage[field])) {
      throw new CodexCompactionProtocolError(`Responses Compact response has invalid ${field}`);
    }
  }
  const inputTokens = usage.input_tokens as number;
  const outputTokens = usage.output_tokens as number;
  const totalTokens = usage.total_tokens as number;
  const cachedTokens = optionalUsageDetail(usage.input_tokens_details, "cached_tokens");
  const cacheWriteTokens = optionalUsageDetail(usage.input_tokens_details, "cache_write_tokens");
  const reasoningTokens = optionalUsageDetail(usage.output_tokens_details, "reasoning_tokens");
  if (cachedTokens + cacheWriteTokens > inputTokens || reasoningTokens > outputTokens) {
    throw new CodexCompactionProtocolError("Responses Compact response has inconsistent usage details");
  }
  if (totalTokens !== inputTokens + outputTokens) {
    throw new CodexCompactionProtocolError("Responses Compact response has inconsistent total usage");
  }
  return structuredClone(usage);
}

function validatedCompactOutput(value: unknown): { item: JsonObject; output: JsonObject[] } {
  if (!isJsonObject(value) || !Array.isArray(value.output)) {
    throw new CodexCompactionProtocolError("Responses Compact returned an invalid response object");
  }
  if (value.output.length === 0) {
    throw new CodexCompactionProtocolError("Responses Compact returned no output items");
  }
  const output = (value.output as unknown[]).map((item) => {
    if (!isJsonObject(item)) {
      throw new CodexCompactionProtocolError("Responses Compact returned a non-object output item");
    }
    return structuredClone(item);
  });
  const compactionItems = output.filter((item) => item.type === "compaction");
  if (compactionItems.length !== 1 || output.at(-1)?.type !== "compaction") {
    throw new CodexCompactionProtocolError(
      "Responses Compact must return retained messages followed by one compaction item",
    );
  }
  for (const item of output.slice(0, -1)) {
    if (!isRetainedCompactMessage(item)) {
      throw new CodexCompactionProtocolError("Responses Compact returned an unsupported retained output item");
    }
  }
  const item = output.at(-1)!;
  if (item.type !== "compaction" || typeof item.encrypted_content !== "string" || item.encrypted_content.length === 0) {
    throw new CodexCompactionProtocolError("Remote response did not contain a valid compaction item");
  }
  return { item: structuredClone(item), output };
}

function isRetainedCompactContent(value: unknown): value is JsonObject {
  if (!isJsonObject(value)) return false;
  if (value.type === "input_text") return typeof value.text === "string";
  if (value.type !== "input_image") return false;
  if (
    value.detail !== undefined &&
    value.detail !== null &&
    value.detail !== "auto" &&
    value.detail !== "low" &&
    value.detail !== "high" &&
    value.detail !== "original"
  ) {
    return false;
  }
  if (
    (value.file_id !== undefined && value.file_id !== null && typeof value.file_id !== "string") ||
    (value.image_url !== undefined && value.image_url !== null && typeof value.image_url !== "string")
  ) {
    return false;
  }
  return (
    (typeof value.file_id === "string" && value.file_id.length > 0) ||
    (typeof value.image_url === "string" && value.image_url.length > 0)
  );
}

function isRetainedCompactMessage(value: unknown): value is JsonObject {
  return (
    isJsonObject(value) &&
    value.role === "user" &&
    (value.type === undefined || value.type === "message") &&
    Array.isArray(value.content) &&
    value.content.length > 0 &&
    value.content.every(isRetainedCompactContent)
  );
}

function syntheticCompletion(usage: JsonObject, payload: JsonObject): Response {
  const completed = {
    id: "resp_pi_compact_bridge",
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: payload.model,
    output: [],
    parallel_tool_calls: false,
    tool_choice: "auto",
    tools: [],
    usage,
  };
  const events = [
    { type: "response.created", response: { ...completed, status: "in_progress" } },
    { type: "response.completed", response: completed },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function collectProviderUsage(stream: AsyncIterable<unknown>, signal: AbortSignal): Promise<CodexRemoteUsage> {
  let usage: CodexRemoteUsage | undefined;
  for await (const event of stream) {
    if (signal.aborted) throw abortError();
    if (!isJsonObject(event)) continue;
    if (event.type === "error") {
      const errorObj = event.error;
      const message = isJsonObject(errorObj) ? errorObj.errorMessage : undefined;
      throw new Error(typeof message === "string" && message.length > 0 ? message : "Responses compaction request failed");
    }
    if (event.type === "done") {
      const message = event.message;
      if (isJsonObject(message) && isJsonObject(message.usage)) usage = message.usage as unknown as CodexRemoteUsage;
    }
  }
  if (signal.aborted) throw abortError();
  if (!usage) throw new Error("Responses provider stream ended without completion usage");
  return usage;
}

export function createResponsesCompactAdapter(defaultFetch?: typeof globalThis.fetch): CodexRemoteCompactionAdapter {
  return async (request: CodexRemoteCompactionRequest): Promise<CodexRemoteCompactionResponse> => {
    if (request.signal.aborted) throw abortError();
    let preparedPayload: JsonObject | undefined;
    let sentInput: JsonObject[] | undefined;
    let compactItem: JsonObject | undefined;
    let compactOutput: JsonObject[] | undefined;
    let bridgeError: unknown;
    let dispatchInFlight = false;
    let successfulResponses = 0;
    const baseFetch = request.fetch ?? defaultFetch ?? globalThis.fetch;
    const bridgeFetch: typeof globalThis.fetch = async (input, init) => {
      if (request.signal.aborted) throw abortError();
      if (successfulResponses > 0) {
        bridgeError = new CodexCompactionProtocolError("Provider dispatched again after Responses Compact succeeded");
        return nonRetryableBridgeFailure(bridgeError);
      }
      if (dispatchInFlight) {
        bridgeError = new CodexCompactionProtocolError("Provider dispatched overlapping Responses Compact requests");
        return nonRetryableBridgeFailure(bridgeError);
      }
      if (!preparedPayload) {
        bridgeError = new CodexCompactionProtocolError("Provider dispatched before exposing its request payload");
        return nonRetryableBridgeFailure(bridgeError);
      }
      let compactUrl: URL;
      try {
        compactUrl = responsesCompactUrl(input);
      } catch (error) {
        bridgeError = error;
        return nonRetryableBridgeFailure(error);
      }
      const signal = mergedSignal(input, init, request.signal);
      dispatchInFlight = true;
      try {
        const response = await baseFetch(compactUrl, {
          ...init,
          method: "POST",
          headers: mergedHeaders(input, init),
          body: JSON.stringify(preparedPayload),
          signal,
        });
        if (!response.ok) return response;
        try {
          const body = await readJsonObject(response, signal);
          const usage = validatedUsage(body);
          const result = validatedCompactOutput(body);
          compactItem = result.item;
          compactOutput = result.output;
          successfulResponses += 1;
          if (successfulResponses !== 1) {
            throw new CodexCompactionProtocolError(
              "Provider returned more than one successful Responses Compact response",
            );
          }
          return syntheticCompletion(usage, preparedPayload);
        } catch (error) {
          bridgeError = error;
          return nonRetryableBridgeFailure(error);
        }
      } finally {
        dispatchInFlight = false;
      }
    };

    const stream = request.provider.stream(request.model, providerTranscriptContext(request.context), {
      apiKey: request.apiKey,
      headers: request.headers,
      env: request.env,
      signal: request.signal,
      transport: "sse",
      cacheRetention: "none",
      timeoutMs: request.requestTimeoutMs ?? 5 * 60 * 1000,
      maxRetries: request.maxRetries ?? 2,
      fetch: bridgeFetch,
      onPayload: (payload: unknown) => {
        if (preparedPayload) {
          throw new CodexCompactionProtocolError("Provider exposed more than one compaction request payload");
        }
        const expanded = expandRemoteCompactionPayload(payload, request.priorCheckpoint);
        preparedPayload = compactPayload(expanded, request.profile);
        sentInput = assertPreparedInput(preparedPayload);
        return expanded;
      },
    });

    const usage = await collectProviderUsage(stream, request.signal);
    if (bridgeError) throw bridgeError;
    if (!preparedPayload || !sentInput || !compactItem || !compactOutput || successfulResponses !== 1) {
      throw new CodexCompactionProtocolError("Provider did not complete exactly one Responses Compact request");
    }
    return {
      item: compactItem,
      promptInput: sentInput,
      compactedOutput: compactOutput,
      usage,
    };
  };
}

async function readJsonObject(response: Response, signal: AbortSignal): Promise<JsonObject> {
  if (signal.aborted) throw abortError();
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    if (signal.aborted) throw abortError();
    throw error;
  }
  if (signal.aborted) throw abortError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CodexCompactionProtocolError("Responses Compact returned malformed JSON");
  }
  if (!isJsonObject(parsed)) {
    throw new CodexCompactionProtocolError("Responses Compact returned an invalid response object");
  }
  return parsed;
}
