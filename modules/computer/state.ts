import { randomUUID } from "node:crypto";
import {
  formatComputerRef,
  parseComputerRef,
  type ComputerBounds,
  type ComputerCaptureRecord,
  type ComputerError,
  type ComputerObserveData,
  type ComputerRef,
  type ComputerRefKind,
  type ComputerRootKind,
  type ComputerRootSummary,
  type ComputerStateChange,
  type ComputerStateId,
  type RootRef,
} from "./contract.ts";
import { desktopBoundsToImage, imageFrameOf, type ComputerImageFrame } from "./coordinates.ts";

export interface ComputerObservedNode {
  readonly role: string;
  readonly name?: string;
  readonly value?: string;
  readonly description?: string;
  readonly enabled?: boolean;
  readonly focused?: boolean;
  readonly bounds?: ComputerBounds;

  readonly actions?: readonly string[];

  readonly text?: string;
  readonly children?: readonly ComputerObservedNode[];
}

export interface ComputerRootDescriptor {
  readonly key: string;
  readonly kind: ComputerRootKind;
  readonly title: string;
  readonly app: string;
  readonly focused?: boolean;
}

export interface ComputerRegisteredRoot extends ComputerRootSummary {
  readonly key: string;
}

export interface ComputerObservation {

  readonly root: RootRef;
  readonly tree: ComputerObservedNode;

  readonly capture?: ComputerCaptureRecord;

  readonly stateId?: ComputerStateId;
}

export interface ComputerSnapshotNode {
  readonly ref: ComputerRef;
  readonly parentRef?: ComputerRef;
  readonly depth: number;
  readonly role: string;
  readonly name?: string;
  readonly value?: string;
  readonly description?: string;
  readonly enabled: boolean;
  readonly focused: boolean;
  readonly bounds?: ComputerBounds;
  readonly actions: readonly string[];

  readonly text?: string;
}

export interface ComputerSnapshot {
  readonly stateId: ComputerStateId;

  readonly root: RootRef;

  readonly generation: number;

  readonly nodes: readonly ComputerSnapshotNode[];

  readonly capture?: ComputerCaptureRecord;
}

export type ComputerRefRejectionReason = "invalid_format" | "stale_snapshot" | "cross_scope" | "unknown_ref";

export type ComputerRefResolution =
  | {
      readonly ok: true;
      readonly stateId: ComputerStateId;
      readonly ref: ComputerRef;
      readonly kind: ComputerRefKind;
      readonly node: ComputerSnapshotNode;
    }
  | {
      readonly ok: false;
      readonly reason: ComputerRefRejectionReason;
      readonly error: ComputerError;
    };

export interface ComputerStateStore {

  registerRoots(roots: readonly ComputerRootDescriptor[]): readonly ComputerRootSummary[];

  findRoot(ref: unknown): ComputerRegisteredRoot | undefined;

  nextStateId(): ComputerStateId;

  observe(observation: ComputerObservation): ComputerObserveData;

  snapshotOf(stateId: ComputerStateId): ComputerSnapshot | undefined;

  isCurrent(stateId: ComputerStateId): boolean;

  resolveRef(stateId: ComputerStateId, ref: unknown): ComputerRefResolution;
}

interface RootScope {
  readonly ref: RootRef;
  readonly key: string;
  summary: ComputerRootSummary;
  generation: number;
  latestStateId?: ComputerStateId;
}

interface SnapshotRecord {
  readonly snapshot: ComputerSnapshot;
  readonly scope: RootScope;
  readonly byRef: ReadonlyMap<ComputerRef, ComputerSnapshotNode>;
  retired: boolean;
}

