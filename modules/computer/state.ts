// computer 模块状态层（工单 03）：观察产出的快照、引用分配与校验、快照差异。
//
// 作用域模型（规划书第 4、10 节）：
// - 一次观察产出一个 stateId 与一份不可变快照；快照里的根用 @rN、元素用 @eN，只在该作用域内有效；
// - 同一个根（root.key 相同）的后续观察用新一代快照取代旧快照，旧快照退役、其元素引用一律拒绝；
//   旧快照保留下来只为算差异（ComputerStateChange），不接受它的引用；
// - 不同根的作用域互不取代：一个作用域的引用拿到另一个作用域用属于跨作用域引用，同样拒绝。
//
// 拒绝路径与错误码（全部取自 contract.ts）：
// - 跨作用域引用 → wrong_scope：引用属于另一个作用域（另一个根），重新观察同一个根解决不了；
// - 旧快照引用 / stateId 已退役 → stale_ref；
// - 从未分配过的引用 → target_not_found；形态不是 @rN/@eN → invalid_params。
// 结果里另有结构化 reason（cross_scope / stale_snapshot / unknown_ref / invalid_format）用于区分排查。
// 引用判定只返回结论，不触发任何执行：执行方必须先拿到 ok 的结果才允许派发动作。
//
// 引用编号用 contract.ts 的 formatComputerRef，引用解析用 parseComputerRef；本层不重定义引用语法。
// 元素编号跨快照单调递增、永不复用（根编号按登记固定）：这是旧引用能被判成 stale 的前提——
// 若每份快照从 @e1 重排，旧 @e1 会静默命中新快照的另一个元素，正中规划书第 4 节要防的「点到别的位置」。
//
// 大纲折叠（工单 06）：观察与 computer_inspect 共用 renderComputerOutline 的折叠规则，
// 折叠只影响模型可见文本，快照与引用不受影响（被折叠的节点照样能 search / inspect / resolve）。

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

// ---------------------------------------------------------------------------
// 观察输入（原生层 / 假后端喂给状态层的语义树）
// ---------------------------------------------------------------------------

/** 后端观察到的一个节点；状态层负责补上引用与父子关系 */
export interface ComputerObservedNode {
  readonly role: string;
  readonly name?: string;
  readonly value?: string;
  readonly description?: string;
  readonly enabled?: boolean;
  readonly focused?: boolean;
  readonly bounds?: ComputerBounds;
  /** 元素暴露的动作，如 invoke / setValue / focus */
  readonly actions?: readonly string[];
  /** computer_read 的文本源（如文档正文）；缺省回退到 value、name */
  readonly text?: string;
  readonly children?: readonly ComputerObservedNode[];
}

/**
 * 根的身份与发现信息。key 是稳定身份（同一窗口/弹层每次发现都给同一个 key），
 * 状态层靠它复用 @rN 编号并把重复观察归到同一个作用域。
 */
export interface ComputerRootDescriptor {
  readonly key: string;
  readonly kind: ComputerRootKind;
  readonly title: string;
  readonly app: string;
  readonly focused?: boolean;
}

/** 已登记的根：根摘要 + 登记时的稳定身份（工具层拿 key 去后端定位观察目标） */
export interface ComputerRegisteredRoot extends ComputerRootSummary {
  readonly key: string;
}

export interface ComputerObservation {
  /** 要观察的根，取自 registerRoots 返回的 @rN */
  readonly root: RootRef;
  readonly tree: ComputerObservedNode;
  /**
   * 这次观察绑定的采集记录（工单 17，带图观察时由工具层传入）：
   * 节点 bounds 按它的图面坐标系换算；缺席就是无图快照，不带 bounds。
   * 记录自相矛盾、或记录的是别的窗口时，observe 直接抛出 RangeError，不静默降级。
   */
  readonly capture?: ComputerCaptureRecord;
  /**
   * 预生成的 stateId（工单 19，带图采集时由工具层传入）：截图文件名要含 stateId，
   * 工具层先拿 nextStateId 命名文件，再带同一个 id 来 observe。
   * 缺席时照旧由状态层随机生成；已被占用的 id 直接拦下（否则图与快照会互相覆盖）。
   */
  readonly stateId?: ComputerStateId;
}

// ---------------------------------------------------------------------------
// 快照（状态层保存、对调用方只读的公开结构）
// ---------------------------------------------------------------------------

/** 快照节点：引用 + 后端给的语义字段 + 结构定位用的 parentRef / depth */
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
  /** computer_read 的文本源（如文档正文）；缺省回退到 value、name */
  readonly text?: string;
}

