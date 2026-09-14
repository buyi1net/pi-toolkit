// peers 发现合并（工单 36）：把注册层（活跃实例）与磁盘层（会话文件树）合并成
// 快照的活/离线分区。合并口径写成可独立测试的纯函数 collectPeerSessionCandidates
// （磁盘去重 + 活实例归组，无截断无排序）——工单 39 的寻址直接复用同一候选集：
// 扫描层只贡献「该会话没有活跃实例」的条目、按会话 id 去重（规格「寻址」），
// 列表特有的截断与排序留在 mergePeerDiscovery 内，寻址不经由它。
//
// 合并规则（规格「合并规则」）：
// - 同一会话有活跃实例（online / stale）时，注册层的状态、名字、cwd 覆盖磁盘层；
// - 同一会话多个活跃实例全部列出，各自带实例 id；
// - 注册在而会话文件缺失（被删）时仍列活跃实例，sessionFile 置 null（展示层标注）；
// - 磁盘层同一会话 id 重复出现时取最新路径：mtime 新者胜，同时戳取路径字典序更大者（可复现）；
// - 注册已过期（offline）的实例不进活分区，其会话文件落离线分区；注册过期且文件也没了则不列。
//
// 状态展示组合（规格「活性与状态」）：online+working → 工作中、online+idle → 空闲、
// stale → 响应迟缓、offline → 离线。快照存原始两套状态，组合在展示层（工具输出）做。

import type { PeerActivity, PeerLiveEntry, PeerLiveness, PeerOfflineEntry, PeersScanResult } from "./api.ts";
import type { PeerRegistration, PeerRegistrationRead } from "./registry.ts";
import type { PeersDiskSession } from "./scan.ts";

/** 展示组合状态：工作中 / 空闲 / 响应迟缓 / 离线（文案在展示层本地化） */
export type PeerDisplayStatus = "working" | "idle" | "sluggish" | "offline";

/** 活性与活动状态 → 展示组合：stale 与 offline 不看活动状态（迟缓/离线优先于工作口径） */
export function peerDisplayStatus(liveness: PeerLiveness, activity: PeerActivity): PeerDisplayStatus {
  if (liveness === "offline") return "offline";
  if (liveness === "stale") return "sluggish";
  return activity;
}

/** 磁盘层输入：扫描输出（会话清单 + 截断标记） */
export interface PeersDiscoveryMergeDiskInput {
  readonly sessions: readonly PeersDiskSession[];
  readonly truncated: boolean;
}

export interface PeersDiscoveryMergeInput {
  /** 注册层读取结果（readPeerRegistrations 的产出，活性已按双阈值判定） */
  readonly registrations: readonly PeerRegistrationRead[];
  readonly disk: PeersDiscoveryMergeDiskInput;
  /** 列表条目上限：活实例优先保留，离线按剩余名额截断 */
  readonly limit: number;
}

