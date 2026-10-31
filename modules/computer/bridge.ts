import { spawn, type ChildProcess } from "node:child_process";
import {
  BACKGROUND_INPUT_LEVELS,
  BACKGROUND_POINTER_COORDINATE_CASES,
  BACKGROUND_POINTER_COORDINATE_CONDITIONS,
  BACKGROUND_POINTER_EVENT_TYPES,
  BACKGROUND_POINTER_TARGET_KINDS,
  BACKGROUND_POINTER_WINDOW_TYPES,
  COMPUTER_ERROR_CODES,
  COMPUTER_PERMISSIONS,
  COMPUTER_PLATFORMS,
  COORDINATE_MODES,
  PERMISSION_STATES,
  type ComputerBackgroundInput,
  type ComputerBackgroundPointerApp,
  type ComputerBackgroundPointerCoordinate,
  type ComputerBackgroundPointerCoordinateCase,
  type ComputerBackgroundPointerCoordinateCondition,
  type ComputerBackgroundPointerEventType,
  type ComputerBackgroundPointerLimits,
  type ComputerBackgroundPointerTargetKind,
  type ComputerBackgroundPointerWindowType,
  type ComputerCapabilities,
  type ComputerCoordinateMode,
  type ComputerError,
  type ComputerErrorCode,
  type ComputerPermission,
  type ComputerPermissionState,
  type ComputerPlatform,
  type ComputerResult,
} from "./contract.ts";

export const BRIDGE_PROTOCOL_VERSION = 1;

export const DEFAULT_BRIDGE_CALL_TIMEOUT_MS = 15_000;

export const BRIDGE_HANDSHAKE_COMMAND = "hello";

const STDERR_TAIL_CHARS = 500;

export interface BridgeLaunchSpec {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;

  readonly env?: Readonly<Record<string, string>>;
}

export interface BridgeHelperInfo {
  readonly name: string;
  readonly version: string;
  readonly pid: number;
}

export interface BridgeHandshake {

  readonly protocolVersion: string;
  readonly helper: BridgeHelperInfo;
  readonly capabilities: ComputerCapabilities;
}

export interface ComputerBridgeOptions {
  readonly launch: BridgeLaunchSpec;

  readonly callTimeoutMs?: number;
}

export interface ComputerBridge {

  readonly protocolVersion: string | null;
  readonly ready: boolean;

  readonly handshake: BridgeHandshake | null;

  ensureReady(): Promise<ComputerResult<true>>;
  call<T = unknown>(cmd: string, args?: Readonly<Record<string, unknown>>): Promise<ComputerResult<T>>;

  dispose(): void;
}

export interface BridgeRequest {
  readonly protocolVersion: number;

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

function parseDomain<T extends string>(value: unknown, allowed: readonly string[]): T | undefined {
  return typeof value === "string" && allowed.includes(value) ? (value as T) : undefined;
}

function parseText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function parseDomainList<T extends string>(value: unknown, allowed: readonly string[], minLength = 0): T[] | undefined {
  if (!Array.isArray(value) || value.length < minLength) return undefined;
  const parsed: T[] = [];
  for (const item of value) {
    const entry = parseDomain<T>(item, allowed);
    if (entry === undefined) return undefined;
    parsed.push(entry);
  }
  return parsed;
}

function parseVerifiedPair<T extends string>(
  value: unknown,
  allowed: readonly string[],
): { verified: T[]; unverified: T[] } | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const verified = parseDomainList<T>(record.verified, allowed);
  if (verified === undefined) return undefined;
  const unverified = parseDomainList<T>(record.unverified, allowed);
  if (unverified === undefined) return undefined;
  return { verified, unverified };
}

function parseBackgroundPointerApp(value: unknown): ComputerBackgroundPointerApp | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const id = parseText(record.id);
  if (id === undefined) return undefined;
  const version = parseText(record.version);
  if (version === undefined) return undefined;
  const kind = parseDomain<ComputerBackgroundPointerTargetKind>(record.kind, BACKGROUND_POINTER_TARGET_KINDS);
  if (kind === undefined) return undefined;
  const verifiedBy = parseText(record.verifiedBy);
  if (verifiedBy === undefined) return undefined;

  const windowTypes = parseDomainList<ComputerBackgroundPointerWindowType>(record.windowTypes, BACKGROUND_POINTER_WINDOW_TYPES, 1);
  if (windowTypes === undefined) return undefined;
  const eventTypes = parseDomainList<ComputerBackgroundPointerEventType>(record.eventTypes, BACKGROUND_POINTER_EVENT_TYPES, 1);
  if (eventTypes === undefined) return undefined;
  return { id, version, kind, windowTypes, eventTypes, verifiedBy };
}

