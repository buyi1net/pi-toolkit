import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import type { Translator } from "../../i18n/index.ts";
import type { ComputerBackend } from "./backend.ts";
import type {
  ComputerError,
  ComputerResult,
  ComputerStateId,
  ComputerWaitData,
  ComputerWaitUntil,
  ComputerRef,
  RootRef,
} from "./contract.ts";
import { COMPUTER_WAIT_DEFAULT_TIMEOUT_MS } from "./contract.ts";
import {
  flattenObservedComputerTree,
  isPathPrefix,
  locateObservedSubtree,
  scoreComputerNodeText,
  type ComputerObservedFlatNode,
  type ComputerObservedNode,
  type ComputerRootDescriptor,
  type ComputerSnapshot,
  type ComputerSnapshotNode,
  type ComputerStateStore,
  type ComputerSubtreeIdentity,
} from "./state.ts";
import type { ObserveParams, ToolDetails, WaitParams } from "./tools.ts";
import { currentSnapshot, failure, renderWait, snapshotPath, success, treeCapabilityError } from "./tools.ts";

const WAIT_FAST_LADDER_MS: readonly number[] = [150, 300, 500, 750, 1000];

const WAIT_SECOND_PHASE_MS = 30_000;
const WAIT_TWO_SECOND_PHASE_MS = 300_000;
const WAIT_SLOW_FLOOR_MS = 5_000;
const WAIT_SLOW_CEIL_MS = 15_000;

const WAIT_SLEEP_SLICE_MS = 250;
const WAIT_PROGRESS_INTERVAL_MS = 5_000;

export function computerWaitPollDelayMs(elapsedMs: number, round: number): number {
  if (round < WAIT_FAST_LADDER_MS.length) return WAIT_FAST_LADDER_MS[round];
  if (elapsedMs < WAIT_SECOND_PHASE_MS) return 1000;
  if (elapsedMs < WAIT_TWO_SECOND_PHASE_MS) return 2000;

  return Math.min(
    WAIT_SLOW_CEIL_MS,
    WAIT_SLOW_FLOOR_MS + 2_500 * Math.floor((elapsedMs - WAIT_TWO_SECOND_PHASE_MS) / 60_000),
  );
}

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function throwIfWaitAborted(signal: AbortSignal | undefined, tool = "computer_wait"): void {
  if (signal?.aborted) {
    throw new Error(`${tool} was cancelled before the condition was met`);
  }
}

export async function waitSleepSlices(
  totalMs: number,
  signal: AbortSignal | undefined,
  onSlice: () => void,
  tool = "computer_wait",
): Promise<void> {
  const end = Date.now() + totalMs;
  for (;;) {
    throwIfWaitAborted(signal, tool);
    onSlice();
    const remaining = end - Date.now();
    if (remaining <= 0) return;
    await sleepMs(Math.min(WAIT_SLEEP_SLICE_MS, remaining));
  }
}

export interface WaitScope {
  readonly identity: ComputerSubtreeIdentity;
  readonly ref: string;
}

export type WaitCondition =
  | {
      readonly kind: "text";
      readonly until: ComputerWaitUntil;
      readonly text: string;
      readonly scope?: WaitScope;
    }
  | {
      readonly kind: "window";
      readonly until: ComputerWaitUntil;

      readonly rootKey?: string;
      readonly ref?: string;
      readonly title?: string;
      readonly app?: string;
    }
  | { readonly kind: "delay"; readonly delayMs: number };

export function describeWaitCondition(condition: WaitCondition): string {
  switch (condition.kind) {
    case "text":
      return `text ${JSON.stringify(condition.text)} ${condition.until}${
        condition.scope !== undefined ? ` within ${condition.scope.ref}` : ""
      }`;
    case "window": {
      const parts = [
        condition.ref !== undefined ? `ref ${condition.ref}` : undefined,
        condition.title !== undefined ? `title containing ${JSON.stringify(condition.title)}` : undefined,
        condition.app !== undefined ? `app containing ${JSON.stringify(condition.app)}` : undefined,
      ].filter((part) => part !== undefined);
      return `root with ${parts.join(" and ")} ${condition.until}`;
    }
    case "delay":
      return `fixed delay of ${condition.delayMs}ms`;
  }
}

