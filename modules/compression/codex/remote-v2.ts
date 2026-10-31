import {
  CodexCompactionProtocolError,
  isJsonObject,
  prepareRemoteCompactionPayload,
  type JsonObject,
  validateCompactionItem,
} from "./protocol.ts";
import {
  CodexOAuthRejectionError,
  CodexRoutePausedError,
  inspectFailureResponse,
  observeSseRejections,
} from "./compaction-failure.ts";
import { codexRejectionRouteKey, RejectedRoutes } from "./rejection-state.ts";
import {
  abortError,
  assertPreparedInput,
  collectProviderUsage,
  MAX_SSE_BYTES,
  providerTranscriptContext,
} from "./remote-shared.ts";
import type {
  CodexRemoteCompactionAdapter,
  CodexRemoteCompactionRequest,
  CodexRemoteCompactionResponse,
} from "./remote.ts";

export interface CollectedCompaction {
  item: JsonObject;
  completedResponse?: JsonObject;
}

function compactionItemsFromEvent(event: JsonObject): unknown[] {
  const items: unknown[] = [];
  if (event.type === "response.output_item.done" && isJsonObject(event.item)) {
    items.push(event.item);
  }
  if (event.type === "response.completed" && isJsonObject(event.response)) {
    const output = event.response.output;
    if (Array.isArray(output)) items.push(...output);
  }
  return items.filter((item) => isJsonObject(item) && item.type === "compaction");
}