export interface ComputerSnapshot {
  readonly stateId: ComputerStateId;
  /** 本次观察的根引用；同一根跨多次观察保持同一个 @rN */
  readonly root: RootRef;
  /** 所属作用域的观察代数，每次观察加一 */
  readonly generation: number;
  /** 前序遍历，根节点在最前 */
  readonly nodes: readonly ComputerSnapshotNode[];
  /** 本次观察绑定的采集记录（工单 17）；与 stateId 一一对应，旧图新图不混用 */
  readonly capture?: ComputerCaptureRecord;
}

// ---------------------------------------------------------------------------
// 引用判定
// ---------------------------------------------------------------------------

/**
 * 拒绝原因（结构化，比错误码细一档）：
 * - invalid_format：不是 @rN/@eN 形态
 * - stale_snapshot：引用属于同一作用域的旧快照，或 stateId 本身已退役
 * - cross_scope：引用属于另一个作用域（另一个根）
 * - unknown_ref：从未分配过的引用
 */
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
  /** 登记或刷新发现到的根；key 相同复用原 @rN，新 key 从 @r1 递增分配 */
  registerRoots(roots: readonly ComputerRootDescriptor[]): readonly ComputerRootSummary[];
  /** 按根引用查已登记的根；未登记或形态不对返回 undefined（工具层校验模型输入用） */
  findRoot(ref: unknown): ComputerRegisteredRoot | undefined;
  /**
   * 预生成一个 stateId（工单 19）：带图采集时要先把 id 写进截图文件名，再拿它来 observe。
   * 每次调用给新值；同一个 id 只能 observe 一次（重复会让图与快照互相覆盖）。
   */
  nextStateId(): ComputerStateId;
  /**
   * 观察一次：分配 stateId 与引用，返回快照回执；同一根的下一次观察让本次快照退役。
   * root 必须是 findRoot 能查到的已登记 @rN；未登记属调用方编程错误，直接抛 RangeError。
   */
  observe(observation: ComputerObservation): ComputerObserveData;
  /** 按 stateId 取回已保存的快照（含已退役的，用于算差异）；有效性由 resolveRef 判定 */
  snapshotOf(stateId: ComputerStateId): ComputerSnapshot | undefined;
  /** stateId 是否还是当前快照（未被下一次观察取代）：查询类工具判作用域用，引用仍由 resolveRef 判 */
  isCurrent(stateId: ComputerStateId): boolean;
  /** 校验引用属于该 stateId 的当前快照；拒绝时给出错误码与结构化原因 */
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
  // 简化：不回收快照，历史快照全部留着，让旧引用能稳定判成 stale 而不是 unknown；
  // 模型面预算已在工单 18（P2）定稿；快照逐出与保留窗口留 P7（快照裁剪策略），到那时再按保留窗口回收。
  const records = new Map<ComputerStateId, SnapshotRecord>();
  /** 元素引用 → 分配它的快照；用来把「旧快照引用」和「跨作用域引用」分开 */
  const elementOwner = new Map<ComputerRef, ComputerStateId>();
  let rootIndex = 0;
  // 全局单调、永不复用：旧引用因此永远不会与后续快照的元素撞号（见文件头的作用域模型）
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
    // 带图采集用工具层预生成的 id（截图文件名先写好）；不传就照旧随机生成
    const stateId = observation.stateId ?? randomUUID();
    if (records.has(stateId)) {
      // 复用会让新快照覆盖旧记录，命名相同的两张图也就分不清谁是谁，当场拦下
      throw new RangeError(`stateId 已被占用：${stateId}；每次观察必须用 nextStateId 取新 id`);
    }
    const generation = scope.generation + 1;
    const capture = observation.capture !== undefined ? cloneCapture(observation.capture) : undefined;
    let frame: ComputerImageFrame | undefined;
    if (capture !== undefined) {
      // 图与快照必须同源：记录的是别的窗口、或字段自相矛盾，都当场拒绝，不静默丢坐标
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

    // 不在当前快照：根引用按作用域查，元素引用按分配记录查
    if (parsed.kind === "root") {
      // contract 的 ComputerRefParts 不用判别联合，kind 与 ref 类型不联动，这里按 kind 手动收窄
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
    // 同一作用域里只有当前快照（引用代 == scope.generation）接受引用，代次落后即旧快照引用
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
        // 无图快照不带 bounds（工单 17）：坐标只在图面坐标系里有意义
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

// ---------------------------------------------------------------------------
// 快照差异：按结构身份（role + name 的路径）配对，值/描述/状态变化算 updated
// ---------------------------------------------------------------------------

/** 采集记录按值拷进快照：快照不可变，外面改原对象不能反过来改到状态层 */
function cloneCapture(capture: ComputerCaptureRecord): ComputerCaptureRecord {
  return {
    path: capture.path,
    image: { ...capture.image },
    region: { ...capture.region },
    ...(capture.display !== undefined ? { display: { ...capture.display } } : {}),
    ...(capture.window !== undefined ? { window: { ...capture.window } } : {}),
    ...(capture.source !== undefined ? { source: capture.source } : {}),
    ...(capture.mayBeObscured !== undefined ? { mayBeObscured: capture.mayBeObscured } : {}),
  };
}

/** 对比两份快照；added/updated 用新快照的引用，removed 用旧快照的引用 */
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

/**
 * 结构身份 = 从根到节点的每段 `role|name#同 token 兄弟序号`。
 * 引用每次观察都会重新编号，跨快照配对只能靠结构；name 相同的兄弟靠序号区分。
 */
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

/** 大纲折叠上限（工单 06 定案）：起点之下最多三层，每个节点最多 25 个孩子 */
export const COMPUTER_OUTLINE_MAX_DEPTH = 3;
export const COMPUTER_OUTLINE_MAX_CHILDREN = 25;

/** 子树大纲的渲染结果 */
export interface ComputerOutlineView {
  readonly outline: string;
  /** 子树节点总数（含起点） */
  readonly total: number;
  /** 有节点因深度或宽度上限没进大纲时为 true */
  readonly folded: boolean;
}

/**
 * 渲染一棵子树的大纲：起点自己一行，孩子按前序缩进。
 * 折叠规则：起点之下最多 COMPUTER_OUTLINE_MAX_DEPTH 层；每个节点最多 COMPUTER_OUTLINE_MAX_CHILDREN 个孩子。
 * 折叠处留一行标注，点明隐藏数量与继续用的工具（深度折叠用 computer_inspect，宽度折叠用 computer_search）。
 */
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
  // 后代总数（不含自己）：逆前序累加，避免每个折叠点重数一遍子树
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

// ---------------------------------------------------------------------------
// 等待原语的纯函数（工单 28）：文本匹配与摊平观察树，供工具层轮询复用。
// 轮询每轮拿 backend.observe 的原 tree 做内存匹配，不分配引用、不登记状态
// （不调 store.observe，命中/超时才由工具层物化一份快照）；这里因此不能碰
// elementIndex / elementOwner 这类状态生命周期路径。
// ---------------------------------------------------------------------------

/** 文本匹配所需的最小节点面：快照节点与摊平的观察节点都满足 */
export interface ComputerTextSourceNode {
  readonly role: string;
  readonly name?: string;
  readonly value?: string;
  readonly description?: string;
  readonly text?: string;
}

/**
 * 单节点文本命中评分：与工具层 computer_search 同一口径（工单 28 抽出共用）。
 * 返回 undefined 表示不命中；0=name 全等、1=name 前缀、2=name 包含、
 * 3=value/description/text 包含。大小写不敏感。
 */
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

/** 摊平后的观察节点：轮询匹配的底座。path 与后端 target.path 同口径（根是 []） */
export interface ComputerObservedFlatNode extends ComputerTextSourceNode {
  /** 从根起的子节点下标链；[] 是根本身 */
  readonly path: readonly number[];
  readonly parentPath: readonly number[];
  readonly depth: number;
}

/** 把一棵原生观察树摊平（前序，根在最前）；纯函数，不分配引用、不改状态 */
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

/**
 * 子树身份：首判时从调用方快照记下，轮询每轮按它在最新树里重新定位。
 * 身份 = path + role + name 三者全中（与后端执行前核对目标的口径一致）：
 * 路径对但角色/名字变了，说明那个位置已是别的东西，按「子树不存在」处理。
 */
export interface ComputerSubtreeIdentity {
  readonly path: readonly number[];
  readonly role: string;
  readonly name?: string;
}

function samePath(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((segment, index) => segment === b[index]);
}

/** 按身份在摊平树里重新定位子树根；定位不到返回 undefined（子树不存在） */
export function locateObservedSubtree(
  nodes: readonly ComputerObservedFlatNode[],
  identity: ComputerSubtreeIdentity,
): ComputerObservedFlatNode | undefined {
  const located = nodes.find((node) => samePath(node.path, identity.path));
  if (!located) return undefined;
  if (located.role !== identity.role || (located.name ?? "") !== (identity.name ?? "")) return undefined;
  return located;
}

/** path 是否以 prefix 开头（含相等）；子树 descendant 判定用 */
export function isPathPrefix(prefix: readonly number[], path: readonly number[]): boolean {
  return prefix.length <= path.length && prefix.every((segment, index) => segment === path[index]);
}
