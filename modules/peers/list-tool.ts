// peers_list 模型侧工具（工单 36）：列出本机（同一 agentDir）全部 pi 会话。
//
// 数据源纪律：工具输出与 `peers.discovery` 句柄快照出自同一份合并结果——execute 先走
// runtime 的异步 refresh（并发复用同一在途操作），再读同一快照，不自己另行扫描。
// 快照字段集沿用 api.ts 定义不扩张：短码派生、重码标注、「自己」标记与状态展示组合
// 都在本层用共享纯函数（shared/short-id、discovery 的 peerDisplayStatus）计算。
//
// 文案口径与 vision_query 相同：工具名、描述与模型可见的结果文本是稳定的协议文本
// （英文），不随界面语言变化；人类界面的工具显示名走三语键表（mod.ts 装配时解析）。

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { deriveSessionShortId } from "../../shared/short-id.ts";
import type { PeersDiscoverySnapshot, PeersSnapshotError } from "./api.ts";
import { peerDisplayStatus, type PeerDisplayStatus } from "./discovery.ts";

export interface PeersListToolDeps {
  /** 快照读出：与 peers.discovery 句柄同一 runtime 的 snapshot */
  readonly getSnapshot: () => PeersDiscoverySnapshot;
  /** 异步刷新（重扫描并刷新快照）；与句柄 refresh 同一在途复用操作 */
  readonly refresh: () => Promise<void>;
  /** 本实例 id（会话未绑定为 null），「自己」标记用 */
  readonly getInstanceId: () => string | null;
  /** 工具显示名（三语键表在装配时解析） */
  readonly label: string;
}

/** 一条列表输出的结构化视图（details 载荷与文本行的同一数据） */
export interface PeersListEntryView {
  readonly sessionId: string;
  readonly shortId: string | null;
  /** 离线条目为 null（无实例概念） */
  readonly instanceId: string | null;
  readonly status: PeerDisplayStatus;
  readonly name: string | null;
  readonly cwd: string | null;
  readonly sessionFile: string | null;
  /** 自己的会话（含同会话的其它实例） */
  readonly self: boolean;
  /** 正是本实例（自己会话中的当前实例） */
  readonly ownInstance: boolean;
  /** 短码在本次列表内命中多个会话 */
  readonly duplicateShortId: boolean;
  /** 该会话在活分区有多个实例并列 */
  readonly multipleInstances: boolean;
}

export interface PeersListOutput {
  readonly text: string;
  readonly entries: { online: readonly PeersListEntryView[]; offline: readonly PeersListEntryView[] };
  readonly truncated: boolean;
  readonly error: Pick<PeersSnapshotError, "kind" | "detail"> | null;
}

/** 「自己」身份：拿不到会话 id 或实例 id（如会话未绑定）时不标自己 */
export interface PeersSelfIdentity {
  readonly ownSessionId: string | null;
  readonly ownInstanceId: string | null;
}

function buildEntryViews(
  snapshot: PeersDiscoverySnapshot,
  identity: PeersSelfIdentity,
): { online: PeersListEntryView[]; offline: PeersListEntryView[] } {
  // 短码重码统计：同一短码（非 null）命中多个会话时全部标注（规格「短码性质」）
  const shortIdSessions = new Map<string, Set<string>>();
  const consider = (sessionId: string, shortId: string | null): void => {
    if (!shortId) return;
    const sessions = shortIdSessions.get(shortId) ?? new Set<string>();
    sessions.add(sessionId);
    shortIdSessions.set(shortId, sessions);
  };
  for (const entry of snapshot.online) consider(entry.sessionId, deriveSessionShortId(entry.sessionId));
  for (const entry of snapshot.offline) consider(entry.sessionId, deriveSessionShortId(entry.sessionId));
  const isDuplicate = (shortId: string | null): boolean =>
    shortId !== null && (shortIdSessions.get(shortId)?.size ?? 0) > 1;

  // 多实例标注统计：同一会话在活分区并列的实例数（规格：多实例条目带显式标注）
  const liveInstanceCounts = new Map<string, number>();
  for (const entry of snapshot.online) {
    liveInstanceCounts.set(entry.sessionId, (liveInstanceCounts.get(entry.sessionId) ?? 0) + 1);
  }

  const online = snapshot.online.map((entry) => {
    const shortId = deriveSessionShortId(entry.sessionId);
    const self = identity.ownSessionId !== null && entry.sessionId === identity.ownSessionId;
    return {
      sessionId: entry.sessionId,
      shortId,
      instanceId: entry.instanceId,
      status: peerDisplayStatus(entry.liveness, entry.activity),
      name: entry.name,
      cwd: entry.cwd,
      sessionFile: entry.sessionFile,
      self,
      ownInstance: self && identity.ownInstanceId !== null && entry.instanceId === identity.ownInstanceId,
      duplicateShortId: isDuplicate(shortId),
      multipleInstances: (liveInstanceCounts.get(entry.sessionId) ?? 0) > 1,
    };
  });
  const offline = snapshot.offline.map((entry) => {
    const shortId = deriveSessionShortId(entry.sessionId);
    return {
      sessionId: entry.sessionId,
      shortId,
      instanceId: null,
      status: "offline" as const,
      name: entry.name,
      cwd: entry.cwd,
      sessionFile: entry.sessionFile,
      self: identity.ownSessionId !== null && entry.sessionId === identity.ownSessionId,
      ownInstance: false,
      duplicateShortId: isDuplicate(shortId),
      multipleInstances: false,
    };
  });
  return { online, offline };
}

