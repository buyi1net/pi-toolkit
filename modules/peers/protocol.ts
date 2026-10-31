import { Buffer } from "node:buffer";
import type { PeersSettings } from "./api.ts";

export const PEERS_PROTOCOL_VERSION = 1;

export type PeersReasonCode =
  | "offline"
  | "connect-timeout"
  | "write-timeout"
  | "protocol-version"
  | "invalid-frame"
  | "source-unregistered"
  | "source-expired"
  | "self-delivery"
  | "rejected"
  | "queue-full"
  | "rate-limited"
  | "content-too-large"
  | "ambiguous-address"
  | "unknown-target"
  | "duplicate-message";

export const PEERS_REASON_CODES: readonly PeersReasonCode[] = Object.freeze([
  "offline",
  "connect-timeout",
  "write-timeout",
  "protocol-version",
  "invalid-frame",
  "source-unregistered",
  "source-expired",
  "self-delivery",
  "rejected",
  "queue-full",
  "rate-limited",
  "content-too-large",
  "ambiguous-address",
  "unknown-target",
  "duplicate-message",
]);

export function isPeersReasonCode(value: unknown): value is PeersReasonCode {
  return typeof value === "string" && (PEERS_REASON_CODES as readonly string[]).includes(value);
}

export interface PeersFileRef {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface PeersRequestFrame {
  readonly type: "request";
  readonly protocolVersion: number;
  readonly messageId: string;
  readonly replyTo: string | null;
  readonly sessionId: string;
  readonly instanceId: string;
  readonly name: string | null;
  readonly cwd: string | null;
  readonly body: string;
  readonly file: PeersFileRef | null;
  readonly sentAt: number;
}

export type PeersDeliveryResult = "accepted" | "rejected" | "error";

export interface PeersResponseFrame {
  readonly type: "response";
  readonly protocolVersion: number;
  readonly messageId: string;
  readonly result: PeersDeliveryResult;
  readonly reason: PeersReasonCode | null;
  readonly serverTime: number;
}

export type PeersFrame = PeersRequestFrame | PeersResponseFrame;

const LENGTH_PREFIX_BYTES = 4;

export type PeersEncodeResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | {
      readonly ok: false;
      readonly reason: "content-too-large";
      readonly payloadBytes: number;
      readonly maxFrameBytes: number;
    };

export function encodePeersFrame(
  frame: PeersFrame,
  limits: { readonly maxFrameBytes: number },
): PeersEncodeResult {
  const payload = Buffer.from(JSON.stringify(frame), "utf8");
  if (payload.length > limits.maxFrameBytes) {
    return { ok: false, reason: "content-too-large", payloadBytes: payload.length, maxFrameBytes: limits.maxFrameBytes };
  }
  const bytes = Buffer.alloc(LENGTH_PREFIX_BYTES + payload.length);
  bytes.writeUInt32BE(payload.length, 0);
  payload.copy(bytes, LENGTH_PREFIX_BYTES);
  return { ok: true, bytes };
}

export type PeersDecodeEvent =
  | { readonly kind: "frame"; readonly frame: PeersFrame }
  | {
      readonly kind: "rejected";
      readonly reason: Extract<PeersReasonCode, "invalid-frame" | "protocol-version" | "content-too-large">;
      readonly detail: string;

      readonly fatal: boolean;
    };

export interface PeersFrameDecoder {

  push(chunk: Uint8Array): readonly PeersDecodeEvent[];

  end(): readonly PeersDecodeEvent[];

  reset(): void;
}

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

interface PeersPayloadIssue {
  readonly reason: "invalid-frame" | "protocol-version";
  readonly detail: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireText(value: unknown, field: string): string | PeersPayloadIssue {
  return typeof value === "string" && value !== "" ? value : { reason: "invalid-frame", detail: `${field} 必须是非空字符串` };
}

function optionalText(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value === "string") return value;
  return undefined;
}

function optionalReplyTo(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value !== "") return value.trim() === "" ? null : value;
  return undefined;
}

function requireFiniteNumber(value: unknown, field: string): number | PeersPayloadIssue {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : { reason: "invalid-frame", detail: `${field} 必须是有限数字` };
}

