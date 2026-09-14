// 后代运行行（工单 43）：从第一层子代理的会话工件目录只读递归读取孙代理
// 及更深后代的运行态，与第一层内存运行态合并成 widget 快照。
//
// 只读纪律：本模块绝不写入、删除或移动任何文件；行消失是纯展示过滤，
// 磁盘清理责任仍在写方（子会话进程的 watcher / retention）。
//
// 数据缺失二分（方案「边界规则」）：登记记录损坏（schema 过滤掉）→ 跳过
// 该行，不造行、不报错；活动快照缺失/invalid/wrong-id → 保留该行并走既有
// 状态机（starting → 60s 后 stalled 诚实降级，工单 30 语义），且不作为
// 死亡证据。行消失证据只有：记录被写方移除、活动终态超出 15s 宽限、
// headless 记录 pid 探活确认死亡（pane 无 pid 证据则保留，不推测）。

import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { debugLog } from "./diagnostics.ts";
import {
  activityDisplayLabel,
  getSubagentActivityFile,
  isTerminalDoneActivity,
  readSubagentActivityFile,
  type ActivityReadResult,
} from "./activity.ts";
import { isPidAlive, parseHeadlessSurface } from "./headless.ts";
import { createSessionFileLivenessProbe } from "./liveness.ts";
import { readRuntimeRecords, runtimeRegistryPath, type RuntimeRecord } from "./runtime-registry.ts";
import { getSessionId, readNameRegistry, type NameRegistry } from "./session.ts";
import {
  advanceStatusState,
  classifyStatus,
  createStatusState,
  observeStatus,
  type StatusLivenessEvidence,
  type StatusSnapshot,
  type SubagentStatusKind,
  type SubagentStatusState,
} from "./status.ts";
import type { RunningSubagent } from "./types.ts";

/** widget 代理数据行预算（不含顶底边框与折叠提示行；编辑区优先）。 */
export const SUBAGENT_WIDGET_ROW_BUDGET = 6;
/**
 * 递归深度上限：任意层级都可见（缩进在渲染层封顶），这里只防御病态长链
 * 把单 tick 的遍历拖爆；真环由每 tick 的 scheduled 去重 + 待扫队列按目录
 * 去重兑住（环只会在 tick 间轮转，不会在单 tick 内无限展开）。
 */
const MAX_DESCENT_DEPTH = 8;
/**
 * 每 tick 最多处理的子会话工件目录数（第一层 + 嵌套合计，即 processDir
 * 调用数的硬上界，深层大树也不足以拖爆 1s tick）。超出的候选按两级配额
 * 轮转到后续 tick，不静默丢。
 */
const DIRS_PER_TICK = 16;
/** 指纹缓存的周期性强读间隔（tick）：兜住同尺寸同时间戳的写入漏检。 */
const FORCE_REREAD_TICKS = 60;
/** 孤儿行展示 TTL：只隐藏展示行，不删登记表、不消费 .exit、不动任何文件。 */
export const ORPHAN_ROW_TTL_MS = 30 * 60_000;

// ── 合并快照的对外形状 ────────────────────────────────────────────

/** 一行可渲染的运行行（第一层或任意深度后代）。 */
export interface WidgetRow {
  key: string;
  name: string;
  agent?: string;
  /** 0 = 第一层；1+ = 后代深度（孙代理为 1）。 */
  depth: number;
  /** 直接父代理名（遍历上下文）；第一层为 null。 */
  via: string | null;
  /** 父行已消失（或父链接不可达）的后代行。 */
  orphan: boolean;
  startTime: number;
  snapshot: StatusSnapshot;
  /** 仅第一层行有值；RuntimeRecord 无 model/thinking 字段（明确非目标）。 */
  model: string | null;
  thinking: string | null;
  /** 各层祖先是否为其父的末子（渲染树形续行用）；长度 = depth - 1。 */
  lastFlags: readonly boolean[];
  /** 自身是否兄弟组末子。 */
  isLast: boolean;
  /** 组尾折叠提示行数（被折叠子树在组尾显示 `└─ … +N more`）；渲染 chrome。 */
  collapseAfter: number | null;
}

export interface WidgetCounts {
  /** 全部运行行（含被折叠项）——顶栏 `N running` 的口径。 */
  allCount: number;
  visibleRows: number;
  /** 可见组内被折叠的后代行合计（组尾折叠提示逐组显示）。 */
  subtreeOverflow: number;
  /** 因全局预算被折叠的行数（顶层父行超额时连同其子树计入）。 */
  globalOverflow: number;
}

export interface WidgetSnapshot {
  /** 可见行（DFS 序）。 */
  rows: WidgetRow[];
  counts: WidgetCounts;
}

/** layoutWidgetTree 的输入行：树拓扑 + 紧迫度来源 + 渲染数据。 */
export interface TreeRowInput {
  key: string;
  name: string;
  agent?: string;
  depth: number;
  via: string | null;
  orphan: boolean;
  startTime: number;
  parentKey: string | null;
  snapshot: StatusSnapshot;
  model?: string | null;
  thinking?: string | null;
}

