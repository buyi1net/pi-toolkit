import type { ComputerBackend } from "./backend.ts";
import {
  COMPUTER_CAPTURE_LONG_EDGE,
  COMPUTER_CAPTURE_MIN_LONG_EDGE,
  COMPUTER_IMAGE_BASE64_BUDGET,
  COMPUTER_OUTLINE_BUDGET,
  type ComputerError,
  type ComputerCaptureRecord,
  type ComputerInspectData,
  type ComputerNodeInspection,
  type ComputerNodeSummary,
  type ComputerObserveCapture,
  type ComputerResult,
  type ComputerRootSummary,
  type ElementRef,
  type RootRef,
} from "./contract.ts";
import { removeScreenshot } from "./screenshots.ts";
import {
  renderComputerOutline,
  scoreComputerNodeText,
  type ComputerSnapshot,
  type ComputerSnapshotNode,
  type ComputerStateStore,
} from "./state.ts";
import { cap, OUTLINE_TRUNCATED_MARKER, type SearchParams } from "./tools.ts";

const CAPTURE_MAX_RESAMPLES = 3;

const CAPTURE_BUDGET_HEADROOM = 0.9;

export async function captureWithBudget(
  backend: ComputerBackend,
  rootKey: string,
  path: string,
): Promise<ComputerResult<ComputerCaptureRecord>> {
  const fail = (error: ComputerError): ComputerResult<ComputerCaptureRecord> => {
    removeScreenshot(path);
    return { ok: false, error };
  };
  let maxLongEdge = COMPUTER_CAPTURE_LONG_EDGE;
  let resamples = 0;
  for (;;) {
    const captured = await backend.capture({ target: { kind: "window", key: rootKey }, path, maxLongEdge });
    if (!captured.ok) return fail(captured.error);
    const base64Length = base64LengthOf(captured.data.image.bytes);

    if (base64Length < COMPUTER_IMAGE_BASE64_BUDGET) return captured;

    const actualLongEdge = Math.max(captured.data.image.width, captured.data.image.height);
    const atFloor = actualLongEdge <= COMPUTER_CAPTURE_MIN_LONG_EDGE;
    if (resamples >= CAPTURE_MAX_RESAMPLES || atFloor) {

      const reason = atFloor
        ? `already at the ${COMPUTER_CAPTURE_MIN_LONG_EDGE}px long-edge floor after ${resamples} resample(s)`
        : `gave up after ${resamples} resample(s) (last long edge ${actualLongEdge}px)`;
      return fail({
        code: "action_failed",
        detail: `capture is still ${base64Length} base64 bytes, over the ${COMPUTER_IMAGE_BASE64_BUDGET}-byte host image budget; ${reason}`,
      });
    }

    const target = Math.floor(
      actualLongEdge * Math.sqrt((CAPTURE_BUDGET_HEADROOM * COMPUTER_IMAGE_BASE64_BUDGET) / base64Length),
    );
    const tightened = Math.min(actualLongEdge - 1, Math.max(COMPUTER_CAPTURE_MIN_LONG_EDGE, target));

    if (tightened >= maxLongEdge) {
      return fail({
        code: "action_failed",
        detail:
          `capture stays over the host image budget and tightening makes no progress: ` +
          `the reported long edge ${actualLongEdge}px is already over the requested long edge ${maxLongEdge}px`,
      });
    }
    resamples += 1;
    maxLongEdge = tightened;
  }
}