function validateFileRef(value: unknown): PeersFileRef | PeersPayloadIssue {
  if (!isPlainObject(value)) return { reason: "invalid-frame", detail: "file 必须是对象或 null" };
  const path = requireText(value.path, "file.path");
  if (typeof path !== "string") return path;
  if (typeof value.bytes !== "number" || !Number.isInteger(value.bytes) || value.bytes < 0) {
    return { reason: "invalid-frame", detail: "file.bytes 必须是非负整数" };
  }
  if (typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256)) {
    return { reason: "invalid-frame", detail: "file.sha256 必须是 64 位小写十六进制" };
  }
  return { path, bytes: value.bytes, sha256: value.sha256 };
}

function validateRequest(raw: Record<string, unknown>): PeersRequestFrame | PeersPayloadIssue {
  const messageId = requireText(raw.messageId, "messageId");
  if (typeof messageId !== "string") return messageId;
  const replyTo = optionalReplyTo(raw.replyTo);
  if (replyTo === undefined) return { reason: "invalid-frame", detail: "replyTo 必须是 null 或非空字符串" };
  const sessionId = requireText(raw.sessionId, "sessionId");
  if (typeof sessionId !== "string") return sessionId;
  const instanceId = requireText(raw.instanceId, "instanceId");
  if (typeof instanceId !== "string") return instanceId;
  const name = optionalText(raw.name);
  if (name === undefined) return { reason: "invalid-frame", detail: "name 必须是字符串或 null" };
  const cwd = optionalText(raw.cwd);
  if (cwd === undefined) return { reason: "invalid-frame", detail: "cwd 必须是字符串或 null" };
  if (typeof raw.body !== "string") return { reason: "invalid-frame", detail: "body 必须是字符串" };
  let file: PeersFileRef | null = null;
  if (raw.file !== null) {
    const ref = validateFileRef(raw.file);
    if ("reason" in ref) return ref;
    file = ref;
  }
  const sentAt = requireFiniteNumber(raw.sentAt, "sentAt");
  if (typeof sentAt !== "number") return sentAt;
  return {
    type: "request",
    protocolVersion: PEERS_PROTOCOL_VERSION,
    messageId,
    replyTo,
    sessionId,
    instanceId,
    name,
    cwd,
    body: raw.body,
    file,
    sentAt,
  };
}

function validateResponse(raw: Record<string, unknown>): PeersResponseFrame | PeersPayloadIssue {
  const messageId = requireText(raw.messageId, "messageId");
  if (typeof messageId !== "string") return messageId;
  if (raw.result !== "accepted" && raw.result !== "rejected" && raw.result !== "error") {
    return { reason: "invalid-frame", detail: "result 必须是 accepted / rejected / error" };
  }

  let reason: PeersReasonCode | null = null;
  if (raw.result === "accepted") {
    if (raw.reason === "duplicate-message") {
      reason = raw.reason;
    } else if (raw.reason !== null) {
      return { reason: "invalid-frame", detail: "accepted 结果只允许携带 duplicate-message（幂等命中）" };
    }
  } else {
    if (!isPeersReasonCode(raw.reason)) {
      return { reason: "invalid-frame", detail: `${raw.result} 结果必须携带枚举内原因码` };
    }
    reason = raw.reason;
  }
  const serverTime = requireFiniteNumber(raw.serverTime, "serverTime");
  if (typeof serverTime !== "number") return serverTime;
  return {
    type: "response",
    protocolVersion: PEERS_PROTOCOL_VERSION,
    messageId,
    result: raw.result,
    reason,
    serverTime,
  };
}

function validateFramePayload(value: unknown): PeersFrame | PeersPayloadIssue {
  if (!isPlainObject(value)) return { reason: "invalid-frame", detail: "负载不是 JSON 对象" };
  if (typeof value.protocolVersion !== "number" || !Number.isInteger(value.protocolVersion)) {
    return { reason: "invalid-frame", detail: "缺少或非法的协议版本" };
  }
  if (value.protocolVersion !== PEERS_PROTOCOL_VERSION) {
    return {
      reason: "protocol-version",
      detail: `协议版本 ${value.protocolVersion} 不符（本端 ${PEERS_PROTOCOL_VERSION}）`,
    };
  }
  if (value.type === "request") return validateRequest(value);
  if (value.type === "response") return validateResponse(value);
  return { reason: "invalid-frame", detail: "未知帧类型" };
}

