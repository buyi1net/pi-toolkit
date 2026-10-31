import { abortError, MAX_SSE_BYTES } from "./remote-shared.ts";
import { isJsonObject } from "./protocol.ts";

export class CodexRoutePausedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexRoutePausedError";
  }
}

export class CodexOAuthRejectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexOAuthRejectionError";
  }
}

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

export function streamOperationRejection(raw: unknown): CodexOAuthRejectionError | undefined {
  if (!isJsonObject(raw)) return undefined;
  const error =
    raw.error ?? (raw.type === "response.failed" && isJsonObject(raw.response) ? raw.response.error : undefined);
  if (error === undefined) return undefined;
  const message = JSON.stringify(error);
  return isOAuthOperationRejection(message) ? new CodexOAuthRejectionError(message) : undefined;
}

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
