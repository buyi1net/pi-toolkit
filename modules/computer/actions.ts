import type {
  ComputerBackendAction,
  ComputerBackendObservation,
  ComputerBackendTarget,
  ComputerCoordinateSnapshot,
} from "./backend.ts";
import { imageFrameOf, imagePointToDesktop, isImagePointInFrame } from "./coordinates.ts";
import {
  COMPUTER_ACTION_CONTRACTS,
  parseComputerRef,
  type ComputerAction,
  type ComputerActionField,
  type ComputerError,
  type ComputerErrorCode,
  type ComputerResult,
  type ComputerStateId,
  type RootRef,
} from "./contract.ts";
import type { ComputerActionLogEntry } from "./log.ts";
import { snapshotPath } from "./readers.ts";
import type { ComputerSnapshot, ComputerStateStore } from "./state.ts";

export function logEntries(
  stateId: ComputerStateId,
  rootRef: RootRef,
  rootKey: string,
  actions: readonly ComputerBackendAction[],
  receipt: ComputerResult<ComputerBackendObservation>,
): readonly ComputerActionLogEntry[] {
  const outcome: "ok" | ComputerErrorCode = receipt.ok ? "ok" : receipt.error.code;
  const detail = receipt.ok ? undefined : receipt.error.detail;
  const time = new Date().toISOString();
  return actions.map((entry) => ({
    time,
    stateId,
    rootKey,
    rootRef,
    command: entry.command,
    ...(entry.target ? { target: entry.target } : {}),
    outcome,
    ...(detail !== undefined ? { detail } : {}),
  }));
}

export function coordinateSnapshotFor(snapshot: ComputerSnapshot, rootKey: string): ComputerCoordinateSnapshot | undefined {
  const capture = snapshot.capture;
  if (capture?.window === undefined || capture.window.key !== rootKey) return undefined;
  return {
    window: {
      key: capture.window.key,

      bounds: { ...(capture.window.bounds ?? capture.region) },
      ...(capture.window.pid !== undefined ? { pid: capture.window.pid } : {}),
      ...(capture.window.startIdentity !== undefined ? { startIdentity: { ...capture.window.startIdentity } } : {}),
      ...(capture.window.windowId !== undefined ? { windowId: capture.window.windowId } : {}),
      ...(capture.window.app !== undefined ? { app: capture.window.app } : {}),
    },
    capture: { image: { ...capture.image }, region: { ...capture.region } },
    ...(capture.displays !== undefined ? { displays: capture.displays.map((display) => ({ ...display })) } : {}),
  };
}

export function prepareActions(
  state: ComputerStateStore,
  stateId: string,
  snapshot: ComputerSnapshot,
  actions: readonly ComputerAction[],
): ComputerResult<readonly ComputerBackendAction[]> {
  const prepared: ComputerBackendAction[] = [];
  for (const [index, action] of actions.entries()) {
    const problem = validateAction(action);
    if (problem) {
      return {
        ok: false,
        error: { code: problem.code, detail: `action ${index + 1} (${action.action}): ${problem.detail ?? ""}` },
      };
    }
    let target: ComputerBackendTarget | undefined;
    if (action.ref !== undefined) {
      const resolved = state.resolveRef(stateId, action.ref);
      if (!resolved.ok) return { ok: false, error: resolved.error };
      target = {
        path: snapshotPath(snapshot, resolved.node),
        role: resolved.node.role,
        ...(resolved.node.name !== undefined ? { name: resolved.node.name } : {}),
      };
    }
    let command: ComputerAction = action;
    if (action.x !== undefined) {
      const converted = convertActionPoint(snapshot, action, index);
      if (!converted.ok) return { ok: false, error: converted.error };
      command = converted.data;
    }
    prepared.push({ command, ...(target ? { target } : {}) });
  }
  return { ok: true, data: prepared };
}

function convertActionPoint(
  snapshot: ComputerSnapshot,
  action: ComputerAction,
  index: number,
): ComputerResult<ComputerAction> {
  const capture = snapshot.capture;
  if (capture === undefined) {
    return {
      ok: false,
      error: {
        code: "invalid_params",
        detail:
          `action ${index + 1} (${action.action}): coordinate actions need the stateId of an observation taken ` +
          "with capture: true; this state has no image, observe again with capture",
      },
    };
  }
  const frame = imageFrameOf(capture);
  if (frame === undefined) {
    return {
      ok: false,
      error: {
        code: "invalid_params",
        detail:
          `action ${index + 1} (${action.action}): the capture bound to this state cannot be used for coordinate ` +
          "conversion; observe again with capture: true",
      },
    };
  }
  if (!isImagePointInFrame(frame, action.x!, action.y!)) {
    return {
      ok: false,
      error: {
        code: "invalid_params",
        detail: `action ${index + 1} (${action.action}): coordinate (${action.x}, ${action.y}) is outside the captured image ` +
          `[0, ${frame.imageWidth}) × [0, ${frame.imageHeight}); coordinates are never clamped`,
      },
    };
  }
  if (
    action.toX !== undefined &&
    action.toY !== undefined &&
    !isImagePointInFrame(frame, action.toX, action.toY)
  ) {
    return {
      ok: false,
      error: {
        code: "invalid_params",
        detail: `action ${index + 1} (${action.action}): drag endpoint (${action.toX}, ${action.toY}) is outside the captured image ` +
          `[0, ${frame.imageWidth}) × [0, ${frame.imageHeight}); coordinates are never clamped`,
      },
    };
  }
  const start = imagePointToDesktop(frame, action.x!, action.y!);
  const end =
    action.toX !== undefined && action.toY !== undefined
      ? imagePointToDesktop(frame, action.toX, action.toY)
      : undefined;
  const nativeRange = (point: { readonly x: number; readonly y: number }): boolean =>
    Number.isFinite(point.x) && Number.isFinite(point.y) &&
    point.x >= -2147483648 && point.x <= 2147483647 && point.y >= -2147483648 && point.y <= 2147483647;
  if (!nativeRange(start) || (end !== undefined && !nativeRange(end))) {
    return {
      ok: false,
      error: {
        code: "invalid_params",
        detail: `action ${index + 1} (${action.action}): converted screen point exceeds the native range; coordinates are never clamped`,
      },
    };
  }
  return {
    ok: true,
    data: {
      ...action,
      x: start.x,
      y: start.y,
      ...(end !== undefined ? { toX: end.x, toY: end.y } : {}),
    },
  };
}

