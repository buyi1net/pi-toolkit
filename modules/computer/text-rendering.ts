import type {
  ComputerActData,
  ComputerBackgroundPointerApp,
  ComputerCapabilities,
  ComputerInspectData,
  ComputerNodeSummary,
  ComputerObserveCapture,
  ComputerObserveData,
  ComputerReadData,
  ComputerRootSummary,
  ComputerRunData,
  ComputerSearchData,
  ComputerStateChange,
  ComputerStatusData,
  ComputerWaitData,
} from "./contract.ts";
import type { ComputerSnapshotNode } from "./state.ts";
import type { WaitCondition } from "./wait-engine.ts";
import { describeWaitCondition } from "./wait-engine.ts";
import { cap, type SearchParams } from "./tools.ts";

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

const STATUS_LIMITS_APPS_MAX = 8;
const STATUS_LIMITS_UNVERIFIED_MAX = 12;

function capList(items: readonly string[], max: number, separator: string): string {
  if (items.length <= max) return items.join(separator);
  return `${items.slice(0, max).join(separator)}${separator}(+${items.length - max} more)`;
}

function renderBackgroundPointerApp(app: ComputerBackgroundPointerApp): string {
  return `${app.id}@${app.version} (${app.kind}) [${app.windowTypes.join(", ")}: ${app.eventTypes.join(", ")}]`;
}

function renderBackgroundPointerLimits(caps: ComputerCapabilities): string[] {
  if (caps.backgroundPointer === "none") return [];
  const limits = caps.backgroundPointerLimits;
  if (limits === undefined) {
    return [
      `background pointer evidence: missing (the helper reports ${caps.backgroundPointer} without a limits structure; ` +
        "treat the verified scope as unknown)",
    ];
  }
  const groups: string[] = [];
  if (limits.windowTypes.unverified.length > 0) {
    groups.push(`window types ${capList(limits.windowTypes.unverified, STATUS_LIMITS_UNVERIFIED_MAX, ", ")}`);
  }
  if (limits.eventTypes.unverified.length > 0) {
    groups.push(`events ${capList(limits.eventTypes.unverified, STATUS_LIMITS_UNVERIFIED_MAX, ", ")}`);
  }
  if (limits.coordinate.unverifiedCases.length > 0) {
    groups.push(`coordinate ${capList(limits.coordinate.unverifiedCases, STATUS_LIMITS_UNVERIFIED_MAX, ", ")}`);
  }
  const apps =
    limits.apps.length > 0
      ? capList(limits.apps.map(renderBackgroundPointerApp), STATUS_LIMITS_APPS_MAX, "; ")
      : "(none)";
  return [
    `background pointer evidence: ${limits.evidenceVersion} (${limits.evidenceDate})`,
    `background pointer apps: ${apps}`,
    `background pointer unverified: ${groups.length > 0 ? groups.join("; ") : "(none)"}`,

    `background pointer mechanism: ${limits.mechanism}`,
  ];
}

export function renderStatus(data: ComputerStatusData): string {
  const caps = data.capabilities;
  const permissions = Object.entries(caps.permissions)
    .map(([name, value]) => `${name}=${value}`)
    .join(", ");

  const limits = [...caps.limits, ...(caps.backgroundPointerLimits?.degradations ?? [])];
  return [
    `platform: ${caps.platform}`,
    `accessibility: ${yesNo(caps.accessibility)}`,
    `capture: ${yesNo(caps.capture)}`,
    `input: ${yesNo(caps.input)}`,
    `coordinate mode: ${caps.coordinateMode}`,
    `background keyboard: ${caps.backgroundInput}`,
    `background pointer: ${caps.backgroundPointer}`,
    ...renderBackgroundPointerLimits(caps),
    `permissions: ${permissions}`,
    `native helper: ${data.bridge.ready ? "ready" : "not ready"} (protocol version: ${data.bridge.protocolVersion ?? "none"})`,
    `limits: ${limits.length > 0 ? limits.join("; ") : "(none reported)"}`,
  ].join("\n");
}

export function renderRoots(roots: readonly ComputerRootSummary[]): string {
  if (roots.length === 0) return "No operable roots. Make sure the target application is running.";
  return [
    ...roots.map(
      (root) => `${root.ref} ${root.kind} "${root.title}" - ${root.app}${root.focused ? " (focused)" : ""}`,
    ),
    "Roots are discovery only: observe one with computer_observe to get a stateId.",
  ].join("\n");
}

