import { chmodSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PeersSettings } from "./api.ts";
import {
  PEERS_PROTOCOL_VERSION,
  createPeersFrameDecoder,
  encodePeersFrame,
  type PeersDecodeEvent,
  type PeersDeliveryResult,
  type PeersReasonCode,
  type PeersRequestFrame,
  type PeersResponseFrame,
  type PeersTransport,
  type PeersTransportConnection,
} from "./protocol.ts";

const IS_WINDOWS = process.platform === "win32";

const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\";

const ENDPOINT_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

const UNIX_SOCKET_FILE_PATTERN = /^s-[0-9a-f]{16}\.sock$/;

const UNIX_PROBE_TIMEOUT_MS = 300;

function errnoCode(error: unknown): string | undefined {
  return typeof (error as { code?: unknown } | null)?.code === "string"
    ? (error as { code: string }).code
    : undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function peersWindowsPipeName(instanceId: string): string {
  return `${WINDOWS_PIPE_PREFIX}pi-toolkit-peers-${instanceId.replace(/-/g, "")}`;
}

export function peersUnixSocketDir(agentDir: string): string {
  const hash = createHash("sha256").update(agentDir).digest("hex").slice(0, 8);
  const parent = tmpdir() || ".";
  return join(parent, `pi-ptp-${hash}`);
}

export function peersUnixSocketAddress(agentDir: string, instanceId: string): string {
  return join(peersUnixSocketDir(agentDir), `s-${instanceId.replace(/-/g, "").slice(0, 16)}.sock`);
}

export interface PeersEndpointReply {
  readonly result: PeersDeliveryResult;
  readonly reason: PeersReasonCode | null;
}

export type PeersEndpointRequestHandler = (
  request: PeersRequestFrame,
) => PeersEndpointReply | Promise<PeersEndpointReply>;

export interface PeersEndpointServerOptions {
  readonly agentDir: string;

  readonly instanceId: string;

  readonly getSettings: () => Pick<PeersSettings, "maxFrameBytes">;
  readonly onRequest: PeersEndpointRequestHandler;

  readonly onError?: (detail: string) => void;
  readonly now?: () => number;
}

export interface PeersEndpointServer {

  start(): Promise<string>;

  close(): void;

  address(): string | null;
}

function listenNetServer(server: net.Server, address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", (error) => reject(error));
    server.listen(address);
  });
}

function ensureUnixSocketDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const mode = statSync(dir).mode & 0o777;
  if (mode & 0o077) chmodSync(dir, mode & 0o700);
}

type UnixProbeOutcome = "refused" | "occupied";

function probeUnixEndpoint(address: string): Promise<UnixProbeOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: UnixProbeOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(outcome);
    };
    const socket = net.connect(address);
    socket.unref();
    socket.on("connect", () => finish("occupied"));
    socket.on("error", (error) => {
      const code = errnoCode(error);
      finish(code === "ECONNREFUSED" || code === "ENOENT" ? "refused" : "occupied");
    });
    const timer = setTimeout(() => finish("occupied"), UNIX_PROBE_TIMEOUT_MS);
    timer.unref();
  });
}

async function sweepStaleUnixSockets(dir: string, ownPath: string): Promise<void> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const probes: Promise<void>[] = [];
  for (const name of names) {
    if (!UNIX_SOCKET_FILE_PATTERN.test(name)) continue;
    const file = join(dir, name);
    if (file === ownPath) continue;
    probes.push(
      probeUnixEndpoint(file).then((outcome) => {
        if (outcome !== "refused") return;
        try {
          unlinkSync(file);
        } catch {
          // 探活判陈旧后被其它实例先清：竞争正常
        }
      }),
    );
  }
  await Promise.allSettled(probes);
}