export function createComputerState(): ComputerStateStore {
  const scopesByKey = new Map<string, RootScope>();
  const scopesByRef = new Map<RootRef, RootScope>();

  const records = new Map<ComputerStateId, SnapshotRecord>();

  const elementOwner = new Map<ComputerRef, ComputerStateId>();
  let rootIndex = 0;

  let elementIndex = 0;

  function registerRoots(roots: readonly ComputerRootDescriptor[]): readonly ComputerRootSummary[] {
    return roots.map((descriptor) => {
      const existing = scopesByKey.get(descriptor.key);
      if (existing) {
        existing.summary = { ...existing.summary, ...toSummaryFields(descriptor) };
        return existing.summary;
      }
      const ref = formatComputerRef("root", ++rootIndex) as RootRef;
      const scope: RootScope = {
        ref,
        key: descriptor.key,
        summary: { ref, ...toSummaryFields(descriptor) },
        generation: 0,
      };
      scopesByKey.set(descriptor.key, scope);
      scopesByRef.set(ref, scope);
      return scope.summary;
    });
  }

  function findRoot(ref: unknown): ComputerRegisteredRoot | undefined {
    const parsed = parseComputerRef(ref);
    if (!parsed || parsed.kind !== "root") return undefined;
    const scope = scopesByRef.get(parsed.ref as RootRef);
    return scope ? { ...scope.summary, key: scope.key } : undefined;
  }

  function nextStateId(): ComputerStateId {
    return randomUUID();
  }

  function observe(observation: ComputerObservation): ComputerObserveData {
    const scope = scopesByRef.get(observation.root);
    if (!scope) {
      throw new RangeError(`未登记的根引用 ${observation.root}；先 registerRoots，模型输入要先过 findRoot`);
    }

    const stateId = observation.stateId ?? randomUUID();
    if (records.has(stateId)) {

      throw new RangeError(`stateId 已被占用：${stateId}；每次观察必须用 nextStateId 取新 id`);
    }
    const generation = scope.generation + 1;
    const capture = observation.capture !== undefined ? cloneCapture(observation.capture) : undefined;
    let frame: ComputerImageFrame | undefined;
    if (capture !== undefined) {

      if (capture.window !== undefined && capture.window.key !== scope.key) {
        throw new RangeError(
          `采集记录的窗口 ${capture.window.key} 与观察的根 ${scope.key} 不是同一个，图不能绑到这份快照`,
        );
      }
      frame = imageFrameOf(capture);
      if (frame === undefined) {
        throw new RangeError("采集记录的 region / image / scale 自相矛盾，不能用来做坐标换算");
      }
    }
    const nodes = buildNodes(observation.tree, scope.ref, stateId, frame);
    const snapshot: ComputerSnapshot = {
      stateId,
      root: scope.ref,
      generation,
      nodes,
      ...(capture !== undefined ? { capture } : {}),
    };
    const byRef = new Map(nodes.map((node) => [node.ref, node]));
    const previousId = scope.latestStateId;
    records.set(stateId, { snapshot, scope, byRef, retired: false });
    scope.latestStateId = stateId;
    scope.generation = generation;

    const previous = previousId ? records.get(previousId) : undefined;
    if (previous) previous.retired = true;
    const changes = previous ? diffComputerSnapshots(previous.snapshot, snapshot) : [];
    const view = renderComputerOutline(snapshot, nodes[0]);
    return {
      stateId,
      root: scope.ref,
      outline: view.outline,
      nodeCount: nodes.length,
      truncated: view.folded,
      ...(previous ? { previousStateId: previous.snapshot.stateId } : {}),
      changes,
    };
  }

  function resolveRef(stateId: ComputerStateId, ref: unknown): ComputerRefResolution {
    const parsed = parseComputerRef(ref);
    if (!parsed) {
      return reject("invalid_format", "invalid_params", `${String(ref)} is not a valid @rN/@eN reference`);
    }
    const presented = records.get(stateId);
    if (!presented || presented.retired) {
      return reject("stale_snapshot", "stale_ref", `state ${stateId} is not the current observation; observe again`);
    }

    const node = presented.byRef.get(parsed.ref);
    if (node) {
      return { ok: true, stateId, ref: parsed.ref, kind: parsed.kind, node };
    }

    if (parsed.kind === "root") {

      const scope = scopesByRef.get(parsed.ref as RootRef);
      if (scope) {
        return reject(
          "cross_scope",
          "wrong_scope",
          `${parsed.ref} is the root of another state scope (${scope.key}); use the stateId observed from it`,
        );
      }
      return reject("unknown_ref", "target_not_found", `${parsed.ref} was never observed`);
    }
    const ownerStateId = elementOwner.get(parsed.ref);
    if (!ownerStateId) {
      return reject("unknown_ref", "target_not_found", `${parsed.ref} was never issued by any observation`);
    }
    const owner = records.get(ownerStateId);
    if (!owner || owner.scope.key !== presented.scope.key) {
      return reject(
        "cross_scope",
        "wrong_scope",
        `${parsed.ref} belongs to another state scope, not to state ${stateId}`,
      );
    }

    if (owner.snapshot.generation !== presented.snapshot.generation || ownerStateId !== stateId) {
      return reject(
        "stale_snapshot",
        "stale_ref",
        `${parsed.ref} (generation ${owner.snapshot.generation}) was superseded by state ${presented.snapshot.stateId}; observe again`,
      );
    }
    return reject("unknown_ref", "target_not_found", `${parsed.ref} is not part of state ${stateId}`);
  }

  function snapshotOf(stateId: ComputerStateId): ComputerSnapshot | undefined {
    return records.get(stateId)?.snapshot;
  }

  function isCurrent(stateId: ComputerStateId): boolean {
    return records.get(stateId)?.retired === false;
  }

  return { registerRoots, findRoot, nextStateId, observe, snapshotOf, isCurrent, resolveRef };

  function buildNodes(
    tree: ComputerObservedNode,
    rootRef: RootRef,
    stateId: ComputerStateId,
    frame: ComputerImageFrame | undefined,
  ): readonly ComputerSnapshotNode[] {
    const nodes: ComputerSnapshotNode[] = [];
    const visit = (observed: ComputerObservedNode, ref: ComputerRef, parentRef: ComputerRef | undefined, depth: number): void => {
      nodes.push({
        ref,
        ...(parentRef ? { parentRef } : {}),
        depth,
        role: observed.role,
        ...(observed.name !== undefined ? { name: observed.name } : {}),
        ...(observed.value !== undefined ? { value: observed.value } : {}),
        ...(observed.description !== undefined ? { description: observed.description } : {}),
        enabled: observed.enabled ?? true,
        focused: observed.focused ?? false,

        ...(observed.bounds !== undefined && frame !== undefined
          ? { bounds: desktopBoundsToImage(frame, observed.bounds) }
          : {}),
        actions: observed.actions ? [...observed.actions] : [],
        ...(observed.text !== undefined ? { text: observed.text } : {}),
      });
      if (ref !== rootRef) elementOwner.set(ref, stateId);
      for (const child of observed.children ?? []) {
        visit(child, formatComputerRef("element", ++elementIndex), ref, depth + 1);
      }
    };
    visit(tree, rootRef, undefined, 0);
    return nodes;
  }
}

