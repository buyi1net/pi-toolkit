// Codex 远程压缩的失败观察与 OAuth 拒绝识别（工单 05 从上游 compaction-failure.ts 提取）。
//
// 上游对应：reference/Pi生态/pi-codex-compact/source/src/compaction-failure.ts
// （MIT，来源登记见 ../UPSTREAM.md）。提取范围：OAuth 操作拒绝的识别
// （isOAuthOperationRejection / streamOperationRejection）、失败响应与 SSE 数据帧
// 的有界观察（inspectFailureResponse / observeSseRejections）。工单 04 文档预留的
// 本单提取即此；上游的 compactionFailureMessage / redactRequestValues / terminalText
// 属 owner 侧通知措辞与终端清洗，owner 的通知文案由本仓三语键表承担（messages/），
// 值脱敏随 owner 侧 auth 值跟踪另行处理，不在本文件。
//
// 识别口径（上游同款）：只有错误体里出现精确的
// code=hardened_oauth_rule_missing + type=rejected_by_hardened_oauth_boundary
// 配对才算 OAuth 操作拒绝；诊断文本里「提到」这两个词不算证据。
//
// 适配点：上游对 SSE 事件的观察走 pi-ai 的 onProviderStreamEvent 回调（Pi 1.3.0 有
// 该选项，但适配器支持是显式声明的，且要在提供方接线）；本仓不走该回调，观察统一
// 落在 fetch 边界（inspectFailureResponse 看失败响应体，observeSseRejections
// 透传字节的同时解析完整数据帧）——对 provider 适配器零要求。

import { abortError, MAX_SSE_BYTES } from "./remote-shared.ts";
import { isJsonObject } from "./protocol.ts";

/** 错误类：压缩请求因路由暂停（本会话此前观察到 OAuth 操作拒绝）未发出 */
export class CodexRoutePausedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexRoutePausedError";
  }
}

/** 错误类：远端在本次请求中观察到 OAuth 操作拒绝（路由随后进入暂停） */
export class CodexOAuthRejectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexOAuthRejectionError";
  }
}

/**
 * provider 适配器把 HTTP 错误格式化成友好文案时可能丢掉结构化字段：在格式化
 * 之前有界地读完失败响应体（64 KiB），重建 Response 给调用方继续用，同时识别
 * OAuth 操作拒绝。
 */
export async function inspectFailureResponse(
  response: Response,
  signal: AbortSignal,
): Promise<{ response: Response; rejection?: CodexOAuthRejectionError }> {
  if (response.ok || !response.body) return { response };
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let complete = false;
  try {
    for (;;) {
      if (signal.aborted) throw abortError();
      const part = await reader.read();
      if (signal.aborted) throw abortError();
      if (part.done) {
        complete = true;
        break;
      }
      bytes += part.value.byteLength;
      if (bytes > 64 * 1024) throw new Error("Compaction error response exceeded 64 KiB");
      chunks.push(part.value);
    }
    const body = Buffer.concat(chunks);
    const message = body.toString("utf8");
    return {
      response: new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }),
      rejection: isOAuthOperationRejection(message) ? new CodexOAuthRejectionError(message) : undefined,
    };
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!complete) cancel();
    reader.releaseLock();
  }
}

/** SSE 数据帧级别的事件错误识别（response.failed 等携带 error 的帧） */
export function streamOperationRejection(raw: unknown): CodexOAuthRejectionError | undefined {
  if (!isJsonObject(raw)) return undefined;
  const error =
    raw.error ?? (raw.type === "response.failed" && isJsonObject(raw.response) ? raw.response.error : undefined);
  if (error === undefined) return undefined;
  const message = JSON.stringify(error);
  return isOAuthOperationRejection(message) ? new CodexOAuthRejectionError(message) : undefined;
}

/**
 * 透传 SSE 字节流的同时观察完整数据帧（≤64 KiB）里的 OAuth 操作拒绝：OpenAI 的
 * SDK 可能在 Pi 事件回调之前对顶层 SSE 错误抛错，所以观察必须发生在字节层。
 * 返回的新 Response 供 provider 适配器继续消费，字节内容不变。
 */
export function observeSseRejections(
  response: Response,
  signal: AbortSignal,
  observe: (error: CodexOAuthRejectionError) => void,
): Response {
  if (!response.ok || !response.body) return response;
  const decoder = new TextDecoder();
  let pending = "";
  let bytes = 0;
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, destination) {
        bytes += chunk.byteLength;
        if (bytes > MAX_SSE_BYTES) throw new Error("Compaction error inspection stream exceeded the size limit");
        pending += decoder.decode(chunk, { stream: true });
        for (;;) {
          const boundary = /\r?\n\r?\n/.exec(pending);
          if (!boundary) break;
          const frame = pending.slice(0, boundary.index);
          pending = pending.slice(boundary.index + boundary[0].length);
          if (Buffer.byteLength(frame) > 64 * 1024) continue;
          const data = frame
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          let raw: unknown;
          try {
            raw = JSON.parse(data);
          } catch {
            continue;
          }
          const rejection = streamOperationRejection(raw);
          if (rejection) observe(rejection);
        }
        destination.enqueue(chunk);
      },
    }),
    { signal },
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * OAuth 操作拒绝的精确识别：错误体（或含 error 字段的对象）里出现精确的
 * code/type 配对才算。Pi 适配器暴露的是格式化字符串，所以从第一个 "{" 起尝试
 * 解析 JSON。
 */
export function isOAuthOperationRejection(errorValue: unknown): boolean {
  const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
  const start = message.indexOf("{");
  if (start < 0) return false;
  try {
    const body: unknown = JSON.parse(message.slice(start));
    if (!isJsonObject(body)) return false;
    const error = isJsonObject(body.error) ? body.error : body;
    return (
      isJsonObject(error) &&
      error.code === "hardened_oauth_rule_missing" &&
      error.type === "rejected_by_hardened_oauth_boundary"
    );
  } catch {
    return false;
  }
}
