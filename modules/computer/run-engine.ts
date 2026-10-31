import type {
  AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import type { Translator } from "../../i18n/index.ts";
import {
  COMPUTER_RUN_DEFAULT_TIMEOUT_MS,
  COMPUTER_RUN_EXPECT_DEFAULT_TIMEOUT_MS,
  COMPUTER_RUN_MAX_STEP_ACTIONS,
  COMPUTER_RUN_MAX_STEPS,
  COMPUTER_RUN_MAX_TOTAL_ACTIONS,
  type ComputerError,
  type ComputerResult,
  type ComputerRunData,
  type ComputerRunStepResult,
  type ComputerStateId,
  type ComputerWaitUntil,
} from "./contract.ts";
import { parseComputerKeyEntries } from "./key-names.ts";
import {
  flattenObservedComputerTree,
  scoreComputerNodeText,
  type ComputerObservedNode,
  type ComputerSnapshotNode,
  type ComputerStateStore,
} from "./state.ts";
import {
  computerWaitPollDelayMs,
  describeWaitCondition,
  observedTextFound,
  snapshotScopeNodes,
  waitSleepSlices,
  windowRootFound,
  type WaitCondition,
  type WaitScope,
} from "./wait-engine.ts";
import type { ComputerBackend, ComputerBackendAction, ComputerBackendObservation } from "./backend.ts";
import type { ComputerActionLogSink } from "./log.ts";
import {
  cap,
  coordinateSnapshotFor,
  currentSnapshot,
  describeError,
  failure,
  logEntries,
  prepareActions,
  renderRun,
  snapshotPath,
  success,
  type RunParams,
  type ToolDetails,
} from "./tools.ts";

interface FrozenRunStep {
  readonly actions: readonly ComputerBackendAction[];
  readonly expect?: FrozenRunExpect;
}

type FrozenRunExpect =
  | {
      readonly kind: "text";
      readonly text: string;
      readonly until: ComputerWaitUntil;
      readonly timeoutMs: number;
      readonly scope?: WaitScope;

      readonly scopeNode?: ComputerSnapshotNode;
    }
  | {
      readonly kind: "window";
      readonly until: ComputerWaitUntil;
      readonly timeoutMs: number;

      readonly rootKey?: string;
      readonly ref?: string;
      readonly title?: string;
      readonly app?: string;
    };

function describeRunExpect(expect: FrozenRunExpect): string {
  if (expect.kind === "text") {
    return describeWaitCondition({
      kind: "text",
      until: expect.until,
      text: expect.text,
      ...(expect.scope !== undefined ? { scope: expect.scope } : {}),
    });
  }
  return describeWaitCondition({
    kind: "window",
    until: expect.until,
    ...(expect.rootKey !== undefined ? { ref: expect.ref, rootKey: expect.rootKey } : {}),
    ...(expect.title !== undefined ? { title: expect.title } : {}),
    ...(expect.app !== undefined ? { app: expect.app } : {}),
  });
}

const RUN_CANCELLED_IN_FLIGHT: ComputerError = {
  code: "bridge_timeout",
  detail:
    "the run was cancelled while this step's actions were in flight; whether they took effect is unknown — " +
    "observe the root again before retrying",
};

function runEffectsUnknown(error: ComputerError): boolean {
  return (
    error.code === "bridge_timeout" ||
    error.detail?.startsWith("user_interference_result_unknown:") === true ||
    error.detail?.startsWith("target_changed_result_unknown:") === true
  );
}

function throwIfRunAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("computer_run was cancelled before the remaining steps ran");
  }
}