export function snapshotScopeNodes(
  snapshot: ComputerSnapshot,
  scopeNode: ComputerSnapshotNode | undefined,
): readonly ComputerSnapshotNode[] {
  if (scopeNode === undefined) return snapshot.nodes.filter((node) => node.depth > 0);
  const byParent = new Map<ComputerRef, ComputerSnapshotNode[]>();
  for (const node of snapshot.nodes) {
    if (node.parentRef === undefined) continue;
    const siblings = byParent.get(node.parentRef) ?? [];
    siblings.push(node);
    byParent.set(node.parentRef, siblings);
  }
  const collected: ComputerSnapshotNode[] = [];
  const walk = (node: ComputerSnapshotNode): void => {
    collected.push(node);
    for (const child of byParent.get(node.ref) ?? []) walk(child);
  };
  walk(scopeNode);
  return collected;
}

export function observedTextFound(
  nodes: readonly ComputerObservedFlatNode[],
  text: string,
  scope: ComputerSubtreeIdentity | undefined,
): boolean {
  let candidates: readonly ComputerObservedFlatNode[];
  if (scope === undefined) {
    candidates = nodes.filter((node) => node.depth > 0);
  } else {
    const located = locateObservedSubtree(nodes, scope);
    if (!located) return false;
    candidates = nodes.filter((node) => isPathPrefix(located.path, node.path));
  }
  return candidates.some((node) => scoreComputerNodeText(node, text) !== undefined);
}

export function windowRootFound(
  roots: readonly ComputerRootDescriptor[],
  condition: Extract<WaitCondition, { readonly kind: "window" }>,
): boolean {
  const title = condition.title?.toLowerCase();
  const app = condition.app?.toLowerCase();
  return roots.some((root) => {
    if (condition.rootKey !== undefined && root.key !== condition.rootKey) return false;
    if (title !== undefined && !root.title.toLowerCase().includes(title)) return false;
    if (app !== undefined && !root.app.toLowerCase().includes(app)) return false;
    return true;
  });
}

export function materializeWaitSnapshot(
  state: ComputerStateStore,
  root: RootRef,
  tree: ComputerObservedNode | undefined,
): ComputerStateId | undefined {
  if (tree === undefined) return undefined;
  return state.observe({ root, tree }).stateId;
}

