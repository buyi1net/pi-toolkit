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

export const SUBAGENT_WIDGET_ROW_BUDGET = 6;

const MAX_DESCENT_DEPTH = 8;

const DIRS_PER_TICK = 16;

const FORCE_REREAD_TICKS = 60;

export const ORPHAN_ROW_TTL_MS = 30 * 60_000;

export interface WidgetRow {
  key: string;
  name: string;
  agent?: string;

  depth: number;

  via: string | null;

  orphan: boolean;
  startTime: number;
  snapshot: StatusSnapshot;

  model: string | null;
  thinking: string | null;

  lastFlags: readonly boolean[];

  isLast: boolean;

  collapseAfter: number | null;
}

export interface WidgetCounts {

  allCount: number;
  visibleRows: number;

  subtreeOverflow: number;

  globalOverflow: number;
}

export interface WidgetSnapshot {

  rows: WidgetRow[];
  counts: WidgetCounts;
}

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

const URGENCY: Record<SubagentStatusKind, number> = {
  stalled: 4,
  waiting: 3,
  active: 2,
  running: 2,

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

  isRoot: boolean;
}

export function layoutWidgetTree(inputs: readonly TreeRowInput[]): WidgetSnapshot {
  const byKey = new Map<string, TreeRowInput>();
  for (const input of inputs) byKey.set(input.key, input);

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

  const routing = running.modelRouting ?? null;
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
    model: routing ? routing.model : running.model ?? null,
    thinking: routing ? routing.effectiveThinking : running.thinking ?? null,
  };
}

export interface DescendantsTrackerConfig {

  rootArtifactDir: string;

  rootCwd: string;

  agentConfigDir: string;
  isPidAlive?: (pid: number) => boolean;
  maxDepth?: number;
  dirsPerTick?: number;
}

export interface DescendantsTracker {

  snapshot(firstLayer: readonly RunningSubagent[], now: number): WidgetSnapshot;
  dispose(): void;
}

interface OwnerContext {

  name: string;

  runId: string | null;

  parentKey: string | null;

  depth: number;

  orphan: boolean;

  sessionFile: string;

  parentDir: string | null;
}

interface RowState {
  record: RuntimeRecord;
  snapshot: StatusSnapshot;

  anchorAt: number;
  lastRead: ActivityReadResult;
}

interface DirState {
  owner: OwnerContext;
  rows: Map<string, RowState>;
  refreshedTick: number;

  derivedDirs: Set<string>;
}

interface FileCacheEntry<T> {

  fingerprint: string | null;
  value: T;
  tick: number;
}

interface OrphanCandidate {
  name: string;
  sessionFile: string;

  depth: number;
}

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

  const nestedReserve = Math.max(1, Math.floor(dirsPerTick / 4));
  const firstQuota = Math.max(1, dirsPerTick - nestedReserve);

  const allowedRoots = [
    resolve(join(config.agentConfigDir, "sessions")),
    resolve(join(config.rootCwd, ".pi", "agent", "sessions")),
  ];

  const dirs = new Map<string, DirState>();

  const statusStates = new Map<string, SubagentStatusState>();

  const pendingNested: Array<[string, OwnerContext]> = [];
  const queuedNestedDirs = new Set<string>();
  const runtimeCache = new Map<string, FileCacheEntry<RuntimeRecord[]>>();
  const activityCache = new Map<string, FileCacheEntry<ActivityReadResult>>();
  const headerCache = new Map<string, FileCacheEntry<string | null>>();
  const registryCache = new Map<string, { mtimeMs: number; value: NameRegistry }>();

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

    if (queuedNestedDirs.delete(dir)) {
      for (let i = pendingNested.length - 1; i >= 0; i--) {
        if (pendingNested[i]![0] === dir) pendingNested.splice(i, 1);
      }
    }
  };

  const promoteOrphanDir = (dir: string, state: DirState): void => {
    orphanCandidates.set(dir, {
      name: state.owner.name,
      sessionFile: state.owner.sessionFile,
      depth: state.owner.depth,
    });
    state.owner = { ...state.owner, runId: null, parentKey: null, orphan: true, parentDir: null };
  };

  const dropDirReanchoring = (dir: string): void => {
    const state = dirs.get(dir);
    if (!state) return;
    for (const child of state.derivedDirs) {
      const childState = dirs.get(child);
      if (childState) {
        promoteOrphanDir(child, childState);
        continue;
      }

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

  const activityFileFor = (dir: string, record: RuntimeRecord): string => {
    const preferred = getSubagentActivityFile(dir, record.id);
    if (existsSync(preferred)) return preferred;
    if (record.activityFile) {
      const real = realpathOrNull(record.activityFile);
      if (real && isWithin(real, realpathOrNull(dir) ?? resolve(dir))) return record.activityFile;
    }
    return preferred;
  };

  const headlessPid = (record: RuntimeRecord): number | null => {
    if (record.kind !== "headless") return null;
    return record.pid ?? parseHeadlessSurface(record.surface);
  };

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

        if (owner.depth < maxDepth) {
          const childDir = deriveArtifactDir(
            record.sessionFile,
            registry[record.name] ?? null,
            owner.sessionFile,
          );
          if (childDir) {

            orphanCandidates.delete(childDir);
            state.derivedDirs.add(childDir);

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

      try {
        tick += 1;
        if (startupScanPending) {
          startupScanPending = false;
          addOrphanCandidates(registryFor(config.rootArtifactDir), null);
        }
        const rootRegistry = registryFor(config.rootArtifactDir);

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

        for (const [dir] of [...dirs]) {
          const state = dirs.get(dir);
          if (!state) continue;
          const rootLevel =
            state.owner.parentKey === null || state.owner.parentKey.startsWith("first:");
          if (rootLevel && !wanted.has(dir)) dropDirReanchoring(dir);
        }

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

        for (const [dir, state] of [...dirs]) {
          if (state.refreshedTick === tick) continue;
          if (state.owner.parentDir == null) continue;
          const parent = dirs.get(state.owner.parentDir);
          if (parent && parent.refreshedTick === tick && !parent.derivedDirs.has(dir)) {
            promoteOrphanDir(dir, state);
          }
        }

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
