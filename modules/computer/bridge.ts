// computer 模块的桥：工具层与原生 helper 进程之间的 JSON-lines 通道（工单 04）。
//
// 职责边界：本文件只做通道本身，即编解码、版本协商、调用串行与超时、崩溃重启、进程回收；
// 不解析业务命令（P1 起命令形状按 docs/pi-computer/桥协议-v1.md 登记）。
// helper 的启动命令由调用方注入：P0 没有原生层，测试注入假 helper；真实二进制的查找规则留到 P1。
//
// 生命周期约定：谁创建谁回收。dispose() 杀 helper，进程退出钩子兜底，宿主退出不留孤儿进程。
// 协议口径（信封、版本号、超时语义、崩溃语义）以 docs/pi-computer/桥协议-v1.md 为准。

import { spawn, type ChildProcess } from "node:child_process";
import {
  BACKGROUND_INPUT_LEVELS,
  COMPUTER_ERROR_CODES,
  COMPUTER_PERMISSIONS,
  COMPUTER_PLATFORMS,
  COORDINATE_MODES,
  PERMISSION_STATES,
  type ComputerBackgroundInput,
  type ComputerCapabilities,
  type ComputerCoordinateMode,
  type ComputerError,
  type ComputerErrorCode,
  type ComputerPermission,
  type ComputerPermissionState,
  type ComputerPlatform,
  type ComputerResult,
} from "./contract.ts";

/** 线上协议版本：信封 protocolVersion 字段的取值，v1 固定为 1 */
export const BRIDGE_PROTOCOL_VERSION = 1;

/** 单次调用的默认超时；P0 取参考实现（pi-computer-use-injaneity 的 windows helper）的 15 秒 */
export const DEFAULT_BRIDGE_CALL_TIMEOUT_MS = 15_000;

/** 握手命令名：版本核对、helper 元信息与能力快照都从它拿 */
export const BRIDGE_HANDSHAKE_COMMAND = "hello";

/** stderr 只进崩溃诊断，最多留这么多字符，防止流式日志把内存吃穿 */
const STDERR_TAIL_CHARS = 500;

export interface BridgeLaunchSpec {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  /** 追加并覆盖宿主环境变量；不设置时继承 process.env */
  readonly env?: Readonly<Record<string, string>>;
}

export interface BridgeHelperInfo {
  readonly name: string;
  readonly version: string;
  readonly pid: number;
}

export interface BridgeHandshake {
  /** 协商成功后的版本号；ComputerStatusData.bridge.protocolVersion 是字符串，这里直接给字符串 "1" */
  readonly protocolVersion: string;
  readonly helper: BridgeHelperInfo;
  readonly capabilities: ComputerCapabilities;
}

export interface ComputerBridgeOptions {
  readonly launch: BridgeLaunchSpec;
  /**
   * 单次调用（含握手）的超时上限，计时从请求写出开始。
   * 超时判 bridge_timeout 并杀掉 helper，下次调用重新启动。
   */
  readonly callTimeoutMs?: number;
}