function formatEntryLine(entry: PeersListEntryView, truncated: boolean): string {
  // 会话文件为 null 分两种成因：真被删（missing）vs 落在截断后的扫描窗口外，措辞不撒谎
  const file = entry.sessionFile ?? (truncated ? "(not in scan window)" : "(session file missing)");
  const segments = [
    `short ${entry.shortId !== null ? `#${entry.shortId}` : "(none)"}`,
    `session ${entry.sessionId}`,
    entry.instanceId !== null ? `instance ${entry.instanceId}` : "instance (none)",
    `status ${entry.status}`,
    `name ${entry.name !== null && entry.name !== "" ? entry.name : "(none)"}`,
    `cwd ${entry.cwd !== null && entry.cwd !== "" ? entry.cwd : "(unknown)"}`,
    `file ${file}`,
  ];
  if (entry.ownInstance) segments.push("you");
  else if (entry.self) segments.push("you (another instance of this session)");
  if (entry.shortId === null) segments.push("no valid short id");
  if (entry.duplicateShortId) segments.push("duplicate short id");
  if (entry.multipleInstances) segments.push("multiple instances");
  return `• ${segments.join(" | ")}`;
}

/** 由快照构建列表输出：文本与 details 载荷同源，纯函数（不含扫描与刷新） */
export function buildPeersListOutput(snapshot: PeersDiscoverySnapshot, identity: PeersSelfIdentity): PeersListOutput {
  const { online, offline } = buildEntryViews(snapshot, identity);
  const lines: string[] = [];
  if (snapshot.error !== null) {
    lines.push(
      `PEER DISCOVERY PROBLEM (${snapshot.error.kind}): ${snapshot.error.detail} — the list below is the last successful scan and may be stale.`,
    );
  }
  if (online.length === 0 && offline.length === 0 && snapshot.error === null) {
    lines.push("No peer sessions found on this machine.");
  } else {
    lines.push(`ACTIVE SESSIONS (${online.length}):`);
    lines.push(...online.map((entry) => formatEntryLine(entry, snapshot.truncated)));
    lines.push(`OFFLINE SESSIONS (${offline.length}):`);
    lines.push(...offline.map((entry) => formatEntryLine(entry, snapshot.truncated)));
  }
  if (snapshot.truncated) {
    lines.push("LIST TRUNCATED: older entries are hidden (entry limit reached).");
  }
  return {
    text: lines.join("\n"),
    entries: { online, offline },
    truncated: snapshot.truncated,
    error: snapshot.error !== null ? { kind: snapshot.error.kind, detail: snapshot.error.detail } : null,
  };
}

export function registerPeersListTool(pi: ExtensionAPI, deps: PeersListToolDeps): void {
  pi.registerTool({
    name: "peers_list",
    label: deps.label,
    description:
      "List peer pi sessions on this machine (same agent directory). " +
      "Two sections: ACTIVE sessions (running instances, with liveness/activity status) and OFFLINE sessions (recently exited, discovered from session files). " +
      "Each entry carries: 6-char short id (like #62nvbt), full session id, instance id (empty for offline), name, working directory, session file path and status. " +
      "Entries are annotated for: yourself, multiple instances of one session, duplicate short ids, missing session files, and list truncation.",
    promptSnippet:
      "List local peer pi sessions (active/offline) with short id, session id, instance id, name, cwd, file path and status",
    parameters: Type.Object({}),

    async execute(
      _toolCallId: string,
      _params: Record<string, never>,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext | undefined,
    ): Promise<{
      content: { type: "text"; text: string }[];
      details: PeersListOutput;
    }> {
      // 与句柄同一数据源：先复用 runtime 的在途刷新，再读同一份快照，不另行扫描
      await deps.refresh();
      const snapshot = deps.getSnapshot();
      const ownSessionId = ctx?.sessionManager?.getSessionId?.() ?? null;
      const output = buildPeersListOutput(snapshot, {
        ownSessionId,
        ownInstanceId: deps.getInstanceId(),
      });
      return { content: [{ type: "text", text: output.text }], details: output };
    },
  });
}
