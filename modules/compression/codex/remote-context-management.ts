import { expandRemoteCompactionPayload, type JsonObject } from "./protocol.ts";
import { providerTranscriptContext } from "./remote-shared.ts";
import {
  ContextManagementProtocolError,
  COMPACTION_MAINTENANCE_MESSAGE,
  CONTEXT_MANAGEMENT_HISTORY_BYTE_BUDGET,
  CONTEXT_MANAGEMENT_HISTORY_TOKEN_BUDGET,
  CONTEXT_MANAGEMENT_THRESHOLD,
  createContextManagementCollector,
  validateContextManagementHistory,
} from "./context-management.ts";
import type {
  CodexRemoteCompactionAdapter,
  CodexRemoteCompactionRequest,
  CodexRemoteCompactionResponse,
} from "./remote.ts";

const MAX_SSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_RETRIES = 2;

function abortError(): DOMException {
  return new DOMException("Context management compaction aborted", "AbortError");
}

function assertPreparedInput(payload: JsonObject): JsonObject[] {
  if (!Array.isArray(payload.input) || !payload.input.every((item) => isJsonObject(item))) {
    throw new ContextManagementProtocolError("provider payload has invalid input items");
  }
  return structuredClone(payload.input);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function signalReason(signal: AbortSignal): unknown {
  return signal.reason instanceof Error || signal.reason instanceof DOMException ? signal.reason : abortError();
}

function mergeSignals(signal: AbortSignal, other: AbortSignal | null | undefined): AbortSignal {
  return other ? AbortSignal.any([signal, other]) : signal;
}

/** 读取一个成功的 Responses SSE，并把原始事件交给 Context Management 收集器。 */
async function collectSse(
  response: Response,
  collector: ReturnType<typeof createContextManagementCollector>,
  signal: AbortSignal,
): Promise<void> {
  if (!response.body) {
    throw new ContextManagementProtocolError("response did not contain a body");
  }
  const reader = response.body.getReader();
  const onAbort = () => {
    void reader.cancel(signalReason(signal)).catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let pending = "";
  let dataLines: string[] = [];

  const dispatch = (): void => {
    if (dataLines.length === 0) return;
    const data = dataLines.join("\n");
    dataLines = [];
    if (data === "[DONE]") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      throw new ContextManagementProtocolError("returned malformed SSE JSON");
    }
    collector.observe(parsed);
  };
  const processLine = (line: string): void => {
    if (line === "") {
      dispatch();
      return;
    }
    if (line.startsWith(":")) return;
    if (line === "data") dataLines.push("");
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /u, ""));
  };

  try {
    while (true) {
      if (signal.aborted) throw signalReason(signal);
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_SSE_BYTES) {
        throw new ContextManagementProtocolError("stream exceeded the size limit");
      }
      pending += decoder.decode(value, { stream: true });
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        const rawLine = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        processLine(rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine);
        newline = pending.indexOf("\n");
      }
    }
    pending += decoder.decode();
    if (pending.length > 0) processLine(pending.endsWith("\r") ? pending.slice(0, -1) : pending);
    dispatch();
    if (signal.aborted) throw signalReason(signal);
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

/**
 * 建立 Context Management adapter。工厂只返回这一条协议的实现，协调者
 * 在 mod.ts 之外注入 `{ "context-management": create...() }`，因此本实现
 * 不会把失败转成 responses/compact 或 Remote V2 的隐式回退。
 */