export function renderObservation(data: ComputerObserveData): string {
  const lines = [
    `stateId: ${data.stateId}`,
    `root: ${data.root}, nodes: ${data.nodeCount}${data.truncated ? " (truncated)" : ""}`,
    ...(data.capture !== undefined ? [renderCapture(data.capture)] : []),
    data.outline,
  ];
  if (data.previousStateId !== undefined) {
    lines.push(`changes since ${data.previousStateId}:`);
    lines.push(...(data.changes.length > 0 ? data.changes.map(renderChange) : ["(none)"]));
  }
  lines.push("Refs (@rN/@eN) are valid only for this stateId; refs from the previous state are stale.");
  return lines.join("\n");
}

export function renderCapture(capture: ComputerObserveCapture): string {
  const region = capture.region;
  const fallback = capture.source === "screen_region" ? " - screen fallback, may be obscured by other windows" : "";
  return (
    `image: ${capture.path} (${capture.image.width}x${capture.image.height}, scale ${capture.image.scale}) ` +
    `region x=${region.x} y=${region.y} w=${region.width} h=${region.height}${fallback}; node bounds are pixels of this image`
  );
}

export function renderChange(change: ComputerStateChange): string {
  return `- ${change.kind} ${change.ref} ${change.summary}`;
}

export function renderSearch(data: ComputerSearchData, params: SearchParams): string {
  const query = [
    params.text === undefined ? undefined : `text=${JSON.stringify(params.text)}`,
    params.role === undefined ? undefined : `role=${params.role}`,
  ]
    .filter((part) => part !== undefined)
    .join(", ");
  if (data.matches.length === 0) return `No match for ${query} in this state.`;
  const lines = data.matches.map(renderNodeLine);
  if (data.total > data.matches.length) {
    lines.push(`... showing ${data.matches.length} of ${data.total} matches; raise limit or narrow the query`);
  }
  return lines.join("\n");
}

export function renderNodeLine(node: ComputerNodeSummary): string {
  const name = node.name === undefined ? "" : ` "${node.name}"`;
  const value = node.value === undefined ? "" : ` = "${node.value}"`;
  return `${node.ref} ${node.role}${name}${value}`;
}

export function renderAct(data: ComputerActData, nativeTruncated: boolean): string {
  const lines = [
    `stateId: ${data.stateId}`,
    "changes:",
    ...(data.changes.length > 0 ? data.changes.map(renderChange) : ["(none)"]),
  ];

  if (nativeTruncated) {
    lines.push("note: the native tree was truncated at its size limit; changes may be incomplete");
  }
  lines.push("Continue with this stateId; refs from the previous state are stale.");
  return lines.join("\n");
}

export function renderInspect(data: ComputerInspectData): string {
  const node = data.node;
  const name = node.name === undefined ? "" : ` "${node.name}"`;
  const value = node.value === undefined ? "" : ` value="${node.value}"`;
  const bounds =
    node.bounds === undefined
      ? ""
      : `; bounds: x=${node.bounds.x} y=${node.bounds.y} w=${node.bounds.width} h=${node.bounds.height}`;
  const lines = [
    `${node.ref} ${node.role}${name}${value}`,
    `enabled: ${yesNo(node.enabled)}; focused: ${yesNo(node.focused)}${bounds}`,
  ];
  if (node.description !== undefined) lines.push(`description: ${node.description}`);
  lines.push(`actions: ${node.actions.length > 0 ? node.actions.join(", ") : "(none)"}`);
  lines.push(`subtree: ${data.nodeCount} node(s)${data.truncated ? " (folded or truncated)" : ""}`);
  lines.push(data.outline);
  return lines.join("\n");
}

export function renderRead(node: ComputerSnapshotNode, data: ComputerReadData, offset: number, totalChars: number): string {
  const name = node.name === undefined ? "" : ` "${node.name}"`;
  const where = `${node.ref} ${node.role}${name}`;
  if (totalChars === 0) return `${where}: (no text)`;
  if (data.text.length === 0) {
    return `${where}: empty page — the text has ${totalChars} characters and offset ${offset} is past its end`;
  }
  const lines = [`${where}: characters ${offset + 1}-${offset + data.text.length} of ${totalChars}`, data.text];
  if (data.nextOffset !== undefined) lines.push(`... more text; continue with offset ${data.nextOffset}`);
  return lines.join("\n");
}