export async function executeComputerWait(
  t: Translator,
  state: ComputerStateStore,
  backend: ComputerBackend,
  params: WaitParams,
  run: {
    readonly signal: AbortSignal | undefined;
    readonly onUpdate: AgentToolUpdateCallback<ToolDetails<ComputerWaitData>> | undefined;
  },
): Promise<AgentToolResult<ToolDetails<ComputerWaitData>>> {
  const fail = (error: ComputerError): AgentToolResult<ToolDetails<ComputerWaitData>> =>
    failure(t, "computer_wait", error);

  const selected = [
    params.text !== undefined ? "text" : undefined,
    params.window !== undefined ? "window" : undefined,
    params.delayMs !== undefined ? "delayMs" : undefined,
  ].filter((mode) => mode !== undefined);
  if (selected.length !== 1) {
    const what = selected.length === 0 ? "none was given" : `${selected.join(" and ")} were given together`;
    return fail({
      code: "invalid_params",
      detail: `exactly one of text, window or delayMs must be given (${what}); the schema cannot express this either-or`,
    });
  }
  throwIfWaitAborted(run.signal);

  const startedAt = Date.now();
  const elapsedMs = (): number => Date.now() - startedAt;

  let lastProgressAt = -WAIT_PROGRESS_INTERVAL_MS;
  const progressOf = (condition: WaitCondition) => (): void => {
    const now = elapsedMs();
    if (now - lastProgressAt < WAIT_PROGRESS_INTERVAL_MS) return;
    lastProgressAt = now;
    run.onUpdate?.({
      content: [
        {
          type: "text",
          text: `still waiting for ${describeWaitCondition(condition)}: ${Math.round(now / 1000)}s elapsed`,
        },
      ],
      details: { ok: true, data: { met: false, elapsedMs: now } },
    });
  };

  if (params.delayMs !== undefined) {
    if (params.stateId !== undefined) {
      return fail({ code: "invalid_params", detail: "the delayMs mode takes no stateId; it observes nothing" });
    }
    if (params.ref !== undefined || params.until !== undefined) {
      return fail({ code: "invalid_params", detail: "the delayMs mode takes no ref/until; it waits a fixed time" });
    }
    if (params.timeoutMs !== undefined) {
      return fail({
        code: "invalid_params",
        detail: "the delayMs mode takes no timeoutMs; the full delay always elapses",
      });
    }
    const condition: WaitCondition = { kind: "delay", delayMs: params.delayMs };
    await waitSleepSlices(params.delayMs, run.signal, progressOf(condition));
    const data: ComputerWaitData = { met: true, elapsedMs: elapsedMs() };
    return success(data, renderWait(data, condition));
  }

  if (params.stateId === undefined) {
    return fail({
      code: "invalid_params",
      detail: "the text and window modes need the stateId of the current observation",
    });
  }
  const snapshot = currentSnapshot(state, params.stateId);
  if (!snapshot.ok) return fail(snapshot.error);
  const root = state.findRoot(snapshot.data.root);
  if (!root) {
    return fail({
      code: "target_not_found",
      detail: `the observed root ${snapshot.data.root} is no longer registered`,
    });
  }
  const until: ComputerWaitUntil = params.until ?? "present";
  const timeoutMs = params.timeoutMs ?? COMPUTER_WAIT_DEFAULT_TIMEOUT_MS;

  if (params.text !== undefined) {

    const capability = await treeCapabilityError(backend);
    if (capability) return fail(capability);
    let scope: WaitScope | undefined;
    let scopeNode: ComputerSnapshotNode | undefined;
    if (params.ref !== undefined) {
      const resolved = state.resolveRef(params.stateId, params.ref);
      if (!resolved.ok) return fail(resolved.error);
      scope = {
        identity: {
          path: snapshotPath(snapshot.data, resolved.node),
          role: resolved.node.role,
          ...(resolved.node.name !== undefined ? { name: resolved.node.name } : {}),
        },
        ref: params.ref,
      };
      scopeNode = resolved.node;
    }
    const condition: WaitCondition = { kind: "text", until, text: params.text, ...(scope ? { scope } : {}) };

    const initialFound = snapshotScopeNodes(snapshot.data, scopeNode).some(
      (node) => scoreComputerNodeText(node, params.text!) !== undefined,
    );
    if (initialFound === (until === "present")) {
      const data: ComputerWaitData = { met: true, elapsedMs: elapsedMs() };
      return success(data, renderWait(data, condition));
    }

    const deadline = Date.now() + timeoutMs;
    const progress = progressOf(condition);
    const settle = async (met: boolean): Promise<AgentToolResult<ToolDetails<ComputerWaitData>>> => {

      if (lastTree === undefined) {
        const observed = await backend.observe(root.key);
        if (!observed.ok) {

          console.warn(
            `[pi-computer] computer_wait: the settling observe failed (${observed.error.code}` +
              `${observed.error.detail === undefined ? "" : `: ${observed.error.detail}`}); returning met without a stateId`,
          );
          const bare: ComputerWaitData = { met, elapsedMs: elapsedMs() };
          return success(bare, renderWait(bare, condition, true));
        }
        lastTree = observed.data.tree;
      }

      const stateId = materializeWaitSnapshot(state, snapshot.data.root, lastTree);
      const data: ComputerWaitData = { met, elapsedMs: elapsedMs(), ...(stateId !== undefined ? { stateId } : {}) };
      return success(data, renderWait(data, condition));
    };
    let lastTree: ComputerObservedNode | undefined;
    let probeUsable = true;
    let round = 0;
    for (;;) {
      if (round > 0) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return settle(false);
        await waitSleepSlices(Math.min(computerWaitPollDelayMs(elapsedMs(), round - 1), remaining), run.signal, progress);

        if (Date.now() >= deadline) return settle(false);
      }
      throwIfWaitAborted(run.signal);
      if (probeUsable) {
        const probed = await backend.probe({
          rootKey: root.key,
          text: params.text,
          ...(scope !== undefined
            ? {
                path: scope.identity.path,
                role: scope.identity.role,
                ...(scope.identity.name !== undefined ? { name: scope.identity.name } : {}),
              }
            : {}),
        });
        if (probed.ok) {
          if (probed.data === (until === "present")) return settle(true);
        } else if (probed.error.code === "capability_unsupported" || probed.error.code === "invalid_params") {
          probeUsable = false;

          console.warn(
            `[pi-computer] computer_wait: native text probe unavailable (${probed.error.code}` +
              `${probed.error.detail === undefined ? "" : `: ${probed.error.detail}`}); falling back to observe polling`,
          );
        } else {

          return fail(probed.error);
        }
      }
      if (!probeUsable) {

        const observed = await backend.observe(root.key);
        if (!observed.ok) return fail(observed.error);
        lastTree = observed.data.tree;
        const found = observedTextFound(flattenObservedComputerTree(observed.data.tree), params.text, scope?.identity);
        if (found === (until === "present")) return settle(true);
      }
      round += 1;
    }
  }

  if (params.window !== undefined) {

    if (params.ref !== undefined) {
      return fail({
        code: "invalid_params",
        detail: "the window mode takes no ref; match a root with window.ref, or scope a text wait with ref",
      });
    }
    const hasAnyField =
      params.window.ref !== undefined || params.window.title !== undefined || params.window.app !== undefined;
    if (!hasAnyField) {
      return fail({
        code: "invalid_params",
        detail: "the window condition needs at least one of ref, title or app; an empty condition never settles",
      });
    }
    let rootKey: string | undefined;
    if (params.window.ref !== undefined) {
      const registered = state.findRoot(params.window.ref);
      if (!registered) {
        return fail({
          code: "target_not_found",
          detail: `${params.window.ref} is not a known root; call computer_roots again and use one of the returned refs`,
        });
      }
      rootKey = registered.key;
    }
    const condition: WaitCondition = {
      kind: "window",
      until,
      ...(rootKey !== undefined ? { ref: params.window.ref, rootKey } : {}),
      ...(params.window.title !== undefined ? { title: params.window.title } : {}),
      ...(params.window.app !== undefined ? { app: params.window.app } : {}),
    };
    const windowCondition = condition as Extract<WaitCondition, { readonly kind: "window" }>;
    const conditionMet = (roots: readonly ComputerRootDescriptor[]): boolean => {
      const found = windowRootFound(roots, windowCondition);
      return until === "present" ? found : !found;
    };

    const deadline = Date.now() + timeoutMs;
    const progress = progressOf(condition);
    let round = 0;
    for (;;) {
      if (round > 0) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          const data: ComputerWaitData = { met: false, elapsedMs: elapsedMs() };
          return success(data, renderWait(data, condition));
        }
        await waitSleepSlices(Math.min(computerWaitPollDelayMs(elapsedMs(), round - 1), remaining), run.signal, progress);

        if (Date.now() >= deadline) {
          const data: ComputerWaitData = { met: false, elapsedMs: elapsedMs() };
          return success(data, renderWait(data, condition));
        }
      }
      throwIfWaitAborted(run.signal);
      const discovered = await backend.roots();
      if (!discovered.ok) return fail(discovered.error);
      if (conditionMet(discovered.data)) {
        const data: ComputerWaitData = { met: true, elapsedMs: elapsedMs() };
        return success(data, renderWait(data, condition));
      }
      round += 1;
    }
  }

  return fail({ code: "invalid_params", detail: "unreachable: wait mode selection" });
}
