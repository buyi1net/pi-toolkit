// peers 端点适配器（工单 38）：Windows 命名管道 / Unix 域 socket 的真实本地端点。
//
// 职责边界（给工单 39 留的接缝，刻意做小）：只做监听、接受连接、增量解码、编码响应、
// 关闭；来源校验、去重、限流、入站拒收策略、消息注入全部不做。收到合法请求帧后回调
// onRequest 由它决定回执三态；回执帧的 messageId（回映请求）、协议版本、serverTime 由
// 本适配器补齐。合规发送方是一连接一请求一响应（sendPeersFrame 用完即关），单连接上
// 异步回执乱序不会被合规发送方观察到，这里不做回执排队。
//
// 权限口径（规格「安全与边界」：同机同用户信任域，不做加密与强认证）：
// - Unix：socket 文件 0600、所在目录 0700（新建即如此；已存在目录只收紧组/其它位，
//   不放松属主位）。真实跨用户验证（免密 sudo 降权 nobody 连接被拒）由测试在具备条件
//   的环境执行，不具备时等价验证止于权限位断言；
// - Windows：命名管道使用 Node 默认安全属性（创建进程令牌的默认 DACL，创建者用户为
//   属主）。Node 不暴露命名管道 DACL 定制，本包无法进一步收紧，也无法在本环境验证
//   跨用户被拒——如实声明，不伪造验证结果。
//
// 崩溃残留：
// - Windows：管道是内核对象，进程死亡即消失，无残留；
// - Unix：socket 文件会残留。bind 撞上 EADDRINUSE 时先试探连接分辨：被拒 = 陈旧可安全
//   unlink 后重试；能连上 = 活端点，报诊断不抢占。start 成功后顺带回收同目录下探活被拒
//   的其它残留 socket（判据只有 ECONNREFUSED / ENOENT——活端点即便事件循环阻塞，
//   内核 backlog 也会让 connect 排队而非拒绝，不会误删活端点）。
//
// 地址设计：地址含实例 id 保证唯一（一实例一端点）。Unix sockaddr 长度是内核硬限制
// （Linux 108 / macOS 104），agentDir 内路径容易超长，故落在 tmpdir 下的短目录（目录名
// 带 agentDir 哈希前缀，不同 agentDir 互不混放；tmpdir 为空时用固定名兜底）；文件名取
// 实例 id 规范化后的前 16 位十六进制（64 位随机，实例间碰撞概率可忽略；即便碰撞，
// 活端点探测会拒绝抢占并走诊断降级，不会错连）。超长路径（自定义 TMPDIR）按监听初始化
// 失败处理，给诊断不崩。

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

/** Windows 命名管道命名空间前缀（\\.\pipe\） */
const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\";

/** 实例 id 守卫：进入端点名 / socket 文件名的成分必须文件名安全且不过长（与 registry 同款约束） */
const ENDPOINT_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** Unix 残留 socket 文件名形状（本适配器创建的文件才参与回收，未知文件不动） */
const UNIX_SOCKET_FILE_PATTERN = /^s-[0-9a-f]{16}\.sock$/;

/** Unix 探活超时：连接挂起（如 backlog 排队）按占用处理，宁可漏删不误删 */
const UNIX_PROBE_TIMEOUT_MS = 300;