export function createContextManagementAdapter(): CodexRemoteCompactionAdapter {
  return async function requestContextManagement(
    request: CodexRemoteCompactionRequest,
  ): Promise<CodexRemoteCompactionResponse> {
    if (request.signal.aborted) throw signalReason(request.signal);

    const timeoutController = new AbortController();
    const signal = AbortSignal.any([request.signal, timeoutController.signal]);
    const timeout = setTimeout(
      () => timeoutController.abort(new Error("Context management request timed out")),
      request.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    );
    const callbackCollector = createContextManagementCollector();
    let callbackEvents = 0;
    let sentInput: JsonObject[] | undefined;
    let successfulResponses = 0;
    const responseCollectors: Array<{
      readonly collector: ReturnType<typeof createContextManagementCollector>;
      readonly promise: Promise<void>;
    }> = [];
    const baseFetch = request.fetch ?? globalThis.fetch;
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signalReason(signal));
      signal.addEventListener("abort", onAbort, { once: true });
    });

    const fetchWithCapture: typeof globalThis.fetch = async (input, init) => {
      const response = await baseFetch(input, {
        ...init,
        signal: mergeSignals(signal, init?.signal),
      });
      if (response.ok) {
        successfulResponses += 1;
        const clone = response.clone();
        const collector = createContextManagementCollector();
        responseCollectors.push({ collector, promise: collectSse(clone, collector, signal) });
      }
      return response;
    };

    const onProviderStreamEvent = (event: unknown): void => {
      callbackEvents += 1;
      callbackCollector.observe(event);
    };

    let streamResult: { usage?: CodexRemoteCompactionResponse["usage"] } | undefined;
    let streamError: unknown;
    try {
      const streamOptions = {
        apiKey: request.apiKey,
        headers: request.headers,
        env: request.env,
        signal,
        transport: "sse",
        cacheRetention: "none",
        timeoutMs: request.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        maxRetries: request.maxRetries ?? DEFAULT_MAX_RETRIES,
        fetch: fetchWithCapture,
        onPayload: (payload: unknown): JsonObject => {
          const expanded = expandRemoteCompactionPayload(payload, request.priorCheckpoint);
          sentInput = assertPreparedInput(expanded);
          if (sentInput.some((item) => item.type === "compaction_trigger")) {
            throw new ContextManagementProtocolError(
              "input already contains a compaction trigger",
            );
          }
          const include = expanded.include;
          if (include !== undefined && (!Array.isArray(include) || !include.every((field) => typeof field === "string"))) {
            throw new ContextManagementProtocolError("provider payload has an invalid include list");
          }
          const nextInclude = include?.includes("reasoning.encrypted_content")
            ? [...include]
            : [...(include ?? []), "reasoning.encrypted_content"];
          const prepared: JsonObject = {
            ...expanded,
            include: nextInclude,
            input: [
              ...sentInput,
              { role: "user", content: [{ type: "input_text", text: COMPACTION_MAINTENANCE_MESSAGE }] },
            ],
            context_management: [{ type: "compaction", compact_threshold: CONTEXT_MANAGEMENT_THRESHOLD }],
            store: false,
            stream: true,
            tool_choice: "none",
          };
          delete prepared.previous_response_id;
          return prepared;
        },
        // Pi 1.3.0 的 StreamOptions 已类型化该回调；不支持它的 provider 适配器
        // 不调用（下方 fetch tee 是同等观察的兼容路径）。
        onProviderStreamEvent,
      };
      const stream = request.provider.stream(request.model, providerTranscriptContext(request.context), streamOptions);
      streamResult = await Promise.race([stream.result(), aborted]);
    } catch (error) {
      streamError = error;
    }

    let captureError: unknown;
    try {
      await Promise.all(responseCollectors.map((capture) => capture.promise));
    } catch (error) {
      captureError = error;
    }

    try {
      if (streamError !== undefined) throw streamError;
      if (captureError !== undefined) throw captureError;
      if (signal.aborted) throw signalReason(signal);
      if (!sentInput) {
        throw new ContextManagementProtocolError("provider did not expose a prepared input");
      }
      if (callbackEvents === 0 && successfulResponses !== 1) {
        throw new ContextManagementProtocolError(
          `provider exposed ${successfulResponses} successful requests; expected exactly one`,
        );
      }
      if (callbackEvents > 0 && successfulResponses > 1) {
        throw new ContextManagementProtocolError(
          `provider exposed ${successfulResponses} successful requests; expected exactly one`,
        );
      }

      const history =
        callbackEvents > 0
          ? callbackCollector.finish()
          : (() => {
              // The fetch tee owns its collector so that provider callbacks and
              // transport parsing cannot publish the same output twice.
              if (responseCollectors.length !== 1) {
                throw new ContextManagementProtocolError(
                  `provider exposed ${responseCollectors.length} successful responses; expected exactly one`,
                );
              }
              return responseCollectors[0].collector.finish();
            })();
      const validated = validateContextManagementHistory(history, {
        byteBudget: CONTEXT_MANAGEMENT_HISTORY_BYTE_BUDGET,
        tokenBudget: CONTEXT_MANAGEMENT_HISTORY_TOKEN_BUDGET,
      });
      if (!streamResult?.usage) throw new ContextManagementProtocolError("stream ended without usage");
      return {
        item: validated[0],
        promptInput: sentInput,
        replacementHistory: validated,
        usage: streamResult.usage,
      };
    } finally {
      clearTimeout(timeout);
      if (onAbort) signal.removeEventListener("abort", onAbort);
      timeoutController.abort();
    }
  };
}