function parseBackgroundPointerCoordinate(value: unknown): ComputerBackgroundPointerCoordinate | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const condition = parseDomain<ComputerBackgroundPointerCoordinateCondition>(
    record.condition,
    BACKGROUND_POINTER_COORDINATE_CONDITIONS,
  );
  if (condition === undefined) return undefined;
  if (typeof record.requiresSnapshot !== "boolean") return undefined;
  const verifiedCases = parseDomainList<ComputerBackgroundPointerCoordinateCase>(
    record.verifiedCases,
    BACKGROUND_POINTER_COORDINATE_CASES,
  );
  if (verifiedCases === undefined) return undefined;
  const unverifiedCases = parseDomainList<ComputerBackgroundPointerCoordinateCase>(
    record.unverifiedCases,
    BACKGROUND_POINTER_COORDINATE_CASES,
  );
  if (unverifiedCases === undefined) return undefined;
  return { condition, requiresSnapshot: record.requiresSnapshot, verifiedCases, unverifiedCases };
}

function parseBackgroundPointerLimits(value: unknown): ComputerBackgroundPointerLimits | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const evidenceVersion = parseText(record.evidenceVersion);
  if (evidenceVersion === undefined) return undefined;
  const evidenceDate = parseText(record.evidenceDate);
  if (evidenceDate === undefined) return undefined;
  const mechanism = parseText(record.mechanism);
  if (mechanism === undefined) return undefined;
  if (!Array.isArray(record.apps)) return undefined;
  const apps: ComputerBackgroundPointerApp[] = [];
  for (const entry of record.apps) {
    const app = parseBackgroundPointerApp(entry);
    if (app === undefined) return undefined;
    apps.push(app);
  }
  const windowTypes = parseVerifiedPair<ComputerBackgroundPointerWindowType>(
    record.windowTypes,
    BACKGROUND_POINTER_WINDOW_TYPES,
  );
  if (windowTypes === undefined) return undefined;
  const eventTypes = parseVerifiedPair<ComputerBackgroundPointerEventType>(
    record.eventTypes,
    BACKGROUND_POINTER_EVENT_TYPES,
  );
  if (eventTypes === undefined) return undefined;
  const coordinate = parseBackgroundPointerCoordinate(record.coordinate);
  if (coordinate === undefined) return undefined;
  const degradations = record.degradations;
  if (!Array.isArray(degradations) || !degradations.every((entry) => typeof entry === "string")) return undefined;
  return {
    evidenceVersion,
    evidenceDate,
    mechanism,
    apps,
    windowTypes,
    eventTypes,
    coordinate,
    degradations: degradations as readonly string[],
  };
}

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

  const backgroundPointer =
    record.backgroundPointer === undefined
      ? "none"
      : parseDomain<ComputerBackgroundInput>(record.backgroundPointer, BACKGROUND_INPUT_LEVELS);
  if (backgroundPointer === undefined) return undefined;

  const backgroundPointerLimits = parseBackgroundPointerLimits(record.backgroundPointerLimits);
  if (backgroundPointerLimits === undefined && record.backgroundPointerLimits !== undefined) return undefined;
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
    backgroundPointer,

    ...(backgroundPointerLimits !== undefined ? { backgroundPointerLimits } : {}),

    permissions: parsedPermissions as Record<ComputerPermission, ComputerPermissionState>,
    limits: limits as readonly string[],
  };
}

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

    child.on("close", (code, signal) => this.onChildClosed(child, code, signal));

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

    try {
      child.kill("SIGTERM");
    } catch {

    }
    try {
      child.kill("SIGKILL");
    } catch {

    }
    child.unref();
  }
}

export function createComputerBridge(options: ComputerBridgeOptions): ComputerBridge {
  return new Bridge(options);
}