function errnoCode(error: unknown): string | undefined {
  return typeof (error as { code?: unknown } | null)?.code === "string"
    ? (error as { code: string }).code
    : undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Windows 命名管道全名：\\.\pipe\pi-toolkit-peers-<实例 id（去连字符）>；
 * 管道命名空间上限 256 字符，实例 id 守卫保证不超 */
export function peersWindowsPipeName(instanceId: string): string {
  return `${WINDOWS_PIPE_PREFIX}pi-toolkit-peers-${instanceId.replace(/-/g, "")}`;
}

/** Unix socket 目录：tmpdir 下的短目录（长度论证见文件头），目录名带 agentDir 哈希前缀；
 * tmpdir 为空时用固定名兜底（极端环境，路径已尽量短） */
export function peersUnixSocketDir(agentDir: string): string {
  const hash = createHash("sha256").update(agentDir).digest("hex").slice(0, 8);
  const parent = tmpdir() || ".";
  return join(parent, `pi-ptp-${hash}`);
}

/** Unix socket 路径：s-<实例 id 前 16 位十六进制>.sock（截断理由见文件头地址设计） */
export function peersUnixSocketAddress(agentDir: string, instanceId: string): string {
  return join(peersUnixSocketDir(agentDir), `s-${instanceId.replace(/-/g, "").slice(0, 16)}.sock`);
}

/** 端点回执：onRequest 对一帧请求的裁决（三态与原因码一致性由接线方保证——该接缝是
 * 模块内信任边界，线上解码侧仍会严格校验） */
export interface PeersEndpointReply {
  readonly result: PeersDeliveryResult;
  readonly reason: PeersReasonCode | null;
}

export type PeersEndpointRequestHandler = (
  request: PeersRequestFrame,
) => PeersEndpointReply | Promise<PeersEndpointReply>;

export interface PeersEndpointServerOptions {
  readonly agentDir: string;
  /** 本次会话运行的实例 id（注册主键成分，同时保证端点地址唯一） */
  readonly instanceId: string;
  /** 解码单帧上限来源（config.ts 结构化解析器产物），接受连接时读取、随 reload 生效 */
  readonly getSettings: () => Pick<PeersSettings, "maxFrameBytes">;
  readonly onRequest: PeersEndpointRequestHandler;
  /** 监听建立失败与监听期异常上报（进会话运行期诊断，区别于模块装配失败）。
   * 实现方不得抛出：该回调在监听期错误路径上调用，抛出会沿错误路径外溢 */
  readonly onError?: (detail: string) => void;
  readonly now?: () => number;
}

export interface PeersEndpointServer {
  /** 建立监听并回收同目录残留端点；resolve 端点地址（写入注册表 endpoint 字段），
   * 失败 reject 带诊断信息（降级路径：endpoint 保持 null，其余能力不受影响）。
   * 单次使用：一个 server 实例只允许 start 一次。 */
  start(): Promise<string>;
  /** 幂等释放：停监听、断开在连连接、（Unix）回收 socket 文件 */
  close(): void;
  /** 当前端点地址；未建立、已释放为 null */
  address(): string | null;
}

/** 把监听结果折成 Promise（listening / error 二选一） */
function listenNetServer(server: net.Server, address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", (error) => reject(error));
    server.listen(address);
  });
}

/** Unix 目录就位：懒建 0700；已存在时只收紧组/其它位（不放松属主位，也不覆盖更严权限） */
function ensureUnixSocketDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const mode = statSync(dir).mode & 0o777;
  if (mode & 0o077) chmodSync(dir, mode & 0o700);
}

type UnixProbeOutcome = "refused" | "occupied";

/** 试探一个 Unix socket 端点是否还活着：connect 成功 = 占用（活）；ECONNREFUSED / ENOENT
 * = 陈旧（无人监听）；其余错误与超时按占用处理（保守，不误删） */
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