function cloneCapture(capture: ComputerCaptureRecord): ComputerCaptureRecord {
  return {
    path: capture.path,
    image: { ...capture.image },
    region: { ...capture.region },
    ...(capture.display !== undefined ? { display: { ...capture.display } } : {}),
    ...(capture.displays !== undefined ? { displays: capture.displays.map((display) => ({ ...display })) } : {}),
    ...(capture.window !== undefined
      ? {
          window: {
            ...capture.window,
            ...(capture.window.startIdentity !== undefined ? { startIdentity: { ...capture.window.startIdentity } } : {}),
            ...(capture.window.bounds !== undefined ? { bounds: { ...capture.window.bounds } } : {}),
          },
        }
      : {}),
    ...(capture.source !== undefined ? { source: capture.source } : {}),
    ...(capture.mayBeObscured !== undefined ? { mayBeObscured: capture.mayBeObscured } : {}),
  };
}

export function diffComputerSnapshots(
  previous: ComputerSnapshot,
  next: ComputerSnapshot,
): readonly ComputerStateChange[] {
  const before = structuralIndex(previous);
  const after = structuralIndex(next);
  const changes: ComputerStateChange[] = [];
  for (const [key, node] of after) {
    const old = before.get(key);
    if (!old) {
      changes.push({ kind: "added", ref: node.ref, summary: describeNode(node) });
      continue;
    }
    const fields = changedFields(old, node);
    if (fields.length > 0) {
      changes.push({ kind: "updated", ref: node.ref, summary: `${describeNode(node)} (${fields.join(", ")} changed)` });
    }
  }
  for (const [key, node] of before) {
    if (!after.has(key)) {
      changes.push({ kind: "removed", ref: node.ref, summary: describeNode(node) });
    }
  }
  return changes;
}