function base64LengthOf(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

export function toObserveCapture(capture: ComputerCaptureRecord): ComputerObserveCapture {
  return {
    path: capture.path,
    image: { ...capture.image },
    region: { ...capture.region },
    ...(capture.source !== undefined ? { source: capture.source } : {}),
    ...(capture.mayBeObscured !== undefined ? { mayBeObscured: capture.mayBeObscured } : {}),
  };
}

export function isHighSurrogate(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  return code >= 0xd800 && code <= 0xdbff;
}

export function isLowSurrogate(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff;
}

export function pickRoot(
  state: ComputerStateStore,
  discovered: readonly ComputerRootSummary[],
  requested: string | undefined,
): ComputerResult<{ readonly ref: RootRef; readonly key: string }> {
  if (requested === undefined) {
    const index = discovered.findIndex((root) => root.focused);
    const first = discovered[index >= 0 ? index : 0];
    if (!first) {
      return { ok: false, error: { code: "target_not_found", detail: "no operable root was found to observe" } };
    }

    const registered = state.findRoot(first.ref);
    if (!registered) {
      return { ok: false, error: { code: "target_not_found", detail: `root ${first.ref} was not registered` } };
    }
    return { ok: true, data: { ref: registered.ref, key: registered.key } };
  }
  const registered = state.findRoot(requested);
  if (!registered) {
    return {
      ok: false,
      error: {
        code: "target_not_found",
        detail: `${requested} is not a known root; call computer_roots again and use one of the returned refs`,
      },
    };
  }
  return { ok: true, data: { ref: registered.ref, key: registered.key } };
}

export function currentSnapshot(state: ComputerStateStore, stateId: string): ComputerResult<ComputerSnapshot> {
  const snapshot = state.snapshotOf(stateId);
  if (!snapshot || !state.isCurrent(stateId)) {
    return {
      ok: false,
      error: { code: "stale_ref", detail: `state ${stateId} is not the current observation; observe the root again` },
    };
  }
  return { ok: true, data: snapshot };
}

export function resolveSnapshotRef(
  state: ComputerStateStore,
  stateId: string,
  ref: string,
  options: { readonly elementOnly: boolean },
): ComputerResult<{ readonly snapshot: ComputerSnapshot; readonly node: ComputerSnapshotNode }> {
  const snapshot = currentSnapshot(state, stateId);
  if (!snapshot.ok) return snapshot;
  const resolved = state.resolveRef(stateId, ref);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  if (options.elementOnly && resolved.kind !== "element") {
    return {
      ok: false,
      error: {
        code: "invalid_params",
        detail: `${ref} is a root reference; this tool reads elements, pass an @eN reference`,
      },
    };
  }
  return { ok: true, data: { snapshot: snapshot.data, node: resolved.node } };
}

export function searchSnapshot(snapshot: ComputerSnapshot, query: SearchParams): readonly ComputerSnapshotNode[] {
  const role = query.role?.toLowerCase();
  const scored: { readonly node: ComputerSnapshotNode; readonly score: number }[] = [];
  for (const node of snapshot.nodes) {
    if (node.depth === 0) continue;
    if (role !== undefined && node.role.toLowerCase() !== role) continue;
    if (query.text === undefined) {
      scored.push({ node, score: 0 });
      continue;
    }
    const score = scoreComputerNodeText(node, query.text);
    if (score !== undefined) scored.push({ node, score });
  }

  return scored.sort((a, b) => a.score - b.score).map((entry) => entry.node);
}

export function toNodeSummary(node: ComputerSnapshotNode): ComputerNodeSummary {
  return {

    ref: node.ref as ElementRef,
    role: node.role,
    ...(node.name !== undefined ? { name: node.name } : {}),
    ...(node.value !== undefined ? { value: node.value } : {}),
  };
}

export function inspectSnapshotNode(snapshot: ComputerSnapshot, node: ComputerSnapshotNode): ComputerInspectData {
  const view = renderComputerOutline(snapshot, node);
  const outline = cap(view.outline, COMPUTER_OUTLINE_BUDGET, OUTLINE_TRUNCATED_MARKER);
  const inspection: ComputerNodeInspection = {
    ref: node.ref as ElementRef,
    role: node.role,
    ...(node.name !== undefined ? { name: node.name } : {}),
    ...(node.value !== undefined ? { value: node.value } : {}),
    ...(node.description !== undefined ? { description: node.description } : {}),
    enabled: node.enabled,
    focused: node.focused,
    ...(node.bounds ? { bounds: { ...node.bounds } } : {}),
    actions: [...node.actions],
  };
  return {
    node: inspection,
    outline: outline.text,
    nodeCount: view.total,
    truncated: view.folded || outline.truncated,
  };
}

export function nodeText(node: ComputerSnapshotNode): string {
  return node.text ?? node.value ?? node.name ?? "";
}

export async function treeCapabilityError(backend: ComputerBackend): Promise<ComputerError | undefined> {
  const status = await backend.status();
  if (!status.ok) return status.error;
  if (status.data.bridge.ready && !status.data.capabilities.accessibility) {
    return {
      code: "capability_unsupported",
      detail: "the native helper reports accessibility=false: no semantic tree to observe in this session",
    };
  }
  return undefined;
}

export function snapshotPath(snapshot: ComputerSnapshot, target: ComputerSnapshotNode): readonly number[] {
  const path: number[] = [];
  let current = target;
  let parentRef = current.parentRef;
  while (parentRef !== undefined) {
    const parent = snapshot.nodes.find((node) => node.ref === parentRef);
    if (!parent) break;
    const siblings = snapshot.nodes.filter((node) => node.parentRef === parentRef);
    path.unshift(siblings.indexOf(current));
    current = parent;
    parentRef = current.parentRef;
  }
  return path;
}