export function renderWait(
  data: ComputerWaitData,
  condition: WaitCondition,
  closingObservationFailed = false,
): string {
  const lines = [
    `met: ${yesNo(data.met)}`,
    `condition: ${describeWaitCondition(condition)}`,
    `elapsed: ${data.elapsedMs}ms${data.met ? "" : " (timed out)"}`,
  ];
  if (data.stateId !== undefined) {
    lines.push(`stateId: ${data.stateId}`);
    lines.push(
      data.met
        ? "Continue with this stateId; refs from the previous state are stale."
        : "The condition was not met before the timeout; this is the last observation during the wait.",
    );
  } else if (!data.met) {

    lines.push(
      closingObservationFailed
        ? "The condition was not met before the timeout; the closing observation failed, so no final stateId is available. Call computer_observe to see the current interface."
        : "The condition was not met before the timeout; the interface may still be busy.",
    );
  } else {

    if (condition.kind === "text")
      lines.push(
        closingObservationFailed
          ? "The wait settled, but the closing observation failed, so no stateId was produced. Call computer_observe to get current state."
          : "Satisfied by the given snapshot; no new observation was taken.",
      );
    if (condition.kind === "window") lines.push("Call computer_roots to pick up the change, then observe the root you need.");
    if (condition.kind === "delay") lines.push("A pure delay produces no new state; call computer_observe before acting again.");
  }

  return cap(lines.join("\n")).text;
}

export function renderRun(
  data: ComputerRunData,
  totalSteps: number,
  options: { readonly reusedStateId?: boolean; readonly cancelledInFlight?: boolean } = {},
): string {
  const lines = [`status: ${data.status}`, `steps: ${data.completed} of ${totalSteps} completed`];
  if (data.steps.length > 0) {
    lines.push(
      `step results: ${data.steps
        .map((step) => (step.ok ? "ok" : `failed (${step.error?.code ?? "unknown"})`))
        .join(", ")}`,
    );
  }
  if (data.failedStep !== undefined) {
    const failed = data.steps[data.failedStep - 1];
    if (failed !== undefined && !failed.ok && failed.error?.code === "expectation_failed") {
      lines.push(
        `step ${data.failedStep} failed: ${failed.error.detail ?? "expectation not met"}; ` +
          `${data.completed} step(s) completed before it`,
      );
    } else if (failed !== undefined && !failed.ok) {
      lines.push(`step ${data.failedStep} failed with ${failed.error?.code ?? "unknown"}`);
    } else {
      lines.push(`the run stopped at step ${data.failedStep}`);
    }
  }
  if (data.stateId === undefined) {

    lines.push(
      "The closing observation failed, so no final stateId is available. Call computer_observe to see the " +
        "current interface before acting.",
    );
  } else {
    lines.push(`stateId: ${data.stateId}`);
  }
  if (data.effectsUnknown) {
    lines.push(
      options.cancelledInFlight
        ? "The run was cancelled while a step's actions were in flight: whether they took effect is unknown. " +
            "This stateId may already be out of date — observe the root again before acting."
        : "Effects are unknown: this stateId may already be out of date — observe the root again before acting.",
    );
  } else if (data.stateId !== undefined && options.reusedStateId) {

    lines.push(
      data.status === "completed"
        ? "No step needed a new observation; the stateId above is the one passed to this call and is still current."
        : "The run stopped without a new observation; the stateId above is the one passed to this call.",
    );
  } else if (data.stateId !== undefined && data.status === "completed") {
    lines.push("Continue with this stateId; refs from the previous state are stale.");
  } else if (data.stateId !== undefined && data.status === "timeout") {
    lines.push(
      "The overall budget ran out; this stateId is the last trusted observation — observe again before continuing.",
    );
  } else if (data.stateId !== undefined) {
    lines.push("This stateId is the scene at the moment the run stopped; refs from the previous state are stale.");
  }
  return lines.join("\n");
}
