// peers 线协议与帧编解码（工单 37）：跨进程投递的本地线协议 v1 冻结实现。
//
// 线协议契约（规格「通讯·线协议契约」）：
// - 帧 = 4 字节大端长度前缀（负载字节数）+ UTF-8 JSON 负载；协议版本随帧携带；
// - 请求帧字段：协议版本、消息 id、发送方会话 id + 实例 id、发送方名字、发送方 cwd、
//   正文、文件引用（相对路径 + 字节大小 + sha256）、时间戳；
// - 响应帧：三态结果（accepted / rejected / error）+ 原因码 + 服务端时间；
// - 超时：连接与写入各设独立超时；单帧设上限（阈值来自 config.ts 的结构化解析器）；
// - 非法帧 / 未知版本：拒绝并返回协议错误原因码，不崩溃、不挂连接、不误读后续帧。
//
// 本文件是纯逻辑（无真实 OS 端点）：传输走 PeersTransport 接缝，真实命名管道 / 域
// socket 适配器归工单 38；投递判定顺序（来源校验、自投递、拒收、队列/速率）归工单 39/40。

import { Buffer } from "node:buffer";
import type { PeersSettings } from "./api.ts";

/** 线协议版本（v1 冻结）：随每帧携带；不匹配的一律拒绝并返回协议错误原因码 */
export const PEERS_PROTOCOL_VERSION = 1;

/** 原因码（v1 冻结，规格「原因码枚举」）：投递三态中 rejected / error 的机器可读原因 */
export type PeersReasonCode =
  | "offline" // 对方离线
  | "connect-timeout" // 连接超时
  | "write-timeout" // 写入超时
  | "protocol-version" // 协议版本不符
  | "invalid-frame" // 非法帧
  | "source-unregistered" // 来源未登记
  | "source-expired" // 来源过期
  | "self-delivery" // 自投递
  | "rejected" // 被拒收
  | "queue-full" // 队列满
  | "rate-limited" // 速率超限
  | "content-too-large" // 内容超限
  | "ambiguous-address" // 地址多义
  | "unknown-target" // 目标不明
  | "duplicate-message"; // 重复消息

/** 枚举全集（顺序即规格列举顺序）；线上取值按它校验，未知原因码按非法帧拒绝 */
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

/** 文件引用（转文件时的相对路径 + 字节大小 + sha256；sha256 为 64 位小写十六进制）。
 * path 语义：相对 peersSharedDir(agentDir) 的相对路径（不是相对 cwd），线上统一写
 * `files/<name>`；接收端注入前的 containment / 哈希校验在 file-store.ts（工单 40），
 * 线级只校验形状。 */