/** 磁盘层同会话去重的取胜判定：mtime 更新者胜；同时戳取路径字典序更大者 */
function winsDiskDedup(candidate: PeersDiskSession, incumbent: PeersDiskSession): boolean {
  if (candidate.modifiedAt !== incumbent.modifiedAt) return candidate.modifiedAt > incumbent.modifiedAt;
  return candidate.sessionFile > incumbent.sessionFile;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** 候选集里一个活实例（online / stale）：寻址取端点与展示权威字段用 */
export interface PeerLiveCandidate {
  readonly registration: PeerRegistration;
  readonly liveness: "online" | "stale";
}

/** 一个会话的候选视图：活实例组 + 该会话最新的磁盘条目（可能没有文件） */
export interface PeerSessionCandidate {
  readonly sessionId: string;
  /** 注册层活实例（online/stale），保持注册读取顺序，不做展示排序 */
  readonly live: readonly PeerLiveCandidate[];
  /** 磁盘层同会话 id 去重后的最新条目；无文件（被删或纯注册）为 null */
  readonly newestDisk: PeersDiskSession | null;
}

/**
 * 会话候选集（合并规则同口径，工单 36 列表与工单 39 寻址共用的唯一实现）：
 * - 磁盘层按会话 id 去重，保留最新路径（异常重复时按修改时间取新）；
 * - 注册层只贡献活实例（online / stale），过期注册不进候选；
 * - 不做列表条目上限与展示排序——那是列表合并器（mergePeerDiscovery）的职责，
 *   寻址按规格要求不经合并器的截断与排序。
 */
export function collectPeerSessionCandidates(input: {
  readonly registrations: readonly PeerRegistrationRead[];
  readonly disk: readonly PeersDiskSession[];
}): ReadonlyMap<string, PeerSessionCandidate> {
  const newestDisk = new Map<string, PeersDiskSession>();
  for (const session of input.disk) {
    const incumbent = newestDisk.get(session.sessionId);
    if (incumbent === undefined || winsDiskDedup(session, incumbent)) {
      newestDisk.set(session.sessionId, session);
    }
  }
  const bySession = new Map<string, PeerSessionCandidate>();
  for (const [sessionId, disk] of newestDisk) {
    bySession.set(sessionId, { sessionId, live: [], newestDisk: disk });
  }
  for (const read of input.registrations) {
    if (read.liveness === "offline") continue;
    const existing = bySession.get(read.registration.sessionId);
    const candidate: PeerLiveCandidate = { registration: read.registration, liveness: read.liveness };
    if (existing) bySession.set(read.registration.sessionId, { ...existing, live: [...existing.live, candidate] });
    else bySession.set(read.registration.sessionId, { sessionId: read.registration.sessionId, live: [candidate], newestDisk: null });
  }
  return bySession;
}

export function mergePeerDiscovery(input: PeersDiscoveryMergeInput): PeersScanResult {
  const candidates = collectPeerSessionCandidates({ registrations: input.registrations, disk: input.disk.sessions });

  // 活分区：每个活跃实例一条（同一会话多实例并列），注册层信息覆盖磁盘层；
  // 心跳新者在前，同时刻按会话 id、实例 id 字典序（readdir 顺序不入结果）
  const live = [...candidates.values()].flatMap((candidate) => candidate.live);
  live.sort(
    (a, b) =>
      b.registration.heartbeatAt - a.registration.heartbeatAt ||
      compareText(a.registration.sessionId, b.registration.sessionId) ||
      compareText(a.registration.instanceId, b.registration.instanceId),
  );
  const online: PeerLiveEntry[] = live.map((read) => ({
    sessionId: read.registration.sessionId,
    instanceId: read.registration.instanceId,
    name: read.registration.name,
    cwd: read.registration.cwd,
    sessionFile: candidates.get(read.registration.sessionId)?.newestDisk?.sessionFile ?? null,
    liveness: read.liveness,
    activity: read.registration.activity,
  }));

  // 离线分区：没有活跃实例的会话（含注册已过期的），最新在前
  const offlineCandidates: PeerOfflineEntry[] = [...candidates.values()]
    .filter((candidate) => candidate.live.length === 0 && candidate.newestDisk !== null)
    .map(({ newestDisk }) => newestDisk as PeersDiskSession)
    .sort((a, b) => (winsDiskDedup(a, b) ? -1 : winsDiskDedup(b, a) ? 1 : 0))
    .map((session) => ({
      sessionId: session.sessionId,
      name: session.name,
      cwd: session.cwd,
      sessionFile: session.sessionFile,
    }));

  // 条目上限：活实例优先，离线吃剩余名额；按候选总数（含被裁掉的活实例）判截断，
  // 磁盘层已截断也透传标记
  const keepOnline = online.slice(0, input.limit);
  const offline = offlineCandidates.slice(0, Math.max(0, input.limit - keepOnline.length));
  const truncated = input.disk.truncated || online.length + offlineCandidates.length > input.limit;
  return { online: keepOnline, offline, truncated };
}