export function createPeersFrameDecoder(limits: { readonly maxFrameBytes: number }): PeersFrameDecoder {
  let buffer = Buffer.alloc(0);
  let fatal = false;

  const decodePayload = (payload: Buffer): PeersDecodeEvent | null => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(UTF8_DECODER.decode(payload));
    } catch (error) {
      return {
        kind: "rejected",
        reason: "invalid-frame",
        detail: `负载不是合法 UTF-8 JSON：${error instanceof Error ? error.message : String(error)}`,
        fatal: false,
      };
    }
    const validated = validateFramePayload(parsed);

    if (!("type" in validated)) {
      return { kind: "rejected", reason: validated.reason, detail: validated.detail, fatal: false };
    }
    return { kind: "frame", frame: validated };
  };

  const drain = (out: PeersDecodeEvent[]): void => {
    while (!fatal && buffer.length >= LENGTH_PREFIX_BYTES) {
      const declared = buffer.readUInt32BE(0);
      if (declared > limits.maxFrameBytes) {
        fatal = true;
        out.push({
          kind: "rejected",
          reason: "content-too-large",
          detail: `声明负载 ${declared} 字节超过单帧上限 ${limits.maxFrameBytes} 字节`,
          fatal: true,
        });
        return;
      }
      if (buffer.length < LENGTH_PREFIX_BYTES + declared) return;
      const payload = buffer.subarray(LENGTH_PREFIX_BYTES, LENGTH_PREFIX_BYTES + declared);
      buffer = buffer.subarray(LENGTH_PREFIX_BYTES + declared);
      const event = decodePayload(payload);
      if (event) out.push(event);
    }
  };

  return {
    push(chunk: Uint8Array): readonly PeersDecodeEvent[] {
      if (fatal) return [];
      buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, Buffer.from(chunk)]);
      const out: PeersDecodeEvent[] = [];
      drain(out);
      return out;
    },

    end(): readonly PeersDecodeEvent[] {
      if (fatal || buffer.length === 0) return [];
      const detail =
        buffer.length < LENGTH_PREFIX_BYTES
          ? `流截断于长度前缀中途（残留 ${buffer.length} 字节）`
          : `流截断于帧负载中途（声明 ${buffer.readUInt32BE(0)} 字节，实收 ${buffer.length - LENGTH_PREFIX_BYTES} 字节）`;
      buffer = Buffer.alloc(0);
      fatal = true;
      return [{ kind: "rejected", reason: "invalid-frame", detail, fatal: true }];
    },

    reset(): void {
      buffer = Buffer.alloc(0);
      fatal = false;
    },
  };
}

export interface PeersTransportConnection {

  write(data: Uint8Array): Promise<void>;

  onData(listener: (chunk: Uint8Array) => void): void;

  onClose(listener: () => void): void;
  close(): void;
}

export interface PeersTransport {
  connect(endpoint: string): Promise<PeersTransportConnection>;
}

export interface PeersTimeoutTimer {
  clear(): void;
}

export type PeersTimeoutScheduler = (callback: () => void, delayMs: number) => PeersTimeoutTimer;

export function defaultPeersTimeoutScheduler(callback: () => void, delayMs: number): PeersTimeoutTimer {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return {
    clear() {
      clearTimeout(timer);
    },
  };
}

export interface PeersSendOptions {
  readonly settings: Pick<PeersSettings, "maxFrameBytes" | "connectTimeoutMs" | "writeTimeoutMs">;
  readonly scheduleTimeout?: PeersTimeoutScheduler;

  readonly now?: () => number;
}

export type PeersSendStage = "connect" | "write" | "response" | null;

export type PeersSendOutcome =
  | { readonly kind: "response"; readonly response: PeersResponseFrame }
  | {
      readonly kind: "failure";
      readonly stage: PeersSendStage;
      readonly reason: PeersReasonCode;
      readonly detail: string;
    };

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type RaceOutcome<T> =
  | { readonly kind: "value"; readonly value: T }
  | { readonly kind: "error"; readonly error: unknown }
  | { readonly kind: "timeout" };

function raceTimeout<T>(
  promise: Promise<T>,
  delayMs: number,
  schedule: PeersTimeoutScheduler,
): Promise<RaceOutcome<T>> {
  return new Promise<RaceOutcome<T>>((resolve) => {
    const timer = schedule(() => resolve({ kind: "timeout" }), delayMs);
    promise.then(
      (value) => {
        timer.clear();
        resolve({ kind: "value", value });
      },
      (error) => {
        timer.clear();
        resolve({ kind: "error", error });
      },
    );
  });
}