export interface ComputerBridge {
  /** 协商成功的协议版本字符串；未握手成功时为 null */
  readonly protocolVersion: string | null;
  readonly ready: boolean;
  /** 握手缓存（helper 元信息与能力）；未握手成功时为 null */
  readonly handshake: BridgeHandshake | null;
  /**
   * 只触发帮助进程启动与握手，不额外发业务命令；幂等，已就绪时直接成功。
   * 能力探测（computer_status）用它：读能力不该顺带跑一条业务调用。
   */
  ensureReady(): Promise<ComputerResult<true>>;
  call<T = unknown>(cmd: string, args?: Readonly<Record<string, unknown>>): Promise<ComputerResult<T>>;
  /** 幂等；关闭后 call 一律返回 bridge_unavailable，且不再启动 helper */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// 信封与编解码（协议规范第 2 节；纯函数，可单独测）
// ---------------------------------------------------------------------------

export interface BridgeRequest {
  readonly protocolVersion: number;
  /** 请求内唯一，形如 req_1、req_2 */
  readonly id: string;
  readonly cmd: string;
  readonly args: Record<string, unknown>;
}

export interface BridgeResponse {
  readonly protocolVersion: number;
  readonly id: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: { readonly code?: string; readonly message?: string };
}

export type DecodedBridgeLine =
  | { readonly kind: "response"; readonly response: BridgeResponse }
  | { readonly kind: "version_mismatch"; readonly id: string; readonly protocolVersion: number }
  | { readonly kind: "invalid"; readonly reason: string };

export type DecodedBridgeRequest =
  | { readonly kind: "request"; readonly request: BridgeRequest }
  | { readonly kind: "invalid"; readonly reason: string };

export function encodeBridgeRequest(request: BridgeRequest): string {
  return `${JSON.stringify(request)}\n`;
}

/** helper 侧读请求的形态校验；TS 侧只编码请求，这个方向主要给测试与协议对照用 */
export function decodeBridgeRequest(line: string): DecodedBridgeRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { kind: "invalid", reason: "不是合法 JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "invalid", reason: "请求必须是 JSON 对象" };
  }
  const record = parsed as Record<string, unknown>;
  const { protocolVersion, id, cmd, args } = record;
  if (typeof protocolVersion !== "number" || !Number.isInteger(protocolVersion)) {
    return { kind: "invalid", reason: "protocolVersion 必须是整数" };
  }
  if (typeof id !== "string" || id.length === 0) {
    return { kind: "invalid", reason: "id 必须是非空字符串" };
  }
  if (typeof cmd !== "string" || cmd.length === 0) {
    return { kind: "invalid", reason: "cmd 必须是非空字符串" };
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return { kind: "invalid", reason: "args 必须是 JSON 对象" };
  }
  return { kind: "request", request: { protocolVersion, id, cmd, args: args as Record<string, unknown> } };
}

/**
 * 解一行响应；只判形态，不判 id 归属（归属由通道按当前在途调用匹配）。
 * 版本不匹配单独成一类：信封合法但协议对不上，错误信息里要能同时看到两侧版本。
 */
export function decodeBridgeLine(
  line: string,
  expectedProtocolVersion: number = BRIDGE_PROTOCOL_VERSION,
): DecodedBridgeLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { kind: "invalid", reason: "不是合法 JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "invalid", reason: "响应必须是 JSON 对象" };
  }
  const record = parsed as Record<string, unknown>;
  const { protocolVersion, id, ok } = record;
  if (typeof protocolVersion !== "number" || !Number.isInteger(protocolVersion)) {
    return { kind: "invalid", reason: "protocolVersion 必须是整数" };
  }
  if (typeof id !== "string" || id.length === 0) {
    return { kind: "invalid", reason: "id 必须是非空字符串" };
  }
  if (protocolVersion !== expectedProtocolVersion) {
    return { kind: "version_mismatch", id, protocolVersion };
  }
  if (typeof ok !== "boolean") {
    return { kind: "invalid", reason: "ok 必须是布尔值" };
  }
  if (ok) {
    return { kind: "response", response: { protocolVersion, id, ok: true, result: record.result } };
  }
  if (typeof record.error !== "object" || record.error === null || Array.isArray(record.error)) {
    return { kind: "invalid", reason: "ok=false 时必须带 error 对象" };
  }
  const errorRecord = record.error as Record<string, unknown>;
  const code = errorRecord.code;
  const message = errorRecord.message;
  if (code !== undefined && typeof code !== "string") {
    return { kind: "invalid", reason: "error.code 必须是字符串" };
  }
  if (message !== undefined && typeof message !== "string") {
    return { kind: "invalid", reason: "error.message 必须是字符串" };
  }
  return { kind: "response", response: { protocolVersion, id, ok: false, error: { code, message } } };
}

// ---------------------------------------------------------------------------
// 通道实现
// ---------------------------------------------------------------------------

interface PendingCall {
  readonly id: string;
  settle(result: ComputerResult<unknown>): void;
}

function okResult<T>(data: T): ComputerResult<T> {
  return { ok: true, data };
}

function failResult(code: ComputerErrorCode, detail?: string): ComputerResult<never> {
  return { ok: false, error: detail === undefined ? { code } : { code, detail } };
}