export async function collectCompactionSse(
  stream: ReadableStream<Uint8Array>,
  options: {
    signal?: AbortSignal;
    maxBytes?: number;
    maxItemBytes?: number;
  } = {},
): Promise<CollectedCompaction> {
  const maxBytes = options.maxBytes ?? MAX_SSE_BYTES;
  const reader = stream.getReader();
  const onAbort = () => {
    void reader.cancel(new DOMException("Compaction aborted", "AbortError")).catch(() => undefined);
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const decoder = new TextDecoder();
  let bytes = 0;
  let pending = "";
  let dataLines: string[] = [];
  let completedResponse: JsonObject | undefined;
  const items = new Map<string, JsonObject>();

  const checkAbort = () => {
    if (options.signal?.aborted) throw new DOMException("Compaction aborted", "AbortError");
  };
  const dispatch = () => {
    if (dataLines.length === 0) return;
    const data = dataLines.join("\n");
    dataLines = [];
    if (data === "[DONE]") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      throw new CodexCompactionProtocolError("Remote compaction returned malformed SSE JSON");
    }
    if (!isJsonObject(parsed)) return;
    if (parsed.type === "response.completed") {
      completedResponse = isJsonObject(parsed.response) ? parsed.response : {};
    }
    for (const candidate of compactionItemsFromEvent(parsed)) {
      const item = validateCompactionItem(candidate, options.maxItemBytes);
      items.set(JSON.stringify(item), item);
    }
  };
  const processLine = (line: string) => {
    if (line === "") {
      dispatch();
      return;
    }
    if (line.startsWith(":")) return;
    if (line === "data") dataLines.push("");
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  };

  try {
    while (true) {
      checkAbort();
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        throw new CodexCompactionProtocolError("Remote compaction stream exceeded the size limit");
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
    checkAbort();
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }

  if (!completedResponse) {
    throw new CodexCompactionProtocolError("Remote compaction stream ended without response.completed");
  }
  if (items.size !== 1) {
    throw new CodexCompactionProtocolError(
      `Remote compaction returned ${items.size} distinct compaction items; expected exactly one`,
    );
  }
  return { item: [...items.values()][0], completedResponse };
}

export interface CodexRemoteV2AdapterOptions {

  readonly fetch?: typeof globalThis.fetch;

  readonly rejection?: RejectedRoutes;
}

export function createRemoteV2CompactionAdapter(
  options: CodexRemoteV2AdapterOptions = {},
): CodexRemoteCompactionAdapter {
  const rejection = options.rejection ?? new RejectedRoutes();
  return async function remoteV2CompactionAdapter(
    request: CodexRemoteCompactionRequest,
  ): Promise<CodexRemoteCompactionResponse> {
    if (request.signal.aborted) throw abortError();

    const remoteController = new AbortController();
    const remoteSignal = AbortSignal.any([request.signal, remoteController.signal]);

    const routeIdentity = {
      provider: request.model.provider,
      modelId: request.model.id,
      api: request.model.api,
      profile: request.profile,
      protocol: request.protocol,
      ...(request.model.baseUrl === undefined ? {} : { baseUrl: request.model.baseUrl }),
    };
    const publicRouteKey = codexRejectionRouteKey(routeIdentity);
    let routeKey = publicRouteKey;
    let paused = false;
    let remoteAttempted = false;
    let rejectionError: CodexOAuthRejectionError | undefined;

    const recordRejection = (error: CodexOAuthRejectionError): void => {

      if (!remoteAttempted || rejectionError) return;
      rejectionError = error;
      rejection.add(routeKey);
      rejection.observe(publicRouteKey, routeKey);

      queueMicrotask(() => remoteController.abort());
    };

    const baseFetch = request.fetch ?? options.fetch ?? globalThis.fetch;
    const inspections: Promise<{ ok: true; value: CollectedCompaction } | { ok: false; error: unknown }>[] = [];
    const inspectedFetch: typeof globalThis.fetch = async (input, init) => {
      const endpoint = input instanceof Request ? input.url : String(input);
      routeKey = codexRejectionRouteKey({ ...routeIdentity, endpoint });
      rejection.observe(publicRouteKey, routeKey);
      if (rejection.has(routeKey)) {

        paused = true;
        remoteController.abort();
        return Response.json(
          { error: { message: "Remote compaction route is paused after an OAuth operation rejection" } },
          { status: 409, headers: { "x-should-retry": "false" } },
        );
      }
      remoteAttempted = true;
      const response = await baseFetch(input, init);
      const requestSignal = AbortSignal.any([
        remoteSignal,
        ...(init?.signal ? [init.signal] : []),
        ...(input instanceof Request ? [input.signal] : []),
      ]);
      const failure = await inspectFailureResponse(response, requestSignal);
      if (failure.rejection) recordRejection(failure.rejection);
      if (!failure.response.ok || !failure.response.body) return failure.response;
      const observed = observeSseRejections(failure.response, requestSignal, recordRejection);
      if (!observed.body) return observed;

      const [providerBody, inspectionBody] = observed.body.tee();
      inspections.push(
        collectCompactionSse(inspectionBody, { signal: remoteSignal }).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
      );
      return new Response(providerBody, {
        status: observed.status,
        statusText: observed.statusText,
        headers: observed.headers,
      });
    };

    let sentInput: ReturnType<typeof assertPreparedInput> | undefined;
    const stream = request.provider.stream(
      request.model,
      providerTranscriptContext(request.context),
      {
        ...(request.apiKey === undefined ? {} : { apiKey: request.apiKey }),
        ...(request.headers === undefined ? {} : { headers: request.headers }),
        ...(request.env === undefined ? {} : { env: request.env }),
        signal: remoteSignal,
        transport: "sse",
        cacheRetention: "none",
        timeoutMs: request.requestTimeoutMs ?? 5 * 60 * 1000,
        maxRetries: request.maxRetries ?? 2,
        fetch: inspectedFetch,
        onPayload: (payload: unknown) => {
          const prepared = prepareRemoteCompactionPayload(payload, request.priorCheckpoint);

          sentInput = assertPreparedInput(prepared).slice(0, -1);
          return prepared;
        },
      },
    );

    try {
      const usage = await collectProviderUsage(stream, remoteSignal);
      if (rejectionError) throw rejectionError;
      if (!sentInput) {
        throw new CodexCompactionProtocolError("Provider did not expose a request payload");
      }
      if (inspections.length !== 1) {
        throw new CodexCompactionProtocolError(
          `Provider exposed ${inspections.length} successful SSE responses; expected exactly one`,
        );
      }
      const inspection = await inspections[0];
      if (request.signal.aborted) throw abortError();
      if (!inspection.ok) throw inspection.error;
      return { item: inspection.value.item, promptInput: sentInput, usage };
    } catch (error) {
      if (paused) {
        throw new CodexRoutePausedError(
          `Remote compaction route is paused after an OAuth operation rejection (${routeIdentity.provider}/${routeIdentity.modelId})`,
        );
      }
      if (rejectionError) throw rejectionError;
      throw error;
    } finally {

      remoteController.abort();
    }
  };
}