/** 紧迫度全序：stalled > waiting > active/running/stale 档 > starting；同档按 DFS 行序。 */
const URGENCY: Record<SubagentStatusKind, number> = {
  stalled: 4,
  waiting: 3,
  active: 2,
  running: 2,
  // 工单 45：stale 档是「信息陈旧、死活未知」——与 active 同档不作警示升级。
  stale: 2,
  "stale-tool": 2,
  starting: 1,
};

interface TreeNode {
  input: TreeRowInput;
  order: number;
  children: TreeNode[];
  lastFlags: boolean[];
  isLast: boolean;
  /** 顶层行（无父或父缺失被提升）：分组边界。 */
  isRoot: boolean;
}

/**
 * 树装配 + 行数预算选择（纯函数，无磁盘 IO）。
 *
 * 规则（方案「渲染面」）：DFS 行序；祖先链必留——被保留的后代行其祖先
 * 链不可断；顶层父行参与预算选择，超出的连同子树计入 globalOverflow；
 * 可见组内被折叠的后代在组尾显示 `└─ … +N more`。
 */
export function layoutWidgetTree(inputs: readonly TreeRowInput[]): WidgetSnapshot {
  const byKey = new Map<string, TreeRowInput>();
  for (const input of inputs) byKey.set(input.key, input);

  // 父行缺失的行提升为顶层（父行已消失的后代按孤儿形态展示）。
  const childrenOf = new Map<string, TreeRowInput[]>();
  const roots: TreeRowInput[] = [];
  for (const item of inputs) {
    let input = item;
    if (input.parentKey != null && byKey.has(input.parentKey)) {
      const siblings = childrenOf.get(input.parentKey) ?? [];
      siblings.push(input);
      childrenOf.set(input.parentKey, siblings);
      continue;
    }
    if (input.parentKey != null) input = { ...input, orphan: true };
    roots.push(input);
  }

  // DFS：父行后紧跟其子树；沿途记录各层末子标记供渲染续行（长度 = depth - 1，
  // 不含顶层根的标记——它不是任何续行的上下文）。
  const nodes: TreeNode[] = [];
  let order = 0;
  const walk = (input: TreeRowInput, lastFlags: boolean[], isLast: boolean, isRoot: boolean): void => {
    const node: TreeNode = { input, order: order++, children: [], lastFlags, isLast, isRoot };
    nodes.push(node);
    const children = childrenOf.get(input.key) ?? [];
    children.forEach((child, index) => {
      walk(child, input.depth === 0 ? [] : [...lastFlags, isLast], index === children.length - 1, false);
    });
  };
  roots.forEach((root, index) => walk(root, [], index === roots.length - 1, true));

  // 预算选择：按紧迫度降序尝试入选；入选后代强制带上未入选的祖先链。
  const selected = new Set<string>();
  const candidates = [...nodes].sort(
    (left, right) =>
      URGENCY[right.input.snapshot.kind] - URGENCY[left.input.snapshot.kind] ||
      left.order - right.order,
  );
  for (const candidate of candidates) {
    if (selected.has(candidate.input.key)) continue;
    const chain: TreeNode[] = [];
    let node: TreeNode | undefined = candidate;
    while (node != null) {
      if (!selected.has(node.input.key)) chain.push(node);
      const parentKey: string | null = node.input.parentKey;
      node = parentKey != null ? nodes.find((item) => item.input.key === parentKey) : undefined;
    }
    if (selected.size + chain.length > SUBAGENT_WIDGET_ROW_BUDGET) continue;
    for (const chained of chain) selected.add(chained.input.key);
  }

  // 组装可见行 + 各顶层组折叠计数（组 = 顶层行 + 其子树；DFS 序下组是
  // 从该顶层行到下一个顶层行之前的连续区段）。
  const rows: WidgetRow[] = [];
  let subtreeOverflow = 0;
  let globalOverflow = 0;
  const rootIndexes = nodes
    .map((node, index) => (node.isRoot ? index : -1))
    .filter((index) => index >= 0);
  for (let groupIndex = 0; groupIndex < rootIndexes.length; groupIndex++) {
    const start = rootIndexes[groupIndex]!;
    const end =
      groupIndex + 1 < rootIndexes.length ? rootIndexes[groupIndex + 1]! : nodes.length;
    const group = nodes.slice(start, end);
    const visible = group.filter((node) => selected.has(node.input.key));
    if (visible.length > 0) {
      const hidden = group.length - visible.length;
      subtreeOverflow += hidden;
      visible.forEach((node, index) => {
        const row = toWidgetRow(node);
        // 组尾折叠提示挂在组内最后一个可见行上（渲染 chrome 行，不占行预算）。
        if (index === visible.length - 1 && hidden > 0) row.collapseAfter = hidden;
        rows.push(row);
      });
    } else {
      globalOverflow += group.length;
    }
  }

  return {
    rows,
    counts: {
      allCount: nodes.length,
      visibleRows: rows.length,
      subtreeOverflow,
      globalOverflow,
    },
  };
}