async function raceRunActWithAbort(
  actPromise: Promise<ComputerResult<ComputerBackendObservation>>,
  signal: AbortSignal | undefined,
): Promise<ComputerResult<ComputerBackendObservation> | "cancelled"> {
  if (signal === undefined) return actPromise;
  let onAbort: () => void = () => {};
  const aborted = new Promise<"cancelled">((resolve) => {
    onAbort = () => resolve("cancelled");
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([actPromise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export async function executeComputerRun(
  t: Translator,
  state: ComputerStateStore,
  backend: ComputerBackend,
  actionLog: ComputerActionLogSink,
  params: RunParams,
  run: {
    readonly signal: AbortSignal | undefined;
    readonly markPointerActivity: () => void;
  },
): Promise<AgentToolResult<ToolDetails<ComputerRunData>>> {
  const fail = (error: ComputerError): AgentToolResult<ToolDetails<ComputerRunData>> =>
    failure(t, "computer_run", error);

  if (params.steps.length === 0) {
    return fail({ code: "invalid_params", detail: "steps must contain at least one step" });
  }
  if (params.steps.length > COMPUTER_RUN_MAX_STEPS) {
    return fail({
      code: "invalid_params",
      detail: `at most ${COMPUTER_RUN_MAX_STEPS} steps per run, got ${params.steps.length}`,
    });
  }
  let totalActions = 0;
  for (const [index, step] of params.steps.entries()) {
    const count = step.actions?.length ?? 0;
    if (count > COMPUTER_RUN_MAX_STEP_ACTIONS) {
      return fail({
        code: "invalid_params",
        detail: `step ${index + 1} has ${count} actions; at most ${COMPUTER_RUN_MAX_STEP_ACTIONS} per step`,
      });
    }
    totalActions += count;
    if (count === 0 && step.expect === undefined) {
      return fail({
        code: "invalid_params",
        detail: `step ${index + 1} is empty: give actions or an expect (the schema cannot express this either-or)`,
      });
    }
  }
  if (totalActions > COMPUTER_RUN_MAX_TOTAL_ACTIONS) {
    return fail({
      code: "invalid_params",
      detail: `at most ${COMPUTER_RUN_MAX_TOTAL_ACTIONS} actions per run, got ${totalActions}`,
    });
  }
  throwIfRunAborted(run.signal);

  const snapshotResult = currentSnapshot(state, params.stateId);
  if (!snapshotResult.ok) return fail(snapshotResult.error);
  const snapshot = snapshotResult.data;
  const root = state.findRoot(snapshot.root);
  if (!root) {
    return fail({
      code: "target_not_found",
      detail: `the observed root ${snapshot.root} is no longer registered`,
    });
  }

  for (const [index, step] of params.steps.entries()) {
    for (const [actionIndex, action] of (step.actions ?? []).entries()) {
      if (action.action !== "keypress" || action.keys === undefined) continue;
      const parsedKeys = parseComputerKeyEntries(action.keys);
      if (!parsedKeys.ok) {
        return fail({
          code: "invalid_params",
          detail: `step ${index + 1}, action ${actionIndex + 1} (keypress): ${parsedKeys.message}`,
        });
      }
    }
  }
  const frozen: FrozenRunStep[] = [];
  for (const [index, step] of params.steps.entries()) {
    let actions: readonly ComputerBackendAction[] = [];
    if (step.actions !== undefined && step.actions.length > 0) {
      const prepared = prepareActions(state, params.stateId, snapshot, step.actions);
      if (!prepared.ok) {
        return fail({ code: prepared.error.code, detail: `step ${index + 1}, ${prepared.error.detail ?? ""}` });
      }
      actions = prepared.data;
    }
    let expect: FrozenRunExpect | undefined;
    if (step.expect !== undefined) {
      const until = step.expect.until ?? "present";
      const timeoutMs = step.expect.timeoutMs ?? COMPUTER_RUN_EXPECT_DEFAULT_TIMEOUT_MS;
      const hasText = step.expect.text !== undefined;
      const hasWindow = step.expect.window !== undefined;
      if (hasText === hasWindow) {
        return fail({
          code: "invalid_params",
          detail:
            `step ${index + 1}: exactly one of expect.text or expect.window must be given ` +
            `(${hasText ? "both were" : "neither was"}); the schema cannot express this either-or`,
        });
      }
      if (hasWindow) {

        if (step.expect.ref !== undefined) {
          return fail({
            code: "invalid_params",
            detail: `step ${index + 1}: the window expect takes no ref; match a root with window.ref`,
          });
        }
        const window = step.expect.window!;
        if (window.ref === undefined && window.title === undefined && window.app === undefined) {
          return fail({
            code: "invalid_params",
            detail:
              `step ${index + 1}: the window expect needs at least one of ref, title or app; ` +
              "an empty condition never settles",
          });
        }

        let rootKey: string | undefined;
        if (window.ref !== undefined) {
          const registered = state.findRoot(window.ref);
          if (!registered) {
            return fail({
              code: "target_not_found",
              detail: `step ${index + 1}: ${window.ref} is not a known root; call computer_roots again and use one of the returned refs`,
            });
          }
          rootKey = registered.key;
        }
        expect = {
          kind: "window",
          until,
          timeoutMs,
          ...(rootKey !== undefined ? { rootKey, ref: window.ref } : {}),
          ...(window.title !== undefined ? { title: window.title } : {}),
          ...(window.app !== undefined ? { app: window.app } : {}),
        };
      } else {
        const text = step.expect.text!;
        let scope: WaitScope | undefined;
        let scopeNode: ComputerSnapshotNode | undefined;
        if (step.expect.ref !== undefined) {
          const resolved = state.resolveRef(params.stateId, step.expect.ref);
          if (!resolved.ok) {
            return fail({ code: resolved.error.code, detail: `step ${index + 1}: ${resolved.error.detail ?? ""}` });
          }
          scope = {
            identity: {
              path: snapshotPath(snapshot, resolved.node),
              role: resolved.node.role,
              ...(resolved.node.name !== undefined ? { name: resolved.node.name } : {}),
            },
            ref: step.expect.ref,
          };
          scopeNode = resolved.node;
        }
        expect = {
          kind: "text",
          text,
          until,
          timeoutMs,
          ...(scope !== undefined ? { scope } : {}),
          ...(scopeNode !== undefined ? { scopeNode } : {}),
        };
      }
    }
    frozen.push({ actions, ...(expect !== undefined ? { expect } : {}) });
  }

  if (
    frozen.some((step) =>
      step.actions.some((entry) => entry.command.x !== undefined || entry.command.action === "scroll"),
    )
  ) {
    run.markPointerActivity();
  }

  const runDeadline = Date.now() + (params.timeoutMs ?? COMPUTER_RUN_DEFAULT_TIMEOUT_MS);
  const stepResults: ComputerRunStepResult[] = [];
  const logNotes: string[] = [];
  let completed = 0;

  let treeFresh = true;
  let lastTree: ComputerObservedNode | undefined;
  let probeUsable = true;

  const evaluateRunExpect = async (
    expect: FrozenRunExpect,
  ): Promise<
    | { readonly outcome: "met" }
    | { readonly outcome: "expectation" }
    | { readonly outcome: "budget" }
    | { readonly outcome: "error"; readonly error: ComputerError }
  > => {
    const expectStartedAt = Date.now();
    const deadline = Math.min(expectStartedAt + expect.timeoutMs, runDeadline);
    if (expect.kind === "window") {

      const condition: Extract<WaitCondition, { readonly kind: "window" }> = {
        kind: "window",
        until: expect.until,
        ...(expect.rootKey !== undefined ? { ref: expect.ref, rootKey: expect.rootKey } : {}),
        ...(expect.title !== undefined ? { title: expect.title } : {}),
        ...(expect.app !== undefined ? { app: expect.app } : {}),
      };
      const wanted = expect.until === "present";
      let round = 0;
      for (;;) {

        if (Date.now() >= deadline) break;
        if (round > 0) {
          const remaining = deadline - Date.now();
          await waitSleepSlices(
            Math.min(computerWaitPollDelayMs(Date.now() - expectStartedAt, round - 1), remaining),
            run.signal,
            () => {},
            "computer_run",
          );
          if (Date.now() >= deadline) break;
        }
        throwIfRunAborted(run.signal);
        const discovered = await backend.roots();
        if (!discovered.ok) return { outcome: "error", error: discovered.error };
        if (windowRootFound(discovered.data, condition) === wanted) return { outcome: "met" };
        round += 1;
      }
      return Date.now() >= runDeadline ? { outcome: "budget" } : { outcome: "expectation" };
    }
    const wanted = expect.until === "present";
    const scope = expect.scope;

    if (treeFresh) {
      if (lastTree !== undefined) {
        if (observedTextFound(flattenObservedComputerTree(lastTree), expect.text, scope?.identity) === wanted) {
          return { outcome: "met" };
        }
      } else if (
        snapshotScopeNodes(snapshot, expect.scopeNode).some(
          (node) => scoreComputerNodeText(node, expect.text) !== undefined,
        ) === wanted
      ) {
        return { outcome: "met" };
      }
    } else if (Date.now() < deadline) {

      const observed = await backend.observe(root.key);
      if (!observed.ok) return { outcome: "error", error: observed.error };
      lastTree = observed.data.tree;
      treeFresh = true;
      if (observedTextFound(flattenObservedComputerTree(lastTree), expect.text, scope?.identity) === wanted) {
        return { outcome: "met" };
      }
    }
    let round = 0;
    for (;;) {

      if (Date.now() >= deadline) break;
      if (round > 0) {
        const remaining = deadline - Date.now();
        await waitSleepSlices(
          Math.min(computerWaitPollDelayMs(Date.now() - expectStartedAt, round - 1), remaining),
          run.signal,
          () => {},
          "computer_run",
        );
        if (Date.now() >= deadline) break;
      }
      throwIfRunAborted(run.signal);
      if (probeUsable) {
        const probed = await backend.probe({
          rootKey: root.key,
          text: expect.text,
          ...(scope !== undefined
            ? {
                path: scope.identity.path,
                role: scope.identity.role,
                ...(scope.identity.name !== undefined ? { name: scope.identity.name } : {}),
              }
            : {}),
        });
        if (probed.ok) {
          if (probed.data === wanted) {

            treeFresh = false;
            return { outcome: "met" };
          }
        } else if (probed.error.code === "capability_unsupported" || probed.error.code === "invalid_params") {
          probeUsable = false;
          console.warn(
            `[pi-computer] computer_run: native text probe unavailable (${probed.error.code}` +
              `${probed.error.detail === undefined ? "" : `: ${probed.error.detail}`}); falling back to observe polling`,
          );
        } else {
          return { outcome: "error", error: probed.error };
        }
      }
      if (!probeUsable) {
        const observed = await backend.observe(root.key);
        if (!observed.ok) return { outcome: "error", error: observed.error };
        lastTree = observed.data.tree;
        treeFresh = true;
        if (observedTextFound(flattenObservedComputerTree(lastTree), expect.text, scope?.identity) === wanted) {
          return { outcome: "met" };
        }
      }
      round += 1;
    }

    return Date.now() >= runDeadline ? { outcome: "budget" } : { outcome: "expectation" };
  };

  const finish = async (
    status: ComputerRunData["status"],
    options: { readonly failedStep?: number; readonly error?: ComputerError } = {},
  ): Promise<AgentToolResult<ToolDetails<ComputerRunData>>> => {
    const effectsUnknown = options.error !== undefined && runEffectsUnknown(options.error);

    let closingObservationFailed = false;
    if (!treeFresh && !effectsUnknown) {
      const observed = await backend.observe(root.key);
      if (observed.ok) {
        lastTree = observed.data.tree;
        treeFresh = true;
      } else {
        closingObservationFailed = true;
        console.warn(
          `[pi-computer] computer_run: the closing observe failed (${observed.error.code}` +
            `${observed.error.detail === undefined ? "" : `: ${observed.error.detail}`}); returning no stateId`,
        );
      }
    }

    let stateId: ComputerStateId | undefined;
    if (lastTree !== undefined) {
      stateId = state.observe({ root: snapshot.root, tree: lastTree }).stateId;
    } else if (!closingObservationFailed) {
      stateId = params.stateId;
    }
    const data: ComputerRunData = {
      ...(stateId !== undefined ? { stateId } : {}),
      status,
      completed,
      steps: [...stepResults],
      ...(options.failedStep !== undefined ? { failedStep: options.failedStep } : {}),
      effectsUnknown,
    };
    const text = cap(
      `${renderRun(data, frozen.length, {

        reusedStateId: stateId === params.stateId,

        cancelledInFlight: options.error === RUN_CANCELLED_IN_FLIGHT,
      })}${logNotes.join("")}`,
    );
    return success(data, text.text);
  };

  for (const [index, step] of frozen.entries()) {
    const stepNumber = index + 1;

    if (Date.now() >= runDeadline) {
      return finish("timeout", { failedStep: stepNumber });
    }

    if (step.actions.length > 0) {
      throwIfRunAborted(run.signal);
      const coordinateSnapshot = coordinateSnapshotFor(snapshot, root.key);
      const actPromise = Promise.resolve(
        backend.act({
          rootKey: root.key,
          actions: step.actions,
          ...(coordinateSnapshot !== undefined ? { coordinateSnapshot } : {}),
        }),
      );

      actPromise.catch(() => undefined);
      const receipt = await raceRunActWithAbort(actPromise, run.signal);
      if (receipt === "cancelled") {
        stepResults.push({ ok: false, error: RUN_CANCELLED_IN_FLIGHT });
        try {
          await actionLog(
            logEntries(params.stateId, snapshot.root, root.key, step.actions, {
              ok: false,
              error: RUN_CANCELLED_IN_FLIGHT,
            }),
          );
        } catch {
        }
        return finish("failed", { failedStep: stepNumber, error: RUN_CANCELLED_IN_FLIGHT });
      }

      try {
        await actionLog(logEntries(params.stateId, snapshot.root, root.key, step.actions, receipt));
      } catch (error) {
        logNotes.push(`\n[action log write failed: ${describeError(error)}]`);
      }
      if (!receipt.ok) {
        stepResults.push({ ok: false, error: receipt.error });

        treeFresh = false;
        return finish("failed", { failedStep: stepNumber, error: receipt.error });
      }
      lastTree = receipt.data.tree;
      treeFresh = true;
    }

    if (step.expect !== undefined) {

      throwIfRunAborted(run.signal);
      const outcome = await evaluateRunExpect(step.expect);
      if (outcome.outcome === "budget") {
        treeFresh = false;
        return finish("timeout", { failedStep: stepNumber });
      }
      if (outcome.outcome === "error") {
        stepResults.push({ ok: false, error: outcome.error });
        treeFresh = false;
        return finish("failed", { failedStep: stepNumber, error: outcome.error });
      }
      if (outcome.outcome === "expectation") {
        const error: ComputerError = {
          code: "expectation_failed",
          detail: `expected ${describeRunExpect(step.expect)} was not satisfied within ${step.expect.timeoutMs}ms`,
        };
        stepResults.push({ ok: false, error });

        treeFresh = false;
        return finish("failed", { failedStep: stepNumber, error });
      }
    }

    stepResults.push({ ok: true });
    completed += 1;
  }
  return finish("completed");
}
