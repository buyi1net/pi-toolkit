// peers 模块（会话发现与通讯）的静态导出面（工单 33 骨架）：
// 只放类型、常量与无状态纯函数；运行时能力（发现快照、刷新）走服务注册表句柄
// `peers.discovery`，句柄契约只有 snapshot / refresh 两个方法（ADR 0001 口径）。
//
// 术语口径（docs/GLOSSARY.md「会话发现与通讯」节）：本模块用「会话注册表 / 心跳维护器 /
// 实例」；与子代理模块的「运行态登记表 / watcher」是两套东西，互不依赖。

import { join } from "node:path";

/** 模块 id：同时是配置节名与菜单项 id 前缀 */
export const PEERS_MODULE_ID = "peers";

/** 只读发现句柄名：快照 = 会话清单（活/离线分区）+ 变更序号 + 错误状态 */
export const PEERS_DISCOVERY_SERVICE_NAME = "peers.discovery";

/** 活性：online=心跳在阈值内；stale=心跳超一拍未过清理阈值；offline=注册过期或纯磁盘会话 */
export type PeerLiveness = "online" | "stale" | "offline";

/** 活动状态：working/idle 由进程侧随心跳维护（规格「活性与状态」） */
export type PeerActivity = "working" | "idle";

/** 活分区条目：一个注册在册的运行中实例（同一会话多实例时各自一条） */
export interface PeerLiveEntry {
  readonly sessionId: string;
  readonly instanceId: string;
  /** 活跃会话名字以注册层为准；未登记为 null */
  readonly name: string | null;
  readonly cwd: string | null;
  /** 注册在而会话文件被删时为 null，条目仍保留（规格「合并规则」） */
  readonly sessionFile: string | null;
  readonly liveness: "online" | "stale";
  readonly activity: PeerActivity;
}

/** 离线分区条目：注册已过期的会话与纯磁盘会话，名字为尽力值 */
export interface PeerOfflineEntry {
  readonly sessionId: string;
  readonly name: string | null;
  readonly cwd: string | null;
  readonly sessionFile: string | null;
}

/** 一次扫描的产出（扫描接缝的返回形状；工单 36 接真实扫描与合并） */
export interface PeersScanResult {
  readonly online: readonly PeerLiveEntry[];
  readonly offline: readonly PeerOfflineEntry[];
  /** 列表超出条目上限被截断时为 true（规格「扫描策略」） */
  readonly truncated: boolean;
}

export type PeersScanFn = (request: { readonly now: number }) => Promise<PeersScanResult> | PeersScanResult;

/** 快照错误状态：非 null 表示当前清单不是一次成功扫描的产物（规格场景 16，不伪装成空清单） */
export interface PeersSnapshotError {
  readonly kind: "init-failed" | "scan-failed";
  readonly detail: string;
  readonly at: number;
}

/** 只读发现快照：会话清单（活/离线分区）+ 变更序号 + 错误状态 */
export interface PeersDiscoverySnapshot {
  readonly generatedAt: number;
  /** 内容变化序号（内容变才递增），供重绘节奏使用 */
  readonly revision: number;
  /** 活分区：注册在册的运行中实例 */
  readonly online: readonly PeerLiveEntry[];
  /** 离线分区：注册过期与纯磁盘会话 */
  readonly offline: readonly PeerOfflineEntry[];
  readonly truncated: boolean;
  readonly error: PeersSnapshotError | null;
}

/** 模块运行诊断：init=初始化失败或配置问题；runtime=运行期异常。与装配失败（assembler 的
 * module problem）是两条呈现路径。 */
export interface PeersDiagnostic {
  readonly kind: "init" | "runtime";
  readonly detail: string;
  readonly at: number;
}

/** 只读发现句柄（快照/刷新两个方法，不扩通知面） */
export interface PeersDiscoveryService {
  readonly id: "peers";
  snapshot(): PeersDiscoverySnapshot;
  /** 重新扫描并刷新快照；并发刷新复用同一在途操作 */
  refresh(): Promise<void>;
}

/** 阈值类数值参数（模块结构化配置；菜单 schema 不出现自由数值字段）。
 * 通讯侧阈值（工单 37）：单帧上限与连接/写入超时；去重窗口（工单 39）；
 * 大内容与限流防护阈值（工单 40）：转文件阈值、文件存活期、入站队列上限、
 * 每发送方速率窗口与读取上限。maxFrameBytes 按帧负载字节数计，不含 4 字节长度前缀
 * （与线协议同一口径）；largeContentThresholdBytes 与 maxInboundContentBytes 按 UTF-8
 * 字节数计（发送侧转文件与接收侧校验同一口径）。 */