export function createPeersEndpointServer(options: PeersEndpointServerOptions): PeersEndpointServer {
  const now = options.now ?? Date.now;
  let phase: "idle" | "starting" | "listening" | "closed" = "idle";
  let server: net.Server | undefined;
  let currentAddress: string | null = null;
  const sockets = new Set<net.Socket>();

  const teardown = (): void => {
    if (server) {
      try {
        server.close();
      } catch {
        // 释放尽力而为：server 已死时不影响后续清理
      }
      server = undefined;
    }
    for (const socket of sockets) socket.destroy();
    sockets.clear();

    if (currentAddress !== null && !IS_WINDOWS) {
      try {
        unlinkSync(currentAddress);
      } catch (error) {
        if (errnoCode(error) !== "ENOENT") options.onError?.(`端点文件回收失败（${currentAddress}）：${describeError(error)}`);
      }
    }
    currentAddress = null;
    phase = "closed";
  };

  const handleConnection = (socket: net.Socket): void => {
    socket.unref();
    sockets.add(socket);

    let maxFrameBytes: number;
    try {
      maxFrameBytes = options.getSettings().maxFrameBytes;
    } catch (error) {
      options.onError?.(`端点读取配置失败，断开连接：${describeError(error)}`);

      sockets.delete(socket);

      socket.on("error", () => {});
      socket.destroy();
      return;
    }
    const decoder = createPeersFrameDecoder({ maxFrameBytes });

    const send = (response: PeersResponseFrame): void => {
      const encoded = encodePeersFrame(response, { maxFrameBytes });

      if (!encoded.ok) return;
      socket.write(encoded.bytes, () => {});
    };
    const errorReply = (messageId: string, reason: PeersReasonCode): void => {
      send({ type: "response", protocolVersion: PEERS_PROTOCOL_VERSION, messageId, result: "error", reason, serverTime: now() });
    };
    const handleEvent = (event: PeersDecodeEvent): void => {
      if (event.kind === "frame") {
        if (event.frame.type === "request") {
          const request = event.frame;

          void Promise.resolve().then(() => options.onRequest(request)).then(
            (reply) => {
              send({
                type: "response",
                protocolVersion: PEERS_PROTOCOL_VERSION,
                messageId: event.frame.messageId,
                result: reply.result,
                reason: reply.reason,
                serverTime: now(),
              });
            },
            (error) => {

              errorReply(event.frame.messageId, "invalid-frame");
              options.onError?.(`端点请求处理异常（消息 id ${event.frame.messageId}）：${describeError(error)}`);
            },
          );
        } else {

          errorReply(event.frame.messageId, "invalid-frame");
        }
        return;
      }

      errorReply("", event.reason);
      if (event.fatal) socket.destroy();
    };

    socket.on("data", (chunk: Buffer) => {
      for (const event of decoder.push(chunk)) handleEvent(event);
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      sockets.delete(socket);
    });
  };

  const makeServer = (): net.Server => {
    const fresh = net.createServer();
    fresh.unref();
    fresh.on("connection", handleConnection);
    return fresh;
  };

  const describeListenError = (error: unknown, address: string): Error => {
    const code = errnoCode(error);
    const lengthHint =
      code === "ENAMETOOLONG" ? `（路径 ${address.length} 字符超出 Unix 域 socket 地址长度限制）` : "";
    return new Error(`端点监听建立失败（${code ? `${code} ` : ""}${address}）：${describeError(error)}${lengthHint}`);
  };

  const startUnix = async (address: string): Promise<void> => {
    const dir = dirname(address);
    ensureUnixSocketDir(dir);
    const tryListen = async (): Promise<net.Server> => {
      const fresh = makeServer();
      try {
        await listenNetServer(fresh, address);
        return fresh;
      } catch (error) {
        if (errnoCode(error) !== "EADDRINUSE") throw error;

        const outcome = await probeUnixEndpoint(address);
        if (outcome === "occupied") {
          throw new Error(`端点 ${address} 已被存活实例占用，不抢占`);
        }
        try {
          unlinkSync(address);
        } catch {
          // 探活判陈旧后被其它实例先清：重试 listen 自然见分晓
        }
        const retry = makeServer();
        await listenNetServer(retry, address);
        return retry;
      }
    };
    server = await tryListen();

    try {
      chmodSync(address, 0o600);
      await sweepStaleUnixSockets(dir, address);
    } catch (error) {
      try {
        unlinkSync(address);
      } catch {
        // 回收尽力而为：unlink 失败只能留待目录清扫，诊断走上层 start 失败路径
      }
      throw error;
    }
  };

  const startWindows = async (address: string): Promise<void> => {
    server = makeServer();
    await listenNetServer(server, address);
  };

  return {
    start(): Promise<string> {
      if (phase !== "idle") {
        return Promise.reject(new Error(`端点监听不可重复启动（当前状态 ${phase}）`));
      }
      if (!ENDPOINT_ID_PATTERN.test(options.instanceId)) {
        phase = "closed";
        return Promise.reject(new Error(`实例 id 含端点名不安全字符：${JSON.stringify(options.instanceId)}`));
      }
      phase = "starting";
      const address = IS_WINDOWS
        ? peersWindowsPipeName(options.instanceId)
        : peersUnixSocketAddress(options.agentDir, options.instanceId);
      const boot = IS_WINDOWS ? startWindows(address) : startUnix(address);
      return boot.then(
        () => {
          if (phase !== "starting") {

            currentAddress = address;
            teardown();
            return address;
          }
          phase = "listening";
          currentAddress = address;

          server?.on("error", (error) => {
            options.onError?.(`端点监听异常（${address}）：${describeError(error)}`);
            teardown();
          });
          return address;
        },
        (error) => {

          if (server) teardown();
          phase = "closed";
          throw error instanceof Error && error.message.startsWith("端点")
            ? error
            : describeListenError(error, address);
        },
      );
    },

    close(): void {
      if (phase === "idle") {
        phase = "closed";
        return;
      }
      teardown();
    },

    address(): string | null {
      return currentAddress;
    },
  };
}

export function createPeersTransport(): PeersTransport {
  return {
    connect(endpoint: string): Promise<PeersTransportConnection> {
      return new Promise((resolve, reject) => {
        const socket = net.connect(endpoint);
        let settled = false;
        socket.on("connect", () => {
          if (settled) return;
          settled = true;
          resolve({
            write: (data) =>
              new Promise<void>((resolveWrite, rejectWrite) => {
                socket.write(data, (error) => {
                  if (error) rejectWrite(error);
                  else resolveWrite();
                });
              }),
            onData: (listener) => {
              socket.on("data", (chunk: Buffer) => listener(chunk));
            },
            onClose: (listener) => {
              socket.on("close", () => listener());
            },
            close: () => {
              socket.destroy();
            },
          });
        });

        socket.on("error", (error) => {
          socket.destroy();
          if (!settled) {
            settled = true;
            reject(error);
          }
        });
      });
    },
  };
}
