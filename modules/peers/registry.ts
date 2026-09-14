// peers 会话注册表与心跳维护器（工单 35）：每实例一个注册文件的写入、读取与保守清理。
//
// 注册表口径（docs/GLOSSARY.md）：注册主键 = 「会话 id + 实例 id」，实例 id 为本次会话运行
// 随机生成的高熵标识（同一会话被旧进程僵死时 resume，新进程是新实例、各写各的文件，
// 互不覆盖）。文件落在 peersSharedDir(agentDir)，写者唯一（无跨进程同文件写竞争），
// 原子落盘（临时文件 + rename），目录 0700 / 文件 0600 限定当前用户（POSIX 语义；
// Windows 无强制权限位，实际依赖用户 profile 目录的 ACL）。
//
// 心跳维护器是注册表在本进程内的唯一写者：会话启动建立注册（活动状态空闲初值）、
// 按心跳间隔整文件重写心跳时间、宿主事件驱动活动状态（agent_start → working；
// agent_settled → idle）、会话结束幂等删除自己的注册文件。
//
// 过期清理（规格「过期清理」：保守双阈值 + 自愈）：
// - 心跳年龄 ≤ staleAfterMs 判 online、≤ cleanupAfterMs 判 stale（响应迟缓）、超过判 offline；
// - 超过清理阈值的他人注册只删「连续两轮观察内容未变」的（心跳停止远超阈值且无人再写）；
// - 解析不了的文件一律不删（可能是其它版本写者或落盘中的文件）；
// - 被误删的存活实例在下一次心跳重写时自愈重建（心跳写入永远是整文件重写）。

import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Dirent,
  type Stats,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { peersSharedDir, type PeerActivity, type PeerLiveness, type PeersSettings } from "./api.ts";

/** 注册文件格式版本；读取时版本不符按不可解析跳过（保守，不删） */
const REGISTRATION_VERSION = 1;

/** 注册文件内容：一个运行中实例的注册信息。端点地址字段本单建立，取值由工单 38 写入。 */
export interface PeerRegistration {
  readonly sessionId: string;
  readonly instanceId: string;
  readonly name: string | null;
  readonly cwd: string | null;
  readonly pid: number;
  readonly activity: PeerActivity;
  /** 最近一次心跳时间（epoch ms） */
  readonly heartbeatAt: number;
  /** 端点地址（命名管道 / 域 socket 路径）；监听建立前为 null */
  readonly endpoint: string | null;
}

/** 注册文件名成分的字符集：防路径分隔符等混入文件名（端点接入前的稳定性守卫） */
const FILE_NAME_SAFE_PATTERN = /^[A-Za-z0-9._-]+$/;

/** 注册文件名 = 会话 id + 实例 id（注册主键），同会话多实例天然不同名。
 * 两个 id 都只允许文件名安全字符（宿主会话 id 是 UUID、实例 id 是 randomUUID，
 * 正常都在集合内）；异常输入在这里立即拒绝，而不是落成一个意外的文件路径。 */
export function peerRegistrationFileName(sessionId: string, instanceId: string): string {
  if (!FILE_NAME_SAFE_PATTERN.test(sessionId)) {
    throw new Error(`会话 id 含文件名不安全字符：${JSON.stringify(sessionId)}`);
  }
  if (!FILE_NAME_SAFE_PATTERN.test(instanceId)) {
    throw new Error(`实例 id 含文件名不安全字符：${JSON.stringify(instanceId)}`);
  }
  return `${sessionId}.${instanceId}.json`;
}

/** 注册文件落点：peers 共享区内 */
export function peerRegistrationFile(agentDir: string, sessionId: string, instanceId: string): string {
  return join(peersSharedDir(agentDir), peerRegistrationFileName(sessionId, instanceId));
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** 严格校验并规范化注册内容；任何字段不符返回 null（读取方按不可解析跳过） */
function validateRegistration(value: unknown): PeerRegistration | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (raw.version !== REGISTRATION_VERSION) return null;
  if (typeof raw.sessionId !== "string" || raw.sessionId === "") return null;
  if (typeof raw.instanceId !== "string" || raw.instanceId === "") return null;
  if (typeof raw.pid !== "number" || !Number.isInteger(raw.pid)) return null;
  if (raw.activity !== "working" && raw.activity !== "idle") return null;
  if (typeof raw.heartbeatAt !== "number" || !Number.isFinite(raw.heartbeatAt)) return null;
  return {
    sessionId: raw.sessionId,
    instanceId: raw.instanceId,
    name: optionalString(raw.name),
    cwd: optionalString(raw.cwd),
    pid: raw.pid,
    activity: raw.activity,
    heartbeatAt: raw.heartbeatAt,
    endpoint: optionalString(raw.endpoint),
  };
}