function structuralIndex(snapshot: ComputerSnapshot): ReadonlyMap<string, ComputerSnapshotNode> {
  const byRef = new Map(snapshot.nodes.map((node) => [node.ref, node]));
  const byParent = new Map<ComputerRef | undefined, ComputerSnapshotNode[]>();
  for (const node of snapshot.nodes) {
    const siblings = byParent.get(node.parentRef) ?? [];
    siblings.push(node);
    byParent.set(node.parentRef, siblings);
  }
  const index = new Map<string, ComputerSnapshotNode>();
  for (const node of snapshot.nodes) {
    index.set(structuralKey(node, byRef, byParent), node);
  }
  return index;
}

function structuralKey(
  node: ComputerSnapshotNode,
  byRef: ReadonlyMap<ComputerRef, ComputerSnapshotNode>,
  byParent: ReadonlyMap<ComputerRef | undefined, readonly ComputerSnapshotNode[]>,
): string {
  const segments: string[] = [];
  let current: ComputerSnapshotNode | undefined = node;
  while (current) {
    const token = structuralToken(current);
    const siblings = byParent.get(current.parentRef) ?? [];
    const sameToken = siblings.filter((sibling) => structuralToken(sibling) === token);
    segments.unshift(`${token}#${sameToken.indexOf(current)}`);
    current = current.parentRef ? byRef.get(current.parentRef) : undefined;
  }
  return segments.join(">");
}

function structuralToken(node: ComputerSnapshotNode): string {
  return `${node.role.trim().toLowerCase()}|${(node.name ?? "").trim().toLowerCase()}`;
}

function changedFields(before: ComputerSnapshotNode, after: ComputerSnapshotNode): readonly string[] {
  const fields: string[] = [];
  if (before.value !== after.value) fields.push("value");
  if (before.description !== after.description) fields.push("description");
  if (before.enabled !== after.enabled) fields.push("enabled");
  if (before.focused !== after.focused) fields.push("focused");
  if (!sameBounds(before.bounds, after.bounds)) fields.push("bounds");
  if (before.actions.join("\u0000") !== after.actions.join("\u0000")) fields.push("actions");
  return fields;
}