export interface PeersSettings {
  readonly heartbeatIntervalMs: number;
  readonly staleAfterMs: number;
  readonly cleanupAfterMs: number;
  readonly listEntryLimit: number;
  readonly maxFrameBytes: number;
  readonly connectTimeoutMs: number;
  readonly writeTimeoutMs: number;
  /** 消息 id 去重窗口（工单 39）：窗口内重复 id 按「重复消息」幂等回执，不重复注入 */
  readonly dedupeWindowMs: number;
  /** 大内容转文件阈值（工单 40）：正文 UTF-8 字节数超过它即落共享区文件 */
  readonly largeContentThresholdBytes: number;
  /** 大内容文件存活期（工单 40）：超过后由心跳 tick 的清理回收，不无限沉积 */
  readonly fileTtlMs: number;
  /** 入站队列上限（工单 40）：已接受未走完注入接缝的帧数达到它即拒绝 queue-full */
  readonly inboundQueueLimit: number;
  /** 每发送方速率窗口上限（工单 40）：窗口内第 N 条起拒绝 rate-limited；环路防护共用同一上限 */
  readonly senderRateLimit: number;
  /** 速率窗口时长（工单 40）：滑动窗口，与 senderRateLimit 配套 */
  readonly rateWindowMs: number;
  /** 接收端读取上限（工单 40）：文件实际/声明字节数超过它即拒绝 content-too-large */
  readonly maxInboundContentBytes: number;
}

/** 规格默认参数：心跳 15s、stale 60s（4×心跳）、注册清理 5min、列表条目上限 200 条；
 * 单帧上限 64KB、连接/写入超时 2s / 5s（工单 37）；消息去重窗口 5min（工单 39）；
 * 转文件阈值 8KB、文件存活期 24h、入站队列上限 100 条、每发送方 10 条/分钟、
 * 读取上限 8MB（工单 40） */
export const DEFAULT_PEERS_SETTINGS: Readonly<PeersSettings> = Object.freeze({
  heartbeatIntervalMs: 15_000,
  staleAfterMs: 60_000,
  cleanupAfterMs: 300_000,
  listEntryLimit: 200,
  maxFrameBytes: 65_536,
  connectTimeoutMs: 2_000,
  writeTimeoutMs: 5_000,
  dedupeWindowMs: 300_000,
  largeContentThresholdBytes: 8_192,
  fileTtlMs: 86_400_000,
  inboundQueueLimit: 100,
  senderRateLimit: 10,
  rateWindowMs: 60_000,
  maxInboundContentBytes: 8_388_608,
});

/** 各阈值的合法闭区间（模块解析器按它校验，越界回退默认并记警告）。
 * 通讯侧下限：单帧上限 ≥ 16KB 保证装得下大内容转文件后的引用帧，连接超时 ≥ 0.5s、
 * 写入超时 ≥ 1s 避免本机正常调度被误判超时；三者无序约束。 */
export const PEERS_SETTINGS_RANGES: Readonly<
  Record<keyof PeersSettings, { readonly min: number; readonly max: number }>
> = Object.freeze({
  heartbeatIntervalMs: { min: 5_000, max: 60_000 },
  staleAfterMs: { min: 10_000, max: 300_000 },
  cleanupAfterMs: { min: 60_000, max: 3_600_000 },
  listEntryLimit: { min: 10, max: 1_000 },
  maxFrameBytes: { min: 16_384, max: 1_048_576 },
  connectTimeoutMs: { min: 500, max: 60_000 },
  writeTimeoutMs: { min: 1_000, max: 300_000 },
  // 去重窗口下限 1min：低于它会拒绝合法的重发确认（发送方等回执期间的重试）；
  // 上限 1h：窗口内的 id 记录常驻内存，过大浪费且无防护增益
  dedupeWindowMs: { min: 60_000, max: 3_600_000 },
  // 大内容与限流阈值（工单 40）：与心跳/清理序列无序约束，仅逐字段范围校验。
  // 转文件阈值下限 1KB（再小会让普通消息也走文件通道）；上限 64KB 与单帧上限默认同量级
  largeContentThresholdBytes: { min: 1_024, max: 65_536 },
  // 文件存活期 1min～7d：下限保证接收端（含重试）有窗口读取，上限防无限沉积
  fileTtlMs: { min: 60_000, max: 604_800_000 },
  inboundQueueLimit: { min: 1, max: 10_000 },
  senderRateLimit: { min: 1, max: 1_000 },
  // 速率窗口 1s～10min：过短形同虚设，过长会困住正常 bursts
  rateWindowMs: { min: 1_000, max: 600_000 },
  // 读取上限 64KB～256MB：下限不小于单帧上限的默认值，上限防读爆内存
  maxInboundContentBytes: { min: 65_536, max: 268_435_456 },
});

/** peers 共享区：每实例一个注册文件的目录（工单 34 的会话注册表落在这里） */
export function peersSharedDir(agentDir: string): string {
  return join(agentDir, "cache", "pi-toolkit", "peers");
}