function errnoCode(error: unknown): string | undefined {
  return typeof (error as { code?: unknown } | null)?.code === "string"
    ? (error as { code: string }).code
    : undefined;
}

/** 原子写注册文件：临时文件 + rename；共享区目录懒建（0700 限定当前用户） */
export function writePeerRegistration(file: string, registration: PeerRegistration): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tempFile = join(dir, `.${basename(file)}.${process.pid}.tmp`);
  try {
    writeFileSync(tempFile, `${JSON.stringify({ version: REGISTRATION_VERSION, ...registration })}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(tempFile, file);
  } catch (error) {
    try {
      unlinkSync(tempFile);
    } catch {
      // 临时文件清理尽力而为，保留原写入失败
    }
    throw error;
  }
}

/** 读单个注册文件；读不了或校验不过返回 null（IO 竞争、损坏、版本不符） */
function readRegistrationFile(file: string): PeerRegistration | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  return validateRegistration(parsed);
}

/**
 * 按心跳年龄判活性：≤stale 判 online、≤cleanup 判 stale（响应迟缓）、超过判 offline。
 * 心跳时间在未来（对端时钟超前）按 online 处理（保守，不推测为过期）。
 */
export function peerRegistrationLiveness(ageMs: number, settings: PeersSettings): PeerLiveness {
  if (ageMs <= settings.staleAfterMs) return "online";
  if (ageMs <= settings.cleanupAfterMs) return "stale";
  return "offline";
}

/** 一条注册的读取结果：内容 + 按双阈值判定的活性 */
export interface PeerRegistrationRead {
  readonly file: string;
  readonly registration: PeerRegistration;
  readonly liveness: PeerLiveness;
}

export interface PeerRegistrationReadStats {
  readonly registrations: readonly PeerRegistrationRead[];
  /** 解析失败被跳过的候选文件数（损坏、版本不符、IO 竞争） */
  readonly skipped: number;
}

/**
 * 读出共享区全部注册文件（发现合并层的读接口，工单 36 消费）。逐文件独立尽力而为：
 * 损坏 / 版本不符跳过并计数；共享区缺失或祖先路径被文件占用（Windows 报 ENOENT、
 * POSIX 报 ENOTDIR）视为空清单（无物可读），其它目录级错误上抛由调用方进诊断。
 */
export function readPeerRegistrations(
  agentDir: string,
  request: { readonly now: number; readonly settings: PeersSettings },
): PeerRegistrationReadStats {
  const dir = peersSharedDir(agentDir);
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      // 共享区不可用（还没建，或祖先路径被文件占用：Windows 报 ENOENT、POSIX 报 ENOTDIR）：
      // 与心跳清理 sweep() 同口径按空清单处理；其它错误仍上抛由调用方进诊断
      return { registrations: [], skipped: 0 };
    }
    throw error;
  }
  const registrations: PeerRegistrationRead[] = [];
  let skipped = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".json")) continue;
    const file = join(dir, entry.name);
    const registration = readRegistrationFile(file);
    if (!registration) {
      skipped += 1;
      continue;
    }
    registrations.push({
      file,
      registration,
      liveness: peerRegistrationLiveness(request.now - registration.heartbeatAt, request.settings),
    });
  }
  return { registrations, skipped };
}

/** 心跳循环的定时器句柄 */
export interface PeerHeartbeatTimer {
  clear(): void;
}

/** 定时器接缝：默认 setInterval + unref；测试注入假调度器推进时钟 */
export type PeerHeartbeatScheduler = (callback: () => void, intervalMs: number) => PeerHeartbeatTimer;

/** 默认调度器：unref 保证心跳循环不阻止进程退出 */
export function defaultPeerHeartbeatScheduler(
  callback: () => void,
  intervalMs: number,
): PeerHeartbeatTimer {
  const timer = setInterval(callback, intervalMs);
  timer.unref();
  return {
    clear() {
      clearInterval(timer);
    },
  };
}

/** 会话启动时交给心跳维护器的身份（来自宿主 session_start 的 ctx） */
export interface PeerSessionIdentity {
  readonly sessionId: string;
  readonly name: string | null;
  readonly cwd: string | null;
}

/** 当前实例的完整身份（注册写入的全部成分）；发送方（工单 39）自报与自投递判定用 */
export interface PeerInstanceIdentity extends PeerSessionIdentity {
  readonly instanceId: string;
}

export interface HeartbeatMaintainerOptions {
  readonly agentDir: string;
  /** 阈值来源（config.ts 结构化解析器的产物）；start 时读取一次，配置变更随 reload 重建生效 */
  readonly getSettings: () => PeersSettings;
  readonly now?: () => number;
  readonly schedule?: PeerHeartbeatScheduler;
  /** 实例 id 生成接缝（测试固定用） */
  readonly generateInstanceId?: () => string;
  /** 写入/清理异常上报；同文不重复报（心跳 15s 一轮，失败不刷屏诊断） */
  readonly onError?: (detail: string) => void;
  /** 每轮心跳 tick 附带执行的维护任务（工单 40：大内容文件 TTL 清理等幂等任务）。
   * 在心跳回调里同步执行，不新起独立定时器；抛错按 onError 上报，不中断心跳循环。
   * 每次执行时自行读取当前阈值（随 reload 生效）。 */
  readonly onTick?: () => void;
}

/** 心跳维护器：注册写入、心跳刷新、活动状态维护与保守清理的循环组件 */
export interface HeartbeatMaintainer {
  /** 会话启动：建立注册（活动状态空闲初值）并启动心跳循环；重复 start 先清场 */
  start(identity: PeerSessionIdentity): void;
  /** 活动状态切换（agent_start → working；agent_settled → idle），切换立即补写一次 */
  setActivity(activity: PeerActivity): void;
  /** 会话名变化（session_info_changed）时更新注册 */
  setName(name: string | null): void;
  /** 端点地址（工单 38 建立监听后写入，拆除时回 null） */
  setEndpoint(endpoint: string | null): void;
  /** 会话结束：停心跳、幂等删除自己的注册文件；之后可再次 start（新实例） */
  stop(): void;
  /** 当前实例 id（未运行为 null）；供后续工单自我寻址与自投递判定 */
  instanceId(): string | null;
  /** 当前实例完整身份（sessionId/instanceId/名字/cwd，未运行为 null）；发送方自报字段源 */
  identity(): PeerInstanceIdentity | null;
}

export function createHeartbeatMaintainer(options: HeartbeatMaintainerOptions): HeartbeatMaintainer {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? defaultPeerHeartbeatScheduler;
  const generateInstanceId = options.generateInstanceId ?? randomUUID;

  let identity: PeerSessionIdentity | undefined;
  let instanceId: string | undefined;
  let name: string | null = null;
  let endpoint: string | null = null;
  let activity: PeerActivity = "idle";
  let ownFile: string | undefined;
  let timer: PeerHeartbeatTimer | undefined;
  let settings: PeersSettings | undefined;
  /** 清理候选指纹（文件路径 → mtime|size|心跳时间）：连续两轮一致才删 */
  const cleanupCandidates = new Map<string, string>();
  let lastErrorDetail: string | undefined;

  const reportError = (error: unknown): void => {
    const detail = error instanceof Error ? error.message : String(error);
    if (detail === lastErrorDetail) return;
    lastErrorDetail = detail;
    options.onError?.(detail);
  };

  /** 整文件重写心跳（含共享区懒建）：注册文件被误删时，本方法在下一轮自愈重建 */
  const writeHeartbeat = (): void => {
    if (!identity || !instanceId || !ownFile) return;
    writePeerRegistration(ownFile, {
      sessionId: identity.sessionId,
      instanceId,
      name,
      cwd: identity.cwd,
      pid: process.pid,
      activity,
      heartbeatAt: now(),
      endpoint,
    });
  };

  const safeHeartbeat = (): void => {
    try {
      writeHeartbeat();
    } catch (error) {
      reportError(error);
    }
  };

  /** 附带维护任务（工单 40 的 TTL 清理等）：失败上报不外溢——定时器回调里抛错会变成
   * 进程级 uncaughtException */
  const safeOnTick = (): void => {
    if (options.onTick === undefined) return;
    try {
      options.onTick();
    } catch (error) {
      reportError(error);
    }
  };

  /** 保守清理一轮：只删「心跳停止远超清理阈值且连续两轮内容未变」的他人注册文件 */
  const sweep = (): void => {
    if (!settings) return;
    const dir = peersSharedDir(options.agentDir);
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      const code = errnoCode(error);
      if (code === "ENOENT" || code === "ENOTDIR") {
        // 共享区不可用（还没建，或祖先路径被占用：Windows 报 ENOENT、POSIX 报 ENOTDIR）：
        // 无物可清；写入侧的失败已经自己的路径上报，这里不重复报
        cleanupCandidates.clear();
        return;
      }
      reportError(error);
      return;
    }
    const nowMs = now();
    const seen = new Set<string>();
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".json")) continue;
      const file = join(dir, entry.name);
      seen.add(file);
      if (file === ownFile) continue; // 自己的注册靠心跳保活，不参与清理
      let fingerprintStat: Stats;
      try {
        fingerprintStat = statSync(file);
      } catch {
        continue; // 扫描期间竞争消失：下一轮自然不见
      }
      const registration = readRegistrationFile(file);
      if (!registration) continue; // 解析不了：保守不删（他版写者 / 落盘中）
      if (nowMs - registration.heartbeatAt <= settings.cleanupAfterMs) {
        cleanupCandidates.delete(file); // 心跳还在：撤销清理候选
        continue;
      }
      const fingerprint = `${fingerprintStat.mtimeMs}|${fingerprintStat.size}|${registration.heartbeatAt}`;
      if (cleanupCandidates.get(file) === fingerprint) {
        try {
          unlinkSync(file);
          cleanupCandidates.delete(file);
        } catch (error) {
          if (errnoCode(error) === "ENOENT") {
            cleanupCandidates.delete(file); // 别人先删了：竞争正常
          } else {
            reportError(error); // 占用/权限：留候选下一轮重试
          }
        }
      } else {
        // 首次观察到超阈值：记指纹不删，下一轮内容仍未变才删
        cleanupCandidates.set(file, fingerprint);
      }
    }
    // 修剪：本轮没见到的文件（已被别人删除）移出候选表
    for (const file of cleanupCandidates.keys()) {
      if (!seen.has(file)) cleanupCandidates.delete(file);
    }
  };

  const stopInternally = (): void => {
    if (timer) {
      timer.clear();
      timer = undefined;
    }
    if (ownFile) {
      try {
        unlinkSync(ownFile);
      } catch (error) {
        // 会话结束清理幂等：文件已不在（被清理机制或竞争删除）不报错
        if (errnoCode(error) !== "ENOENT") reportError(error);
      }
    }
    identity = undefined;
    instanceId = undefined;
    ownFile = undefined;
    settings = undefined;
    activity = "idle";
    endpoint = null;
    name = null;
    cleanupCandidates.clear();
  };

  return {
    start(nextIdentity: PeerSessionIdentity): void {
      stopInternally();
      try {
        identity = nextIdentity;
        name = nextIdentity.name;
        instanceId = generateInstanceId();
        ownFile = peerRegistrationFile(options.agentDir, nextIdentity.sessionId, instanceId);
        // 会话启动 → 空闲初值；端点归零（新实例，监听由工单 38 重新建立）
        activity = "idle";
        endpoint = null;
        settings = options.getSettings();
        safeHeartbeat();
        timer = schedule(() => {
          safeHeartbeat();
          sweep();
          safeOnTick();
        }, settings.heartbeatIntervalMs);
      } catch (startError) {
        // 建立失败（如文件名守卫拒绝）：回到干净的停止态并上报，不让半初始化状态留在场
        stopInternally();
        reportError(startError);
      }
    },

    setActivity(next: PeerActivity): void {
      if (!identity || activity === next) return;
      activity = next;
      // 随心跳写入之外，切换时立即补写一次让状态尽快可见（写者唯一，原子落盘）
      safeHeartbeat();
    },

    setName(next: string | null): void {
      if (!identity || name === next) return;
      name = next;
      safeHeartbeat();
    },

    setEndpoint(next: string | null): void {
      if (!identity || endpoint === next) return;
      endpoint = next;
      safeHeartbeat();
    },

    stop(): void {
      stopInternally();
    },

    instanceId(): string | null {
      return instanceId ?? null;
    },

    identity(): PeerInstanceIdentity | null {
      if (!identity || !instanceId) return null;
      return { sessionId: identity.sessionId, name, cwd: identity.cwd, instanceId };
    },
  };
}