function isComputerErrorCode(value: string): value is ComputerErrorCode {
  return (COMPUTER_ERROR_CODES as readonly string[]).includes(value);
}

/** helper 的错误码在契约里认识就原样保留，不认识统一归 action_failed，原始码进 detail */
function mapHelperError(error: { readonly code?: string; readonly message?: string } | undefined): ComputerError {
  if (error?.code !== undefined && isComputerErrorCode(error.code)) {
    return error.message === undefined ? { code: error.code } : { code: error.code, detail: error.message };
  }
  if (error?.code !== undefined) {
    const detail = error.message === undefined ? error.code : `${error.code}: ${error.message}`;
    return { code: "action_failed", detail };
  }
  return error?.message === undefined
    ? { code: "action_failed" }
    : { code: "action_failed", detail: error.message };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 取值域校验：字符串且在允许取值里才通过（platform、coordinateMode、backgroundInput、权限状态共用） */
function parseDomain<T extends string>(value: unknown, allowed: readonly string[]): T | undefined {
  return typeof value === "string" && allowed.includes(value) ? (value as T) : undefined;
}

/**
 * 能力快照的字段级校验（工单 13）：类型与取值域都对着 contract.ts 的 ComputerCapabilities 查，
 * 未知字段忽略；必填字段缺失或越界一律判 undefined，由调用方按 bridge_unavailable 处理，不把垃圾当能力用。
 */
function parseCapabilities(value: unknown): ComputerCapabilities | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const platform = parseDomain<ComputerPlatform>(record.platform, COMPUTER_PLATFORMS);
  if (platform === undefined) return undefined;
  const { accessibility, capture, input } = record;
  if (typeof accessibility !== "boolean" || typeof capture !== "boolean" || typeof input !== "boolean") {
    return undefined;
  }
  const coordinateMode = parseDomain<ComputerCoordinateMode>(record.coordinateMode, COORDINATE_MODES);
  if (coordinateMode === undefined) return undefined;
  const backgroundInput = parseDomain<ComputerBackgroundInput>(record.backgroundInput, BACKGROUND_INPUT_LEVELS);
  if (backgroundInput === undefined) return undefined;
  const permissions = record.permissions;
  if (typeof permissions !== "object" || permissions === null || Array.isArray(permissions)) return undefined;
  const permissionRecord = permissions as Record<string, unknown>;
  const parsedPermissions: Partial<Record<ComputerPermission, ComputerPermissionState>> = {};
  for (const name of COMPUTER_PERMISSIONS) {
    const state = parseDomain<ComputerPermissionState>(permissionRecord[name], PERMISSION_STATES);
    if (state === undefined) return undefined;
    parsedPermissions[name] = state;
  }
  const limits = record.limits;
  if (!Array.isArray(limits) || !limits.every((limit) => typeof limit === "string")) return undefined;
  return {
    platform,
    accessibility,
    capture,
    input,
    coordinateMode,
    backgroundInput,
    // 循环按 COMPUTER_PERMISSIONS 逐个赋值，三个键必然齐备；Partial 只是循环赋值的类型代价
    permissions: parsedPermissions as Record<ComputerPermission, ComputerPermissionState>,
    limits: limits as readonly string[],
  };
}

/** 握手载荷来自进程边界，形态不对就拒绝，不把垃圾当能力用 */
function parseHandshake(value: unknown): BridgeHandshake | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const helper = record.helper;
  if (typeof helper !== "object" || helper === null || Array.isArray(helper)) return undefined;
  const helperRecord = helper as Record<string, unknown>;
  const { name, version, pid } = helperRecord;
  if (typeof name !== "string" || name.length === 0 || typeof version !== "string" || version.length === 0) {
    return undefined;
  }
  if (typeof pid !== "number" || !Number.isInteger(pid)) return undefined;
  const capabilities = parseCapabilities(record.capabilities);
  if (capabilities === undefined) return undefined;
  return {
    protocolVersion: String(BRIDGE_PROTOCOL_VERSION),
    helper: { name, version, pid },
    capabilities,
  };
}