/** 回收同目录下探活被拒的残留 socket（进程异常退出后的不永久占位）；尽力而为 */
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
    // Unix：关闭即回收自己的 socket 文件（幂等：文件已不在视为已清）
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
    socket.unref(); // 在连连接不阻止进程退出
    sockets.add(socket);
    // 配置读取同步抛错时连解码上限都没有：不给回执，降级为断开该连接并上报诊断；
    // 不让异常从 connection 回调冒泡成进程级 uncaughtException
    let maxFrameBytes: number;
    try {
      maxFrameBytes = options.getSettings().maxFrameBytes;
    } catch (error) {
      options.onError?.(`端点读取配置失败，断开连接：${describeError(error)}`);
      // 提前返回路径不注册下面的 close 监听：socket 不会自我移出集合，这里手工清，
      // 避免反复失败的连接在 teardown 前不断滞留 Socket 对象
      sockets.delete(socket);
      // destroy 后内核仍可能派发迟到的 error 事件：先挂空监听再断开，
      // 不让该 socket 的后续事件成为进程级未处理错误
      socket.on("error", () => {});
      socket.destroy();
      return;
    }
    const decoder = createPeersFrameDecoder({ maxFrameBytes });

    const send = (response: PeersResponseFrame): void => {
      const encoded = encodePeersFrame(response, { maxFrameBytes });
      // 回执帧远小于单帧上限，编码失败只在接线方给出畸形回执时发生：丢弃即可，
      // 发送方等不到响应会按写入超时兜底
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
          // onRequest 先入微任务再调用：处理器同步 throw 也折进 rejection 分支
          // （invalid-frame 错误回执 + onError 上报），不从 socket data 回调冒泡成
          // 进程级 uncaughtException（帧先赋值给常量：闭包内保持 request 窄化）
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
              // 处理器异常按协议错误回执并上报，不挂连接、不外溢
              errorReply(event.frame.messageId, "invalid-frame");
              options.onError?.(`端点请求处理异常（消息 id ${event.frame.messageId}）：${describeError(error)}`);
            },
          );
        } else {
          // 服务端只收请求帧：响应帧出现在入站方向按非法帧回执（messageId 可回映）
          errorReply(event.frame.messageId, "invalid-frame");
        }
        return;
      }
      // 拒绝事件：解析不出请求 id，回执带空 messageId——发送侧解码会按非法帧拒绝，
      // 与「非法帧 / 未知版本拒绝并返回协议错误原因码」的线协议语义一致
      errorReply("", event.reason);
      if (event.fatal) socket.destroy(); // 流位置不可知（超长声明 / 截断）：断开由对端重连
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
        // 残留判定：试探连接分辨陈旧 / 活端点（见文件头「崩溃残留」）
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
    // socket 文件权限收口到当前用户：bind 按进程 umask 创建（常见 022 下窗口内他人也无
    // 写权限），显式 0600 消除 umask 偏松环境下 bind→chmod 之间的短暂暴露。
    // chmod / 清扫发生在 currentAddress 赋值之前，抛错时 start() 失败分支的 teardown
    // 尚无地址可回收：这里先就地 unlink 已 bind 的 socket 文件（任何错误一律吞掉——
    // 文件可能已被并发清理）再原样重抛；关 server 仍由 start() 失败分支负责
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
            // 等待监听期间已被 close()：立即回收迟到建立的端点（含 Unix socket 文件）
            currentAddress = address;
            teardown();
            return address;
          }
          phase = "listening";
          currentAddress = address;
          // 监听建立后的意外错误（如 socket 文件被外部删除）：上报并停用。本实例地址
          // 不会被后续心跳改写，注册表恢复靠接线方收到 onError 后清空端点字段（本实例
          // 降级，发送方按 offline 降级），重建要等下一次 session_start
          server?.on("error", (error) => {
            options.onError?.(`端点监听异常（${address}）：${describeError(error)}`);
            teardown();
          });
          return address;
        },
        (error) => {
          // 启动中途失败：回收已建立一半的监听（如 chmod 阶段抛错），不留半初始化状态
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

/** 发送侧传输适配器：按注册表 endpoint 字段的地址建立连接。
 * 失败分类不在这里做——连接被拒、写入失败等一律原样 reject，由 protocol.ts 的
 * sendPeersFrame 统一映射原因码（连接被拒 → offline），适配器不另造错误分类。 */
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
        // 常驻错误监听：settle 之后连接半途损坏也走 destroy → close，不外溢崩溃
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