function safeClose(connection: PeersTransportConnection): void {
  try {
    connection.close();
  } catch {
    // 关闭尽力而为：不因对端已先关闭而把成功投递改判为失败
  }
}

export async function sendPeersFrame(
  transport: PeersTransport,
  endpoint: string,
  frame: PeersFrame,
  options: PeersSendOptions,
): Promise<PeersSendOutcome> {
  const schedule = options.scheduleTimeout ?? defaultPeersTimeoutScheduler;
  const now = options.now ?? Date.now;
  const { maxFrameBytes, connectTimeoutMs, writeTimeoutMs } = options.settings;

  const encoded = encodePeersFrame(frame, { maxFrameBytes });
  if (!encoded.ok) {
    return {
      kind: "failure",
      stage: null,
      reason: "content-too-large",
      detail: `帧负载 ${encoded.payloadBytes} 字节超过单帧上限 ${encoded.maxFrameBytes} 字节`,
    };
  }

  const connectPromise = transport.connect(endpoint);
  const connectOutcome = await raceTimeout(connectPromise, connectTimeoutMs, schedule);
  if (connectOutcome.kind === "timeout") {

    connectPromise.then(
      (late) => safeClose(late),
      () => {},
    );
    return { kind: "failure", stage: "connect", reason: "connect-timeout", detail: `连接 ${connectTimeoutMs}ms 内未建立` };
  }
  if (connectOutcome.kind === "error") {
    return { kind: "failure", stage: "connect", reason: "offline", detail: `连接失败：${describeError(connectOutcome.error)}` };
  }
  const connection = connectOutcome.value;

  const decoder = createPeersFrameDecoder({ maxFrameBytes });
  const events: PeersDecodeEvent[] = [];
  const waiters: Array<() => void> = [];
  let closed = false;
  const wake = (): void => {
    const pending = waiters.splice(0, waiters.length);
    for (const resolve of pending) resolve();
  };
  connection.onData((chunk) => {
    events.push(...decoder.push(chunk));
    wake();
  });
  connection.onClose(() => {
    closed = true;
    wake();
  });

  const writePromise = connection.write(encoded.bytes);
  const writeOutcome = await raceTimeout(writePromise, writeTimeoutMs, schedule);
  if (writeOutcome.kind === "timeout") {
    writePromise.catch(() => {});
    safeClose(connection);
    return { kind: "failure", stage: "write", reason: "write-timeout", detail: `写入 ${writeTimeoutMs}ms 内未完成` };
  }
  if (writeOutcome.kind === "error") {
    safeClose(connection);
    return { kind: "failure", stage: "write", reason: "offline", detail: `写入失败：${describeError(writeOutcome.error)}` };
  }

  const responseDeadline = now() + writeTimeoutMs;
  const responseTimeoutFailure = (): PeersSendOutcome => {
    safeClose(connection);
    return {
      kind: "failure",
      stage: "response",
      reason: "write-timeout",
      detail: `响应在 ${writeTimeoutMs}ms 内未到达（沿用写入超时预算，绝对截止）`,
    };
  };
  for (;;) {
    const event = events.shift();
    if (event) {
      safeClose(connection);
      if (event.kind === "frame") {
        if (event.frame.type !== "response") {
          return { kind: "failure", stage: "response", reason: "invalid-frame", detail: "响应通道收到请求帧" };
        }
        if (event.frame.messageId !== frame.messageId) {
          return { kind: "failure", stage: "response", reason: "invalid-frame", detail: "响应消息 id 与请求不匹配" };
        }
        return { kind: "response", response: event.frame };
      }
      return { kind: "failure", stage: "response", reason: event.reason, detail: event.detail };
    }
    if (closed) {
      return { kind: "failure", stage: "response", reason: "offline", detail: "连接在响应到达前关闭" };
    }
    const remaining = responseDeadline - now();
    if (remaining <= 0) return responseTimeoutFailure();
    const nextSignal = new Promise<void>((resolve) => {
      waiters.push(resolve);
    });
    const signalOutcome = await raceTimeout(nextSignal, remaining, schedule);
    if (signalOutcome.kind === "timeout") return responseTimeoutFailure();
  }
}