/** pipe 运行时是带 unref 的 Socket；类型上只声明成可选的 unref，宿主退出不被 helper 拖住 */
function unrefStream(stream: unknown): void {
  (stream as { unref?: () => void } | null | undefined)?.unref?.();
}

class Bridge implements ComputerBridge {
  private readonly launch: BridgeLaunchSpec;
  private readonly callTimeoutMs: number;
  private readonly processExitHook: () => void;
  private child?: ChildProcess;
  private buffer = "";
  private stderrTail = "";
  private sequence = 0;
  private pending?: PendingCall;
  /** 调用队列：默认串行，后来的等前面的结算（无论成败）再跑 */
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private handshakeValue: BridgeHandshake | null = null;

  constructor(options: ComputerBridgeOptions) {
    this.launch = options.launch;
    this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_BRIDGE_CALL_TIMEOUT_MS;
    this.processExitHook = () => {
      this.killHelper();
    };
    process.on("exit", this.processExitHook);
  }

  get protocolVersion(): string | null {
    return this.handshakeValue?.protocolVersion ?? null;
  }

  get ready(): boolean {
    return this.child !== undefined && this.handshakeValue !== null;
  }

  get handshake(): BridgeHandshake | null {
    return this.handshakeValue;
  }

  call<T = unknown>(cmd: string, args: Readonly<Record<string, unknown>> = {}): Promise<ComputerResult<T>> {
    return this.enqueue<ComputerResult<T>>(() => this.execute<T>(cmd, { ...args }));
  }

  ensureReady(): Promise<ComputerResult<true>> {
    return this.enqueue<ComputerResult<true>>(() =>
      this.disposed ? Promise.resolve(failResult("bridge_unavailable", "桥已关闭")) : this.ensureHelper(),
    );
  }

  private enqueue<R>(run: () => Promise<R>): Promise<R> {
    const result = this.queue.then(run, run);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    process.removeListener("exit", this.processExitHook);
    this.pending?.settle(failResult("bridge_unavailable", "桥已关闭"));
    this.killHelper();
  }

  private async execute<T>(cmd: string, args: Record<string, unknown>): Promise<ComputerResult<T>> {
    if (this.disposed) return failResult("bridge_unavailable", "桥已关闭");
    const ready = await this.ensureHelper();
    if (!ready.ok) return ready;
    return await this.exchange<T>(cmd, args);
  }

  /** 惰性启动：没有活着的 helper 就起一个并完成 hello 握手；崩溃或超时后的下次调用走同一条路 */
  private async ensureHelper(): Promise<ComputerResult<true>> {
    if (this.child !== undefined) return okResult(true);
    const spawned = await this.spawnHelper();
    if (!spawned.ok) return spawned;
    const hello = await this.exchange<unknown>(BRIDGE_HANDSHAKE_COMMAND, {});
    if (!hello.ok) {
      this.killHelper();
      return hello;
    }
    const handshake = parseHandshake(hello.data);
    if (handshake === undefined) {
      this.killHelper();
      return failResult("bridge_unavailable", "helper 的 hello 载荷不合法");
    }
    this.handshakeValue = handshake;
    return okResult(true);
  }