function sameBounds(a: ComputerBounds | undefined, b: ComputerBounds | undefined): boolean {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function describeNode(node: ComputerSnapshotNode): string {
  if (node.name !== undefined && node.name !== "") return `${node.role} "${node.name}"`;
  if (node.value !== undefined && node.value !== "") return `${node.role} value="${node.value}"`;
  return node.role;
}

function toSummaryFields(descriptor: ComputerRootDescriptor): Omit<ComputerRootSummary, "ref"> {
  return {
    kind: descriptor.kind,
    title: descriptor.title,
    app: descriptor.app,
    focused: descriptor.focused ?? false,
  };
}

function reject(
  reason: ComputerRefRejectionReason,
  code: ComputerError["code"],
  detail: string,
): ComputerRefResolution {
  return { ok: false, reason, error: { code, detail } };
}

export const COMPUTER_OUTLINE_MAX_DEPTH = 3;
export const COMPUTER_OUTLINE_MAX_CHILDREN = 25;

export interface ComputerOutlineView {
  readonly outline: string;

  readonly total: number;

  readonly folded: boolean;
}

export function renderComputerOutline(
  snapshot: ComputerSnapshot,
  start?: ComputerSnapshotNode,
): ComputerOutlineView {
  const root = start ?? snapshot.nodes[0];
  if (!root) return { outline: "", total: 0, folded: false };

  const childrenOf = new Map<ComputerRef, ComputerSnapshotNode[]>();
  for (const node of snapshot.nodes) {
    if (node.parentRef === undefined) continue;
    const siblings = childrenOf.get(node.parentRef) ?? [];
    siblings.push(node);
    childrenOf.set(node.parentRef, siblings);
  }

  const descendants = new Map<ComputerRef, number>();
  for (let index = snapshot.nodes.length - 1; index >= 0; index -= 1) {
    const node = snapshot.nodes[index];
    const children = childrenOf.get(node.ref) ?? [];
    let count = children.length;
    for (const child of children) count += descendants.get(child.ref) ?? 0;
    descendants.set(node.ref, count);
  }

  const lines: string[] = [];
  let folded = false;
  const visit = (node: ComputerSnapshotNode, level: number): void => {
    lines.push(`${"  ".repeat(level)}${outlineNodeLine(node)}`);
    const children = childrenOf.get(node.ref) ?? [];
    if (children.length === 0) return;
    if (level >= COMPUTER_OUTLINE_MAX_DEPTH) {
      folded = true;
      lines.push(
        `${"  ".repeat(level + 1)}... ${descendants.get(node.ref) ?? 0} more nodes under ${node.ref} (depth limit); ` +
          `use computer_inspect on ${node.ref} to expand`,
      );
      return;
    }
    const visible = children.slice(0, COMPUTER_OUTLINE_MAX_CHILDREN);
    for (const child of visible) visit(child, level + 1);
    if (children.length > visible.length) {
      folded = true;
      lines.push(
        `${"  ".repeat(level + 1)}... ${children.length - visible.length} more children of ${node.ref} (breadth limit); ` +
          "use computer_search to find them",
      );
    }
  };
  visit(root, 0);

  return { outline: lines.join("\n"), total: 1 + (descendants.get(root.ref) ?? 0), folded };
}

function outlineNodeLine(node: ComputerSnapshotNode): string {
  const name = node.name !== undefined ? ` "${node.name}"` : "";
  const value = node.value !== undefined ? ` value="${node.value}"` : "";
  return `${node.ref} ${node.role}${name}${value}`;
}

export interface ComputerTextSourceNode {
  readonly role: string;
  readonly name?: string;
  readonly value?: string;
  readonly description?: string;
  readonly text?: string;
}

export function scoreComputerNodeText(node: ComputerTextSourceNode, text: string): number | undefined {
  const needle = text.toLowerCase();
  const name = (node.name ?? "").toLowerCase();
  if (name === needle) return 0;
  if (name.startsWith(needle)) return 1;
  if (name.includes(needle)) return 2;
  const value = (node.value ?? "").toLowerCase();
  const description = (node.description ?? "").toLowerCase();
  const body = (node.text ?? "").toLowerCase();
  if (value.includes(needle) || description.includes(needle) || body.includes(needle)) return 3;
  return undefined;
}

export interface ComputerObservedFlatNode extends ComputerTextSourceNode {

  readonly path: readonly number[];
  readonly parentPath: readonly number[];
  readonly depth: number;
}

export function flattenObservedComputerTree(tree: ComputerObservedNode): readonly ComputerObservedFlatNode[] {
  const nodes: ComputerObservedFlatNode[] = [];
  const visit = (
    node: ComputerObservedNode,
    path: readonly number[],
    parentPath: readonly number[],
    depth: number,
  ): void => {
    nodes.push({
      path,
      parentPath,
      depth,
      role: node.role,
      ...(node.name !== undefined ? { name: node.name } : {}),
      ...(node.value !== undefined ? { value: node.value } : {}),
      ...(node.description !== undefined ? { description: node.description } : {}),
      ...(node.text !== undefined ? { text: node.text } : {}),
    });
    for (const [index, child] of (node.children ?? []).entries()) {
      visit(child, [...path, index], path, depth + 1);
    }
  };
  visit(tree, [], [], 0);
  return nodes;
}

export interface ComputerSubtreeIdentity {
  readonly path: readonly number[];
  readonly role: string;
  readonly name?: string;
}

function samePath(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((segment, index) => segment === b[index]);
}

export function locateObservedSubtree(
  nodes: readonly ComputerObservedFlatNode[],
  identity: ComputerSubtreeIdentity,
): ComputerObservedFlatNode | undefined {
  const located = nodes.find((node) => samePath(node.path, identity.path));
  if (!located) return undefined;
  if (located.role !== identity.role || (located.name ?? "") !== (identity.name ?? "")) return undefined;
  return located;
}

export function isPathPrefix(prefix: readonly number[], path: readonly number[]): boolean {
  return prefix.length <= path.length && prefix.every((segment, index) => segment === path[index]);
}