function toWidgetRow(node: TreeNode): WidgetRow {
  const input = node.input;
  return {
    key: input.key,
    name: input.name,
    ...(input.agent ? { agent: input.agent } : {}),
    depth: input.depth,
    via: input.via,
    orphan: input.orphan,
    startTime: input.startTime,
    snapshot: input.snapshot,
    model: input.model ?? null,
    thinking: input.thinking ?? null,
    lastFlags: node.lastFlags,
    isLast: node.isLast,
    collapseAfter: null,
  };
}

/** 第一层内存运行态 → 无后代的快照（渲染测试与 tracker 缺席时的兜底路径）。 */
export function buildFirstLayerOnlySnapshot(
  firstLayer: readonly RunningSubagent[],
  now: number,
): WidgetSnapshot {
  return layoutWidgetTree(
    firstLayer.map((running) => firstLayerInput(running, now)),
  );
}

function firstLayerInput(running: RunningSubagent, now: number): TreeRowInput {
  const snapshot = classifyStatus(running.statusState, now);
  return {
    key: `first:${running.id}`,
    name: running.name,
    ...(running.agent ? { agent: running.agent } : {}),
    depth: 0,
    via: null,
    orphan: false,
    startTime: running.startTime,
    parentKey: null,
    snapshot,
    model: running.model ?? null,
    thinking: running.thinking ?? null,
  };
}

// ── 只读递归快照 tracker ─────────────────────────────────────────

export interface DescendantsTrackerConfig {
  /** 本会话（祖父）工件目录：名字注册表与孤儿扫描的根。 */
  rootArtifactDir: string;
  /** 本会话 cwd：项目本地 .pi/agent sessions 根的推导来源。 */
  rootCwd: string;
  /** 全局 agentDir（宿主注入，尊重 PI_CODING_AGENT_DIR）：sessions 信任根。 */
  agentConfigDir: string;
  isPidAlive?: (pid: number) => boolean;
  maxDepth?: number;
  dirsPerTick?: number;
}

export interface DescendantsTracker {
  /** 递归快照：合并第一层内存运行态与磁盘后代行；每 tick 调一次。 */
  snapshot(firstLayer: readonly RunningSubagent[], now: number): WidgetSnapshot;
  dispose(): void;
}

/** 工件目录的遍历上下文：目录里各记录行的归属（via）、树位置与信任锚。 */
interface OwnerContext {
  /** 记录所属会话的代理名（via 取遍历上下文，不用 parentId 解析）。 */
  name: string;
  /** 所属会话的 run id；孤儿候选无法得知，为 null（parentId 校验随之跳过）。 */
  runId: string | null;
  /** 该目录行的父行 key；孤儿候选为 null（提升为顶层）。 */
  parentKey: string | null;
  /** 该目录行的深度（第一层子代理的工件目录为 1）。 */
  depth: number;
  /** 父行已消失（孤儿候选）。 */
  orphan: boolean;
  /** 派生出本目录的会话文件（下一跳 containment 的锚点）。 */
  sessionFile: string;
  /** 派生出本目录的父工件目录（GC 判定可达性用）。 */
  parentDir: string | null;
}

interface RowState {
  record: RuntimeRecord;
  snapshot: StatusSnapshot;
  /**
   * TTL 起算点（工单 45 统一到新口径）：max(活动锚点, 会话指纹锚点)。
   * 活动锚点 = activity.updatedAt（缺失时 record.startTime）；会话锚点 =
   * 指纹最近变化时刻——写侧停写（活动冻结）但子会话仍在写的行不算死。
   */
  anchorAt: number;
  lastRead: ActivityReadResult;
}

interface DirState {
  owner: OwnerContext;
  rows: Map<string, RowState>;
  refreshedTick: number;
  /** 本 tick 刷新时由记录派生出的子工件目录（GC：父刷新后不再派生即淘汰）。 */
  derivedDirs: Set<string>;
}

interface FileCacheEntry<T> {
  /** mtimeNs:size；null = 文件缺失（即时淘汰，下 tick 重读）。 */
  fingerprint: string | null;
  value: T;
  tick: number;
}

interface OrphanCandidate {
  name: string;
  sessionFile: string;
  /** 候选行的展示深度：根级（名字注册表收留）为 1；中间层转正的沿用原深度。 */
  depth: number;
}

/**
 * 统一路径形态供包含判定（mod.ts 等复用）：Windows 大小写不敏感，统一
 * 小写；POSIX 下仅极端目录名受影响且偏向保守跳过。
 */
export function normalizeForContains(path: string): string {
  return resolve(path).replace(/[\\/]+/g, "/").toLowerCase();
}