  private spawnHelper(): Promise<ComputerResult<true>> {
    return new Promise((resolveSpawn) => {
      let child: ChildProcess;
      try {
        child = spawn(this.launch.command, [...(this.launch.args ?? [])], {
          cwd: this.launch.cwd,
          env: this.launch.env === undefined ? process.env : { ...process.env, ...this.launch.env },
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (error) {
        resolveSpawn(failResult("bridge_unavailable", `无法启动 helper：${errorText(error)}`));
        return;
      }
      const onSpawnError = (error: Error) => {
        child.removeListener("spawn", onSpawn);
        resolveSpawn(failResult("bridge_unavailable", `helper 启动失败：${error.message}`));
      };
      const onSpawn = () => {
        child.removeListener("error", onSpawnError);
        this.adoptChild(child);
        resolveSpawn(okResult(true));
      };
      child.once("spawn", onSpawn);
      child.once("error", onSpawnError);
    });
  }

  private adoptChild(child: ChildProcess): void {
    this.child = child;
    this.buffer = "";
    this.stderrTail = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr?.on("data", (chunk: string) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-STDERR_TAIL_CHARS);
    });
    // 用 close 而不是 exit：exit 可能早于管道里最后一行响应到达，会把已经写出的应答误判成崩溃
    child.on("close", (code, signal) => this.onChildClosed(child, code, signal));
    // 常驻 helper 不拖住宿主的事件循环；宿主退出时的回收由进程钩子负责
    child.unref();
    unrefStream(child.stdin);
    unrefStream(child.stdout);
    unrefStream(child.stderr);
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) return;
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim()) this.onLine(line);
    }
  }

  private onLine(line: string): void {
    const pending = this.pending;
    if (pending === undefined) return;
    const decoded = decodeBridgeLine(line);
    if (decoded.kind === "invalid") {
      pending.settle(failResult("bridge_unavailable", `helper 写出非法响应：${decoded.reason}`));
      this.killHelper();
      return;
    }
    // 只认当前在途调用的 id；乱序或迟到的行不打扰其他调用
    if (decoded.kind === "response" && decoded.response.id !== pending.id) return;
    if (decoded.kind === "version_mismatch") {
      if (decoded.id !== pending.id) return;
      pending.settle(
        failResult(
          "bridge_unavailable",
          `协议版本不匹配：桥期望 ${BRIDGE_PROTOCOL_VERSION}，helper 回应 ${decoded.protocolVersion}`,
        ),
      );
      this.killHelper();
      return;
    }
    const response = decoded.response;
    if (response.ok) {
      pending.settle(okResult(response.result));
      return;
    }
    pending.settle({ ok: false, error: mapHelperError(response.error) });
  }

  private exchange<T>(cmd: string, args: Record<string, unknown>): Promise<ComputerResult<T>> {
    const stdin = this.child?.stdin;
    if (!stdin) {
      return Promise.resolve(failResult("bridge_unavailable", "helper 进程不可用"));
    }
    const id = `req_${++this.sequence}`;
    const request: BridgeRequest = { protocolVersion: BRIDGE_PROTOCOL_VERSION, id, cmd, args };
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const settle = (result: ComputerResult<unknown>): void => {
        if (this.pending !== pending) return;
        this.pending = undefined;
        if (timer !== undefined) clearTimeout(timer);
        resolve(result as ComputerResult<T>);
      };
      const pending: PendingCall = { id, settle };
      this.pending = pending;
      timer = setTimeout(() => {
        settle(failResult("bridge_timeout", `helper 在 ${this.callTimeoutMs}ms 内没有响应命令 ${cmd}`));
        // 超时按 helper 卡死处理：杀掉它就杜绝悬挂进程，下次调用重新启动
        this.killHelper();
      }, this.callTimeoutMs);
      stdin.write(encodeBridgeRequest(request), (error) => {
        if (!error) return;
        settle(failResult("bridge_unavailable", `写入 helper 失败：${error.message}`));
        this.killHelper();
      });
    });
  }

  private onChildClosed(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) return;
    this.child = undefined;
    this.buffer = "";
    this.handshakeValue = null;
    const pending = this.pending;
    if (pending === undefined) return;
    const tail = this.stderrTail.trim();
    const detail = `helper 在应答前退出（code=${String(code)}，signal=${String(signal)}）${tail ? `，stderr：${tail}` : ""}`;
    pending.settle(failResult("bridge_unavailable", detail));
  }

  private killHelper(): void {
    const child = this.child;
    if (child === undefined) return;
    this.child = undefined;
    this.buffer = "";
    this.handshakeValue = null;
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
    // 桥不依赖 helper 优雅退出（P0 没有需要落盘的状态），两个信号立刻发出，保证不被卡死的子进程拖住
    try {
      child.kill("SIGTERM");
    } catch {
      // 进程可能已经退出，忽略
    }
    try {
      child.kill("SIGKILL");
    } catch {
      // 同上
    }
    child.unref();
  }
}

export function createComputerBridge(options: ComputerBridgeOptions): ComputerBridge {
  return new Bridge(options);
}