export interface PeersFileRef {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** 请求帧：一个待投递的消息（发送方身份字段由接收端对账，展示权威值在注册表侧） */
export interface PeersRequestFrame {
  readonly type: "request";
  readonly protocolVersion: number;
  readonly messageId: string;
  readonly sessionId: string;
  readonly instanceId: string;
  readonly name: string | null;
  readonly cwd: string | null;
  readonly body: string;
  readonly file: PeersFileRef | null;
  readonly sentAt: number;
}

/** 响应三态：accepted=端点已接收并进入注入流程；rejected=接收端拒绝；error=协议/端点错误 */
export type PeersDeliveryResult = "accepted" | "rejected" | "error";

/** 响应帧：回执一个请求；messageId 回映请求、serverTime 为服务端处理时刻。
 * accepted 可携带 duplicate-message（规格三处明文的幂等命中回执），其余原因码只随 rejected / error。 */
export interface PeersResponseFrame {
  readonly type: "response";
  readonly protocolVersion: number;
  readonly messageId: string;
  readonly result: PeersDeliveryResult;
  readonly reason: PeersReasonCode | null;
  readonly serverTime: number;
}

export type PeersFrame = PeersRequestFrame | PeersResponseFrame;

/** 长度前缀固定 4 字节（大端 uint32） */
const LENGTH_PREFIX_BYTES = 4;

export type PeersEncodeResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | {
      readonly ok: false;
      readonly reason: "content-too-large";
      readonly payloadBytes: number;
      readonly maxFrameBytes: number;
    };

/**
 * 编码一帧：4 字节大端长度前缀 + UTF-8 JSON 负载。负载字节数超过单帧上限时拒绝
 * （超过内容阈值的内容先转文件，是调用方的责任，见规格「大内容文件契约」）。
 * 帧内容本身不再校验：构造方是模块内代码（信任边界在线上的解码侧）。
 */
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

/** 解码产物：解出一帧，或拒绝一帧（原因码 + 说明） */
export type PeersDecodeEvent =
  | { readonly kind: "frame"; readonly frame: PeersFrame }
  | {
      readonly kind: "rejected";
      readonly reason: Extract<PeersReasonCode, "invalid-frame" | "protocol-version" | "content-too-large">;
      readonly detail: string;
      /** true=流位置已不可知（超长声明 / 截断），后续数据不再解读；false=已按声明长度跳过，可继续 */
      readonly fatal: boolean;
    };

export interface PeersFrameDecoder {
  /** 喂入一段到达字节；返回本次新产生的事件（粘包拆多帧、半包留在内部缓冲） */
  push(chunk: Uint8Array): readonly PeersDecodeEvent[];
  /** 流结束：残留半帧（前缀或负载中途）按截断拒绝；空缓冲无事发生 */
  end(): readonly PeersDecodeEvent[];
  /** 复位（测试与连接重用）；清缓冲与致命状态 */
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

/** 非空字符串校验（消息 id / 会话 id / 实例 id / 文件路径） */
function requireText(value: unknown, field: string): string | PeersPayloadIssue {
  return typeof value === "string" && value !== "" ? value : { reason: "invalid-frame", detail: `${field} 必须是非空字符串` };
}

/** string | null 校验（发送方名字 / cwd 可空，但不得是其它类型）；undefined=非法 */
function optionalText(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value === "string") return value;
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
  // 三态与原因码一致性（规格「限流与防护」）：幂等命中（消息 id 去重窗口命中）的回执是
  // accepted + duplicate-message——发送方按已投递处理，不得误判为协议错误而换 id 重发；
  // 其余 accepted 组合不带原因码；rejected / error 必须带枚举内原因码
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

/** 严格校验一帧负载：协议版本先查（未知版本即使其余字段也坏也按版本不符报），再查结构 */
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

/**
 * 建立增量帧解码器：按 4 字节大端前缀切帧，粘包拆多帧、半包留缓冲。
 * 拒绝语义（不崩溃、不挂连接、不误读后续帧）：
 * - 声明长度超单帧上限：立即拒绝（不等负载字节到达，不缓冲），fatal——流位置不可知；
 * - 负载非法（非 UTF-8 / 非 JSON / 结构不符 / 未知版本）：按声明长度跳过后继续解下一帧；
 * - 流结束时残留半帧：end() 按截断拒绝（fatal）。
 */
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
    // 帧负载带 type 字段；问题对象带 reason/detail（响应帧也有 reason 字段，不能拿它判别）
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
      if (buffer.length < LENGTH_PREFIX_BYTES + declared) return; // 半包：留缓冲等后续
      const payload = buffer.subarray(LENGTH_PREFIX_BYTES, LENGTH_PREFIX_BYTES + declared);
      buffer = buffer.subarray(LENGTH_PREFIX_BYTES + declared);
      const event = decodePayload(payload);
      if (event) out.push(event);
    }
  };

  return {
    push(chunk: Uint8Array): readonly PeersDecodeEvent[] {
      if (fatal) return []; // 流位置不可知，后续数据一律不解读（防误读）
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

/** 传输连接接缝（工单 38 提供真实实现：Windows 命名管道 / Unix 域 socket） */
export interface PeersTransportConnection {
  /** 写入一段帧字节；成功 resolve、失败 reject；长期不 settle 由调用方的写入超时兜底 */
  write(data: Uint8Array): Promise<void>;
  /** 注册数据到达监听（单监听者，发送侧等响应帧期间挂上） */
  onData(listener: (chunk: Uint8Array) => void): void;
  /** 注册连接关闭监听 */
  onClose(listener: () => void): void;
  close(): void;
}

/** 传输接缝：按端点地址建立一条连接（端点地址来自会话注册表的 endpoint 字段） */
export interface PeersTransport {
  connect(endpoint: string): Promise<PeersTransportConnection>;
}

/** 超时定时器接缝（默认 setTimeout + unref；测试注入假调度器手动触发） */
export interface PeersTimeoutTimer {
  clear(): void;
}

export type PeersTimeoutScheduler = (callback: () => void, delayMs: number) => PeersTimeoutTimer;

export function defaultPeersTimeoutScheduler(callback: () => void, delayMs: number): PeersTimeoutTimer {
  const timer = setTimeout(callback, delayMs);
  timer.unref(); // 挂起的超时不阻止进程退出
  return {
    clear() {
      clearTimeout(timer);
    },
  };
}

export interface PeersSendOptions {
  readonly settings: Pick<PeersSettings, "maxFrameBytes" | "connectTimeoutMs" | "writeTimeoutMs">;
  readonly scheduleTimeout?: PeersTimeoutScheduler;
  /** 时钟接缝（响应截止时间计算）；默认 Date.now */
  readonly now?: () => number;
}

/** 发送结果：对端回执的响应帧，或本端判定的失败（原因码 + 说明） */
export type PeersSendOutcome =
  | { readonly kind: "response"; readonly response: PeersResponseFrame }
  | { readonly kind: "failure"; readonly reason: PeersReasonCode; readonly detail: string };

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type RaceOutcome<T> =
  | { readonly kind: "value"; readonly value: T }
  | { readonly kind: "error"; readonly error: unknown }
  | { readonly kind: "timeout" };

/** 竞速一个可能永不 settle 的 Promise；无论哪种结局都清掉超时定时器 */
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

/**
 * 发送一帧并等待对端响应（一连接一请求一响应，用完即关）。
 * 语义（阈值均来自结构化配置）：
 * - 编码超单帧上限 → 失败 content-too-large（不碰传输）；
 * - 连接在 connectTimeoutMs 内未建立 → 失败 connect-timeout（迟到建立的连接立即关闭）；
 * - 连接被拒 → 失败 offline（对方端点不存在/不可达）；
 * - 写入在 writeTimeoutMs 内未完成 / 失败 → 失败 write-timeout / offline；
 * - 响应帧非法（未知版本、非 JSON、消息 id 不匹配、收到请求帧）→ 失败对应原因码；
 * - 响应等待沿用写入超时预算（规格只设连接/写入两个超时），但为绝对截止时间：
 *   进入响应等待时一次算定，逐字节滴流不能续期，到点即 write-timeout；
 * - 连接在响应到达前关闭 → 失败 offline。
 */
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
      reason: "content-too-large",
      detail: `帧负载 ${encoded.payloadBytes} 字节超过单帧上限 ${encoded.maxFrameBytes} 字节`,
    };
  }

  const connectPromise = transport.connect(endpoint);
  const connectOutcome = await raceTimeout(connectPromise, connectTimeoutMs, schedule);
  if (connectOutcome.kind === "timeout") {
    // 迟到建立/失败的连接不再使用，立即关闭；迟到的拒绝按已处理消化，不外溢
    connectPromise.then(
      (late) => safeClose(late),
      () => {},
    );
    return { kind: "failure", reason: "connect-timeout", detail: `连接 ${connectTimeoutMs}ms 内未建立` };
  }
  if (connectOutcome.kind === "error") {
    return { kind: "failure", reason: "offline", detail: `连接失败：${describeError(connectOutcome.error)}` };
  }
  const connection = connectOutcome.value;

  // 响应可能在写入 resolve 的同时（甚至之前）到达：先挂监听再写入
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
    writePromise.catch(() => {}); // 迟到的失败按已处理消化，不外溢
    safeClose(connection);
    return { kind: "failure", reason: "write-timeout", detail: `写入 ${writeTimeoutMs}ms 内未完成` };
  }
  if (writeOutcome.kind === "error") {
    safeClose(connection);
    return { kind: "failure", reason: "offline", detail: `写入失败：${describeError(writeOutcome.error)}` };
  }

  // 等待首个解码事件：预算沿用写入超时（规格未单设响应超时），但按绝对截止时间执行——
  // 每次唤醒只按剩余时长重武装，对端逐字节滴流不能把等待无限续期
  const responseDeadline = now() + writeTimeoutMs;
  const responseTimeoutFailure = (): PeersSendOutcome => {
    safeClose(connection);
    return {
      kind: "failure",
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
          return { kind: "failure", reason: "invalid-frame", detail: "响应通道收到请求帧" };
        }
        if (event.frame.messageId !== frame.messageId) {
          return { kind: "failure", reason: "invalid-frame", detail: "响应消息 id 与请求不匹配" };
        }
        return { kind: "response", response: event.frame };
      }
      return { kind: "failure", reason: event.reason, detail: event.detail };
    }
    if (closed) {
      return { kind: "failure", reason: "offline", detail: "连接在响应到达前关闭" };
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