export function isWithin(path: string, root: string): boolean {
  const p = normalizeForContains(path);
  const r = normalizeForContains(root);
  return p === r || p.startsWith(r + "/");
}

export function createDescendantsTracker(config: DescendantsTrackerConfig): DescendantsTracker {
  const isPidAliveFn = config.isPidAlive ?? isPidAlive;
  const maxDepth = config.maxDepth ?? MAX_DESCENT_DEPTH;
  const dirsPerTick = config.dirsPerTick ?? DIRS_PER_TICK;
  // 每 tick 预算拆分（两级配额，防互相饿死）：
  //   优先级：第一层（本会话直接子代理的工件目录 + 孤儿候选根目录）先消
  //   费 firstQuota，从游标轮转，超出的留给下一 tick；剩余预算（至少
  //   nestedReserve）全部给嵌套（后代）目录的持久 FIFO 队列。
  //   刷新频率下界：N 个第一层目录最坏 ceil(N / firstQuota) tick 全量刷新
  //   一次（默认 16/12：N ≤ 12 每 tick，N = 24 每 2 tick，N = 100 每 9
  //   tick）；队列里 M 个嵌套目录最坏 ceil(M / (dirsPerTick − firstQuota))
  //   tick 刷新一次（默认配额 4：16 个嵌套目录每 4 tick 全量覆盖）。
  //   dirsPerTick = 1 时嵌套配额为 0（显式配置退化为只扫第一层）；队列条
  //   目按目录去重，不会无限增长。
  const nestedReserve = Math.max(1, Math.floor(dirsPerTick / 4));
  const firstQuota = Math.max(1, dirsPerTick - nestedReserve);

  // 信任边界：子会话文件 realpath 后必须落在这些 sessions 根之内（含项目
  // 本地 .pi/agent 变体）；更深一跳还允许落在上一跳已接受会话文件所在的
  // 同一 sessions 根（子代理换 cwd 后 sessions 目录仍在同一 agentDir 下）。
  const allowedRoots = [
    resolve(join(config.agentConfigDir, "sessions")),
    resolve(join(config.rootCwd, ".pi", "agent", "sessions")),
  ];

  const dirs = new Map<string, DirState>();
  // 状态机缓存键 = artifactDir + record.id：run id 只在 artifact 作用域内唯一。
  const statusStates = new Map<string, SubagentStatusState>();
  // 嵌套（后代）目录的待扫队列：跨 tick 持久（FIFO），本 tick 超出配额的
  // 嵌套目录留到下一 tick 从队首继续，不静默丢；queuedNestedDirs 按目录
  // 去重，每个目录最多一个待扫条目。
  const pendingNested: Array<[string, OwnerContext]> = [];
  const queuedNestedDirs = new Set<string>();
  const runtimeCache = new Map<string, FileCacheEntry<RuntimeRecord[]>>();
  const activityCache = new Map<string, FileCacheEntry<ActivityReadResult>>();
  const headerCache = new Map<string, FileCacheEntry<string | null>>();
  const registryCache = new Map<string, { mtimeMs: number; value: NameRegistry }>();
  // 存活证据探针（工单 45）：与第一层 widget 共用 liveness.ts 的采集语义。
  const sessionLiveness = createSessionFileLivenessProbe();
  const orphanCandidates = new Map<string, OrphanCandidate>();
  let knownFirstNames = new Set<string>();
  let startupScanPending = true;
  let tick = 0;
  let cursor = 0;
  let disposed = false;

  const realpathOrNull = (path: string): string | null => {
    try {
      return realpathSync(path);
    } catch {
      return null;
    }
  };

  const sessionAllowed = (realSessionFile: string, parentReal: string | null): boolean => {
    if (allowedRoots.some((root) => isWithin(realSessionFile, root))) return true;
    // 下一跳允许落在上一跳已接受会话文件所在的 sessions 根（子代理换 cwd
    // 后 sessions 目录仍在同一 agentDir 下）。
    if (parentReal && isWithin(realSessionFile, dirname(dirname(parentReal)))) return true;
    return false;
  };

  const cachedRead = <T>(
    path: string,
    read: () => T,
    cache: Map<string, FileCacheEntry<T>>,
    forceTicks: number,
  ): T => {
    let fingerprint: string | null = null;
    try {
      // bigint 形态的 stat 提供 mtimeNs（毫秒粒度会漏掉同毫秒的写入）。
      const stats = statSync(path, { bigint: true });
      fingerprint = `${stats.mtimeNs}:${stats.size}`;
    } catch {
      fingerprint = null;
    }
    const cached = cache.get(path);
    if (
      cached &&
      fingerprint !== null &&
      cached.fingerprint === fingerprint &&
      tick - cached.tick < forceTicks
    ) {
      return cached.value;
    }
    const value = read();
    cache.set(path, { fingerprint, value, tick });
    return value;
  };

  const headerOf = (realSessionFile: string): string | null =>
    cachedRead(realSessionFile, () => getSessionId(realSessionFile), headerCache, FORCE_REREAD_TICKS);

  /**
   * 会话文件 → 工件目录。sessionId 两条来源：名字注册表条目优先、会话头
   * 兜底，不一致时会话头为准（等价于头可读时取头，头缺失才用注册表值）。
   * 返回 canonical 路径作为调度/登记键（dirs、待扫队列与孤儿候选表共用，
   * 保证同一目录只算一次）。
   */
  const deriveArtifactDir = (
    sessionFile: string,
    registryEntry: { sessionId?: string | null } | null,
    parentReal: string | null,
  ): string | null => {
    const real = realpathOrNull(sessionFile);
    if (!real || !real.endsWith(".jsonl")) return null;
    if (!sessionAllowed(real, parentReal)) return null;
    const headerId = headerOf(real);
    const sessionId = headerId ?? registryEntry?.sessionId ?? null;
    if (!sessionId) return null;
    const sessionDir = dirname(real);
    const dir = join(sessionDir, "artifacts", sessionId);
    // artifacts 目录若被符号链接带离会话目录，视为越界跳过。
    const realDir = realpathOrNull(dir) ?? resolve(dir);
    if (!isWithin(realDir, sessionDir)) return null;
    return realDir;
  };

  const registryFor = (artifactDir: string): NameRegistry => {
    const path = join(artifactDir, "subagent-registry.json");
    let mtimeMs = -1;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      mtimeMs = -1;
    }
    const cached = registryCache.get(artifactDir);
    if (cached && cached.mtimeMs === mtimeMs) return cached.value;
    const value = readNameRegistry(artifactDir);
    registryCache.set(artifactDir, { mtimeMs, value });
    return value;
  };

  const evictState = (dir: string, recordId: string): void => {
    statusStates.delete(`${dir} ${recordId}`);
  };

  const dropDir = (dir: string): void => {
    const state = dirs.get(dir);
    if (!state) return;
    for (const recordId of state.rows.keys()) evictState(dir, recordId);
    dirs.delete(dir);
    // 队列同步清理：淘汰目录的待扫条目一并移除——留着会被过期 owner 上下
    // 文从磁盘复活成幽灵 DirState（目录已不该再扫）。
    if (queuedNestedDirs.delete(dir)) {
      for (let i = pendingNested.length - 1; i >= 0; i--) {
        if (pendingNested[i]![0] === dir) pendingNested.splice(i, 1);
      }
    }
  };

  /**
   * 目录转正为孤儿候选：父记录消失只宣告该目录行的父链接断了，不宣告
   * 子树死绝——目录留在候选表里继续重扫（行按「父已退出」形态展示，
   * 记录移除/终态宽限/pid 探活三类消失证据照常生效），登记表再无存活行
   * 时随证据淘汰。幂等：已是孤儿候选的目录重复转正无副作用。
   */
  const promoteOrphanDir = (dir: string, state: DirState): void => {
    orphanCandidates.set(dir, {
      name: state.owner.name,
      sessionFile: state.owner.sessionFile,
      depth: state.owner.depth,
    });
    state.owner = { ...state.owner, runId: null, parentKey: null, orphan: true, parentDir: null };
  };

  /**
   * 淘汰目录前先把它当前派生的子目录转正为孤儿候选：登记表被清空的目录
   * 淘汰时，派生子目录里的存活行不能跟着脱离重扫、冻结在缓存里等 TTL。
   */
  const dropDirReanchoring = (dir: string): void => {
    const state = dirs.get(dir);
    if (!state) return;
    for (const child of state.derivedDirs) {
      const childState = dirs.get(child);
      if (childState) {
        promoteOrphanDir(child, childState);
        continue;
      }
      // 还在待扫队列里、从未处理过的子目录没有 DirState 可转正：直接按
      // 队列条目里的遍历上下文收留为孤儿候选，否则父目录淘汰后它既没人
      // 派生也不再被扫，行会冻结在缓存里等 TTL（无幽灵行纪律不允许）。
      const queued = pendingNested.find(([queuedDir]) => queuedDir === child);
      if (queued) {
        orphanCandidates.set(child, {
          name: queued[1].name,
          sessionFile: queued[1].sessionFile,
          depth: queued[1].depth,
        });
      }
    }
    dropDir(dir);
  };

  const ensureDirState = (dir: string, owner: OwnerContext): DirState => {
    let state = dirs.get(dir);
    if (!state) {
      state = { owner, rows: new Map(), refreshedTick: -1, derivedDirs: new Set() };
      dirs.set(dir, state);
    }
    return state;
  };

  /** 活动快照路径：优先生成（startup 同法），记录里的 activityFile 只作兜底
   *  且须 canonicalize 后仍位于该 artifact 目录下。 */
  const activityFileFor = (dir: string, record: RuntimeRecord): string => {
    const preferred = getSubagentActivityFile(dir, record.id);
    if (existsSync(preferred)) return preferred;
    if (record.activityFile) {
      const real = realpathOrNull(record.activityFile);
      if (real && isWithin(real, realpathOrNull(dir) ?? resolve(dir))) return record.activityFile;
    }
    return preferred;
  };

  /** headless 记录的 pid：pid 字段优先，兼容 headless:<pid> surface（recover 同法）。 */
  const headlessPid = (record: RuntimeRecord): number | null => {
    if (record.kind !== "headless") return null;
    return record.pid ?? parseHeadlessSurface(record.surface);
  };

  /**
   * 单条记录 → 行（或淘汰）。返回 null = 行消失（死亡证据 / 孤儿 TTL）；
   * 状态机缓存的淘汰由调用方负责（随行淘汰）。
   */
  const evaluateRecord = (
    dir: string,
    owner: OwnerContext,
    record: RuntimeRecord,
    read: ActivityReadResult,
    now: number,
  ): RowState | null => {
    if (read.ok && isTerminalDoneActivity(read.activity, now)) return null;
    const pid = headlessPid(record);
    if (pid != null && !isPidAliveFn(pid)) return null;

    // 证据采集（工单 45，IO 在采集侧）：会话指纹 + pid 探活。死 pid 的行已在
    // 上方淘汰，走到判定的 headless 行必然活着；pane 派生无 pid 证据。
    const session = record.sessionFile
      ? sessionLiveness.probe(record.sessionFile, now)
      : null;
    const evidence: StatusLivenessEvidence = {
      sessionLastChangeAtMs: session?.lastChangeAtMs ?? null,
      processAlive: pid != null ? true : null,
    };

    const stateKey = `${dir} ${record.id}`;
    let state =
      statusStates.get(stateKey) ??
      createStatusState({ source: "pi", startTimeMs: record.startTime });
    state = read.ok
      ? observeStatus(
          state,
          {
            snapshot: "present",
            updatedAt: read.activity.updatedAt,
            sequence: read.activity.sequence,
            phase: read.activity.phase,
            active: read.activity.phase === "active",
            toolActive: read.activity.toolActive,
            activeScope: read.activity.activeScope,
            activeSince: read.activity.activeSince,
            waitingSince: read.activity.waitingSince,
            latestEvent: read.activity.latestEvent,
            activityLabel: activityDisplayLabel(read.activity),
          },
          now,
          evidence,
        )
      : observeStatus(state, { snapshot: read.reason, snapshotError: read.error }, now, evidence);
    const { nextState, snapshot } = advanceStatusState(state, now);
    statusStates.set(stateKey, nextState);

    const activityAnchor = read.ok ? read.activity.updatedAt : record.startTime;
    const sessionAnchor = evidence.sessionLastChangeAtMs;
    const anchorAt = sessionAnchor != null ? Math.max(activityAnchor, sessionAnchor) : activityAnchor;
    if (owner.orphan && now - anchorAt >= ORPHAN_ROW_TTL_MS) return null;
    return { record, snapshot, anchorAt, lastRead: read };
  };

  const processDir = (
    dir: string,
    owner: OwnerContext,
    now: number,
    scheduled: Set<string>,
  ): void => {
    scheduled.add(dir);
    const state = ensureDirState(dir, owner);
    state.owner = owner;
    state.refreshedTick = tick;
    state.derivedDirs = new Set();
    const registryPath = runtimeRegistryPath(dir);
    const records = cachedRead(
      registryPath,
      () => readRuntimeRecords(registryPath),
      runtimeCache,
      FORCE_REREAD_TICKS,
    );
    const registry = registryFor(dir);

    const nextRows = new Map<string, RowState>();
    for (const record of records) {
      try {
        // parentId 只做关系一致性校验（via 不按它解析）：与遍历上下文的
        // run id 不等说明记录来历异常，按异常跳过该行及其子树；孤儿候选
        // 的 run id 不可知，缺省 null 时（旧记录无此字段）不校验。
        if (owner.runId != null && record.parentId != null && record.parentId !== owner.runId) {
          debugLog(`descendants: parentId mismatch for ${record.name} in ${dir}, skipping`);
          continue;
        }
        const activityFile = activityFileFor(dir, record);
        const read = cachedRead(
          activityFile,
          () => readSubagentActivityFile(activityFile, record.id),
          activityCache,
          FORCE_REREAD_TICKS,
        );
        const row = evaluateRecord(dir, owner, record, read, now);
        if (row) nextRows.set(record.id, row);
        else evictState(dir, record.id);

        // 子树遍历与行存活解耦：行消失（死亡证据/TTL）不代表后代死绝
        // ——直接父行没了的后代按孤儿形态继续展示（assemble 里提升）。
        if (owner.depth < maxDepth) {
          const childDir = deriveArtifactDir(
            record.sessionFile,
            registry[record.name] ?? null,
            owner.sessionFile,
          );
          if (childDir) {
            // 父记录重新可达（罕见：登记被移除后又写回）：撤孤儿候选，扫描
            // 锚点回到正常派生链，避免目录永久停在孤儿形态。
            orphanCandidates.delete(childDir);
            state.derivedDirs.add(childDir);
            // 嵌套目录入持久队列（非本 tick 一次性工作清单）：本 tick 配额
            // 不够就留到下一 tick，已在本 tick 处理过或已在队列的跳过。
            if (!scheduled.has(childDir) && !queuedNestedDirs.has(childDir)) {
              queuedNestedDirs.add(childDir);
              pendingNested.push([
                childDir,
                {
                  name: record.name,
                  runId: record.id,
                  parentKey: `desc:${dir} ${record.id}`,
                  depth: owner.depth + 1,
                  orphan: false,
                  sessionFile: record.sessionFile,
                  parentDir: dir,
                },
              ]);
            }
          }
        }
      } catch (error) {
        debugLog(`descendants: skipping subtree under ${dir}`, error);
      }
    }
    for (const recordId of state.rows.keys()) {
      if (!nextRows.has(recordId)) evictState(dir, recordId);
    }
    state.rows = nextRows;
  };

  /** 名字注册表历史条目 → 孤儿候选（会话启动 / 父行消失时调用）。 */
  const addOrphanCandidates = (rootRegistry: NameRegistry, name: string | null): void => {
    const entries = name
      ? [[name, rootRegistry[name]] as const]
      : Object.entries(rootRegistry);
    for (const [entryName, entry] of entries) {
      if (!entry || typeof entry.sessionFile !== "string") continue;
      const dir = deriveArtifactDir(entry.sessionFile, entry, null);
      if (!dir || dirs.has(dir)) continue;
      orphanCandidates.set(dir, { name: entryName, sessionFile: entry.sessionFile, depth: 1 });
    }
  };

  const assemble = (
    firstLayer: readonly RunningSubagent[],
    now: number,
  ): WidgetSnapshot => {
    const firstInputs = firstLayer.map((running) => firstLayerInput(running, now));
    // 第二遍才能判定提升孤儿（需要全量 key 集合），先收集再过滤。
    const pending: Array<{
      input: TreeRowInput;
      dir: string;
      recordId: string;
      anchorAt: number;
    }> = [];
    for (const [dir, state] of dirs) {
      const owner = state.owner;
      for (const [recordId, row] of state.rows) {
        let snapshot = row.snapshot;
        if (state.refreshedTick !== tick) {
          // 本 tick 未轮到的目录：用缓存数据做纯时间性复评（状态推进、
          // 终态宽限、pid 探活、孤儿 TTL），不读新文件。
          const reEvaluated = evaluateRecord(dir, owner, row.record, row.lastRead, now);
          if (!reEvaluated) {
            state.rows.delete(recordId);
            evictState(dir, recordId);
            continue;
          }
          snapshot = reEvaluated.snapshot;
        }
        pending.push({
          input: {
            key: `desc:${dir} ${recordId}`,
            name: row.record.name,
            ...(row.record.agent ? { agent: row.record.agent } : {}),
            depth: owner.depth,
            via: owner.name,
            orphan: owner.orphan,
            startTime: row.record.startTime,
            parentKey: owner.parentKey,
            snapshot,
            model: null,
            thinking: null,
          },
          dir,
          recordId,
          anchorAt: row.anchorAt,
        });
      }
    }
    // 提升孤儿：父行不在本快照里的后代行（直接父记录已死/被清理但登记仍
    // 在）按孤儿展示，同样受 TTL 约束（无幽灵行堆积）。
    const keySet = new Set<string>([
      ...firstInputs.map((input) => input.key),
      ...pending.map((entry) => entry.input.key),
    ]);
    const inputs: TreeRowInput[] = [...firstInputs];
    for (const entry of pending) {
      const parentKey = entry.input.parentKey;
      const promoted = entry.input.parentKey != null && parentKey != null && !keySet.has(parentKey);
      if (!promoted) {
        inputs.push(entry.input);
        continue;
      }
      if (now - entry.anchorAt >= ORPHAN_ROW_TTL_MS) {
        dirs.get(entry.dir)?.rows.delete(entry.recordId);
        evictState(entry.dir, entry.recordId);
        continue;
      }
      inputs.push({ ...entry.input, orphan: true });
    }
    return layoutWidgetTree(inputs);
  };

  return {
    snapshot(firstLayer, now) {
      if (disposed) return buildFirstLayerOnlySnapshot(firstLayer, now);
      // 顶层兑底（工单 43「绝不向渲染抛错」）：子树级异常已逐记录/逐子树
      // catch，这里只兜未预期异常——widget 的 1s interval 回调里不能抛错，
      // 异常时回退纯内存的第一层快照；tracker 状态可能停在半途，下一 tick
      // 重新拉起，磁盘只读所以无残留。
      try {
        tick += 1;
        if (startupScanPending) {
          startupScanPending = false;
          addOrphanCandidates(registryFor(config.rootArtifactDir), null);
        }
        const rootRegistry = registryFor(config.rootArtifactDir);

        // 本 tick 的候选：第一层子代理的工件目录（按内存运行态序）。
        const wanted = new Map<string, OwnerContext>();
        const currentNames = new Set<string>();
        for (const running of firstLayer) {
          currentNames.add(running.name);
          const entry = rootRegistry[running.name] ?? null;
          const dir = deriveArtifactDir(running.sessionFile, entry, null);
          if (!dir || wanted.has(dir)) continue;
          wanted.set(dir, {
            name: running.name,
            runId: running.id,
            parentKey: `first:${running.id}`,
            depth: 1,
            orphan: false,
            sessionFile: running.sessionFile,
            parentDir: null,
          });
        }

        // 父行消失检测：消失前先做一次孤儿检查（名字注册表历史条目收留其
        // 子树），否则孤儿永远没有展示窗口。
        for (const name of knownFirstNames) {
          if (currentNames.has(name)) continue;
          addOrphanCandidates(rootRegistry, name);
        }
        knownFirstNames = currentNames;

        for (const [dir, candidate] of orphanCandidates) {
          if (wanted.has(dir)) continue;
          wanted.set(dir, {
            name: candidate.name,
            runId: null,
            parentKey: null,
            depth: candidate.depth,
            orphan: true,
            sessionFile: candidate.sessionFile,
            parentDir: null,
          });
        }

        // 根级目录失候选（父行消失且未被孤儿候选收留）→ 整目录淘汰；仍
        // 派生的子目录转正为孤儿候选，不脱离重扫。
        for (const [dir] of [...dirs]) {
          const state = dirs.get(dir);
          if (!state) continue;
          const rootLevel =
            state.owner.parentKey === null || state.owner.parentKey.startsWith("first:");
          if (rootLevel && !wanted.has(dir)) dropDirReanchoring(dir);
        }

        // 轮转续扫（两级配额，预算语义见 createDescendantsTracker 处的拆分
        // 注释）：第一层从游标消费 firstQuota，超出的留给下一 tick；剩余预
        // 算给嵌套队列，弹出的条目已在本 tick 处理过或已回归 wanted 通道
        // （如被收留为孤儿候选）时跳过且不耗预算。
        const ordered = [...wanted.entries()];
        const scheduled = new Set<string>();
        let processedWanted = 0;
        for (let i = 0; i < ordered.length && processedWanted < firstQuota; i++) {
          const [dir, owner] = ordered[(cursor + i) % ordered.length]!;
          processDir(dir, owner, now, scheduled);
          processedWanted += 1;
        }
        cursor = ordered.length > 0 ? (cursor + processedWanted) % ordered.length : 0;

        let nestedBudget = dirsPerTick - processedWanted;
        while (nestedBudget > 0 && pendingNested.length > 0) {
          const [dir, owner] = pendingNested.shift()!;
          queuedNestedDirs.delete(dir);
          if (wanted.has(dir) || scheduled.has(dir)) continue;
          processDir(dir, owner, now, scheduled);
          nestedBudget -= 1;
        }

        // 嵌套目录 GC：父目录本 tick 已刷新却不再派生它 → 该记录已被写方
        // 移除。记录消失只宣告父链接断了，不宣告子树死绝：目录转正为孤儿
        // 候选继续重扫（下一 tick 起进入 wanted），不丢弃；父目录未刷新
        // （轮转未到）→ 保留行，下一 tick 再核。
        for (const [dir, state] of [...dirs]) {
          if (state.refreshedTick === tick) continue;
          if (state.owner.parentDir == null) continue;
          const parent = dirs.get(state.owner.parentDir);
          if (parent && parent.refreshedTick === tick && !parent.derivedDirs.has(dir)) {
            promoteOrphanDir(dir, state);
          }
        }

        // 孤儿候选证据淘汰：本 tick 已刷新且无存活行 → 移出候选表（无幽灵
        // 堆积）；仍派生的子目录转正接手扫描锚点。
        for (const [dir] of [...orphanCandidates]) {
          const state = dirs.get(dir);
          if (state && state.refreshedTick === tick && state.rows.size === 0) {
            orphanCandidates.delete(dir);
            dropDirReanchoring(dir);
          }
        }

        return assemble(firstLayer, now);
      } catch (error) {
        debugLog("descendants: snapshot failed, falling back to first-layer only", error);
        return buildFirstLayerOnlySnapshot(firstLayer, now);
      }
    },

    dispose() {
      disposed = true;
      dirs.clear();
      statusStates.clear();
      runtimeCache.clear();
      activityCache.clear();
      headerCache.clear();
      registryCache.clear();
      sessionLiveness.dispose();
      orphanCandidates.clear();
      pendingNested.length = 0;
      queuedNestedDirs.clear();
    },
  };
}