const REQUIRED_FIELD_RULES: Readonly<
  Record<
    Exclude<ComputerActionField, "ref">,
    { readonly present: (action: ComputerAction) => boolean; readonly detail: string }
  >
> = {
  point: { present: (action) => action.x !== undefined && action.y !== undefined, detail: "needs x and y" },
  to: {
    present: (action) => action.toX !== undefined && action.toY !== undefined,
    detail: "needs toX and toY (the drag end)",
  },
  delta: {
    present: (action) => action.deltaX !== undefined || action.deltaY !== undefined,
    detail: "needs deltaX or deltaY",
  },
  text: { present: (action) => action.text !== undefined, detail: "needs text" },
  keys: {
    present: (action) => action.keys !== undefined && action.keys.length > 0,
    detail: "needs a non-empty keys array",
  },

  button: { present: (action) => action.button !== undefined, detail: "needs button" },
  count: { present: (action) => action.count !== undefined, detail: "needs count" },
};

function validateAction(action: ComputerAction): ComputerError | undefined {
  const contract = COMPUTER_ACTION_CONTRACTS[action.action];
  if (!contract) return { code: "invalid_params", detail: "unknown action" };
  const parsed = action.ref === undefined ? undefined : parseComputerRef(action.ref);
  if (action.ref !== undefined && !parsed) {
    return { code: "invalid_params", detail: `ref ${action.ref} is not a valid @rN/@eN reference` };
  }
  const hasPoint = action.x !== undefined || action.y !== undefined;
  switch (contract.target) {
    case "element":
      if (!parsed) return { code: "invalid_params", detail: "needs an explicit element target: pass ref @eN" };
      if (parsed.kind !== "element") {
        return { code: "invalid_params", detail: `needs an element target (@eN), got the root reference ${action.ref}` };
      }
      if (hasPoint) return { code: "invalid_params", detail: "this action takes a ref, not coordinates" };
      break;
    case "window":
      if (!parsed) {
        return {
          code: "invalid_params",
          detail: "needs an explicit target window: pass ref @rN; keyboard input is never sent to the current focus",
        };
      }
      if (parsed.kind !== "root") {
        return { code: "invalid_params", detail: `keyboard input needs a window target (@rN), got ${action.ref}` };
      }

      if (
        hasPoint ||
        action.toX !== undefined ||
        action.toY !== undefined ||
        action.deltaX !== undefined ||
        action.deltaY !== undefined
      ) {
        return { code: "invalid_params", detail: "keyboard input takes a window ref, not coordinates" };
      }
      break;
    case "element_or_point":
      if (!parsed && !hasPoint) {
        return { code: "invalid_params", detail: "needs an explicit target: ref @eN or x/y coordinates" };
      }
      if (parsed && hasPoint) {
        return { code: "invalid_params", detail: "pass either a ref or coordinates, not both" };
      }
      if (parsed && parsed.kind !== "element") {
        return { code: "invalid_params", detail: `needs an element target (@eN) or coordinates, got ${action.ref}` };
      }
      break;
    case "point":
      if (!hasPoint) return { code: "invalid_params", detail: "needs explicit coordinates: pass x and y" };
      if (parsed) {
        return { code: "invalid_params", detail: `this action takes x/y only; drop the ${action.ref} ref` };
      }
      break;
  }
  if (hasPoint && (action.x === undefined || action.y === undefined)) {
    return { code: "invalid_params", detail: "coordinates need both x and y" };
  }

  if ((action.button !== undefined || action.count !== undefined) && action.action !== "click") {
    return { code: "invalid_params", detail: "button/count only apply to coordinate clicks" };
  }
  if (
    parsed !== undefined &&
    ((action.button !== undefined && action.button !== "left") || (action.count !== undefined && action.count !== 1))
  ) {
    return {
      code: "invalid_params",
      detail: "element clicks do not take button/count; use coordinates for middle/right clicks and double clicks",
    };
  }
  for (const field of contract.requires) {

    if (field === "ref") continue;
    const rule = REQUIRED_FIELD_RULES[field];
    if (!rule.present(action)) return { code: "invalid_params", detail: rule.detail };
  }
  return undefined;
}
