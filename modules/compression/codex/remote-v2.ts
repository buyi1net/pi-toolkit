// Codex Remote V2 协议适配器（工单 05）：经 provider 的 Responses SSE 流完成远程压缩。
//
// 上游对应：reference/Pi生态/pi-codex-compact/source/src/remote-v2.ts，以及上游
// protocol.ts 的 SSE 收集（collectCompactionSse）与 codex-compact.ts 的 fetch 边界
// 拒绝观察（MIT，来源登记见 ../UPSTREAM.md）。本仓把上游两层的职责折进一个
// 可注入的 adapter（04 的 remote.ts 接缝）：
// - 请求构造：走 provider.stream（Responses input 由 provider 适配器生成），经
//   onPayload 把 payload 按 priorCheckpoint 展开 marker 并追加恰好一个
//   compaction_trigger（复用 04 protocol.ts 的 prepareRemoteCompactionPayload）；
// - 响应收集：fetch 边界 tee 响应体，一条支路给 provider 消费，一条支路跑
//   collectCompactionSse——要求 response.completed 终止且「恰好一个」distinct 的
//   合法 compaction item（工单验收 2 / 规格「Codex 契约」）；usage 取自 provider
//   事件流的 done 消息；
// - 失败分类：SSE 形状 / item 数量 / 尺寸超限抛 CodexCompactionProtocolError，
//   provider 错误抛普通 Error，取消抛 AbortError；OAuth 操作拒绝（上游
//   hardened OAuth 边界的精确 code/type 配对）在 fetch 边界观察并记录进
//   rejection-state，同路由后续请求在发出前被暂停（合成 409 + 中止子请求），
//   上游同款语义；
// - 适配点：上游用 pi-ai 的 onProviderStreamEvent 观察流事件；本仓依赖版本没有
//   该回调，观察统一落在 fetch 边界（compaction-failure.ts），对 provider 适配器
//   零要求。
//
// 装配：mod.ts 经 createRemoteV2CompactionAdapter 创建并填进 createCodexOwnerModule
// 的 protocolAdapters["remote-v2"]（协调者接线；本文件不 import mod.ts）。

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

/**
 * 收集 Responses SSE 流里的 compaction item（上游 protocol.ts 同款算法）：
 * - 数据帧按空行分界，多行 data 拼接；[DONE] 跳过；非 JSON 抛协议错误；
 * - response.output_item.done 的 item 与 response.completed 的 output 都算候选，
 *   合法 item 按 JSON 序列化去重（同一 item 重复出现只计一次）；
 * - 流必须以 response.completed 终止，且恰好收集到一个 distinct 的合法 item——
 *   「恰好一个」是本协议的核心验收（普通 assistant output = 0 个、多个 compaction
 *   item = 多于一个，都抛协议错误）；
 * - 尺寸预算：整个流 MAX_SSE_BYTES，单项 MAX_COMPACTION_ITEM_BYTES（validate 内置）。
 */
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

/** 适配器工厂的可注入项（mod.ts 装配 / 测试注入 fake relay） */
export interface CodexRemoteV2AdapterOptions {
  /** 传输接缝：缺省用请求自带 fetch（owner 注入）再退 globalThis.fetch */
  readonly fetch?: typeof globalThis.fetch;
  /** 拒绝路由状态：缺省随工厂创建一份（模块实例生命周期） */
  readonly rejection?: RejectedRoutes;
}

/**
 * 建 Remote V2 协议适配器（protocol "remote-v2"）。返回的函数满足 04 remote.ts
 * 的 CodexRemoteCompactionAdapter 接缝：owner 组装请求（含 priorCheckpoint 投影
 * 后的上下文），适配器负责远端收集、校验与失败分类。
 */
export function createRemoteV2CompactionAdapter(
  options: CodexRemoteV2AdapterOptions = {},
): CodexRemoteCompactionAdapter {
  const rejection = options.rejection ?? new RejectedRoutes();
  return async function remoteV2CompactionAdapter(
    request: CodexRemoteCompactionRequest,
  ): Promise<CodexRemoteCompactionResponse> {
    if (request.signal.aborted) throw abortError();

    // 远端子请求的独立控制器：OAuth 拒绝后只中止本次远端请求（连同适配器层重试），
    // 不动父压缩信号——owner 侧的取消语义保持不变。
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
      // 只记录真实发出去的请求观察到的拒绝；同一次压缩只记第一个。
      if (!remoteAttempted || rejectionError) return;
      rejectionError = error;
      rejection.add(routeKey);
      rejection.observe(publicRouteKey, routeKey);
      // 流回调可能发生在 TransformStream 内部：回到微任务再中止，避免重入式流拆除。
      queueMicrotask(() => remoteController.abort());
    };

    const baseFetch = request.fetch ?? options.fetch ?? globalThis.fetch;
    const inspections: Promise<{ ok: true; value: CollectedCompaction } | { ok: false; error: unknown }>[] = [];
    const inspectedFetch: typeof globalThis.fetch = async (input, init) => {
      const endpoint = input instanceof Request ? input.url : String(input);
      routeKey = codexRejectionRouteKey({ ...routeIdentity, endpoint });
      rejection.observe(publicRouteKey, routeKey);
      if (rejection.has(routeKey)) {
        // 该路由在本会话中已观察到 OAuth 操作拒绝：不发网络请求，用合成 409
        // 让 provider 适配器按普通失败格式化（x-should-retry: false 抑制重试）。
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
      // tee：一支给 provider 适配器消费（事件流），一支做 compaction item 收集。
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
          // 记录实际发出的请求视图（去掉末尾追加的 compaction_trigger），
          // 作为 replacement history 的构造来源返回给 owner。
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
      // 释放远端子请求（也兜住自定义 provider 忽略 abort 信号的情况）
      remoteController.abort();
    }
  };
}
