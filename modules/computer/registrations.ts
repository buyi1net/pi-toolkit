import { join } from "node:path";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@earendil-works/pi-coding-agent";
import type { ModuleContext } from "../../kit/module.ts";
import {
  COMPUTER_OUTLINE_BUDGET,
  COMPUTER_READ_DEFAULT_CHARS,
  COMPUTER_SEARCH_DEFAULT_LIMIT,
  COMPUTER_TOOL_CONTRACTS,
  type ComputerToolContract,
  type ComputerActData,
  type ComputerCaptureRecord,
  type ComputerInspectData,
  type ComputerObserveData,
  type ComputerReadData,
  type ComputerRootsData,
  type ComputerRunData,
  type ComputerSearchData,
  type ComputerStateId,
  type ComputerStatusData,
  type ComputerWaitData,
} from "./contract.ts";
import type { ComputerBackend } from "./backend.ts";
import type { ComputerActionLogSink } from "./log.ts";
import {
  actCallObject,
  actCardLine,
  cardCall,
  cardResult,
  inspectCardLine,
  observeCallObject,
  observeCardLine,
  readCardLine,
  refCallObject,
  rootsCardLine,
  runCallObject,
  runCardLine,
  searchCallObject,
  searchCardLine,
  statusCardLine,
  waitCallObject,
  waitCardLine,
} from "./card-rendering.ts";
import {
  executeComputerWait,
} from "./wait-engine.ts";
import { executeComputerRun } from "./run-engine.ts";
import {
  renderAct,
  renderInspect,
  renderRead,
  renderObservation,
  renderRoots,
  renderSearch,
  renderStatus,
} from "./text-rendering.ts";
import {
  captureWithBudget,
  coordinateSnapshotFor,
  currentSnapshot,
  describeError,
  failure,
  inspectSnapshotNode,
  logEntries,
  nodeText,
  pickRoot,
  prepareActions,
  resolveSnapshotRef,
  searchSnapshot,
  success,
  toNodeSummary,
  OUTLINE_TRUNCATED_MARKER,
  toObserveCapture,
  treeCapabilityError,
  isHighSurrogate,
  isLowSurrogate,
} from "./tools.ts";
import { ensureScreenshotDir, removeScreenshot, screenshotFileName, sweepScreenshots, type ComputerScreenshotSettings } from "./screenshots.ts";
import { createComputerState, type ComputerStateStore } from "./state.ts";
import {
  cap,
  type ActParams,
  type InspectParams,
  type ObserveParams,
  type ReadParams,
  type RunParams,
  type SearchParams,
  type ToolDetails,
  type WaitParams,
} from "./tools.ts";

function promptMeta(contract: ComputerToolContract): { promptSnippet: string; promptGuidelines: string[] } {
  return { promptSnippet: contract.promptSnippet, promptGuidelines: [...contract.promptGuidelines] };
}

export function registerComputerTools(
  context: ModuleContext,
  backend: ComputerBackend,
  actionLog: ComputerActionLogSink,

  screenshots: ComputerScreenshotSettings,

  state: ComputerStateStore = createComputerState(),
): void {
  const t = context.t;
  const contracts = COMPUTER_TOOL_CONTRACTS;

  let pointerActivityThisTurn = false;
  const hideCursorAfterTurn = (): void => {
    if (!pointerActivityThisTurn) return;
    pointerActivityThisTurn = false;

    void backend.cursor(false).catch(() => undefined);
  };
  context.pi.on("turn_start", () => {
    pointerActivityThisTurn = false;
  });
  context.pi.on("turn_end", hideCursorAfterTurn);

  context.pi.registerTool({
    name: "computer_status",
    label: contracts.computer_status.title,
    description: contracts.computer_status.description,
    ...promptMeta(contracts.computer_status),
    parameters: contracts.computer_status.parameters,
    renderShell: "self",
    renderCall(_args, theme, context) {
      return cardCall(t("module.computer.tool.computer_status.display"), undefined, theme, context);
    },
    renderResult(result, options, theme, context) {
      return cardResult(
        t("module.computer.tool.computer_status.display"),
        undefined,
        statusCardLine,
        result,
        options,
        theme,
        context,
      );
    },
    executionMode: "sequential",
    async execute(): Promise<AgentToolResult<ToolDetails<ComputerStatusData>>> {
      const result = await backend.status();
      if (!result.ok) return failure(t, "computer_status", result.error);
      const text = cap(renderStatus(result.data));
      return success(result.data, text.text);
    },
  });

  context.pi.registerTool({
    name: "computer_roots",
    label: contracts.computer_roots.title,
    description: contracts.computer_roots.description,
    ...promptMeta(contracts.computer_roots),
    parameters: contracts.computer_roots.parameters,
    renderShell: "self",
    renderCall(_args, theme, context) {
      return cardCall(t("module.computer.tool.computer_roots.display"), undefined, theme, context);
    },
    renderResult(result, options, theme, context) {
      return cardResult(
        t("module.computer.tool.computer_roots.display"),
        undefined,
        rootsCardLine,
        result,
        options,
        theme,
        context,
      );
    },
    executionMode: "sequential",
    async execute(): Promise<AgentToolResult<ToolDetails<ComputerRootsData>>> {
      const discovered = await backend.roots();
      if (!discovered.ok) return failure(t, "computer_roots", discovered.error);
      const data: ComputerRootsData = { roots: state.registerRoots(discovered.data) };
      const text = cap(renderRoots(data.roots));
      return success(data, text.text);
    },
  });

  context.pi.registerTool({
    name: "computer_observe",
    label: contracts.computer_observe.title,
    description: contracts.computer_observe.description,
    ...promptMeta(contracts.computer_observe),
    parameters: contracts.computer_observe.parameters,
    renderShell: "self",
    renderCall(args, theme, context) {
      return cardCall(t("module.computer.tool.computer_observe.display"), observeCallObject(args), theme, context);
    },
    renderResult(result, options, theme, context) {
      return cardResult(
        t("module.computer.tool.computer_observe.display"),
        observeCallObject(context?.args),
        observeCardLine,
        result,
        options,
        theme,
        context,
      );
    },
    executionMode: "sequential",
    async execute(
      _toolCallId: string,
      params: ObserveParams,
    ): Promise<AgentToolResult<ToolDetails<ComputerObserveData>>> {

      const capability = await treeCapabilityError(backend);
      if (capability) return failure(t, "computer_observe", capability);
      const discovered = await backend.roots();
      if (!discovered.ok) return failure(t, "computer_observe", discovered.error);
      const summaries = state.registerRoots(discovered.data);
      const summary = pickRoot(state, summaries, params.root);
      if (!summary.ok) return failure(t, "computer_observe", summary.error);

      let capture: ComputerCaptureRecord | undefined;
      let capturePath: string | undefined;
      let stateId: ComputerStateId | undefined;
      if (params.capture === true) {
        stateId = state.nextStateId();
        capturePath = join(screenshots.dir, screenshotFileName(summary.data.key, stateId));
        try {

          ensureScreenshotDir(screenshots.dir);
        } catch (error) {
          return failure(t, "computer_observe", {
            code: "action_failed",
            detail: `cannot create screenshot directory: ${describeError(error)}`,
          });
        }
        const captured = await captureWithBudget(backend, summary.data.key, capturePath);
        if (!captured.ok) return failure(t, "computer_observe", captured.error);
        capture = captured.data;
      }

      const observed = await backend.observe(summary.data.key);
      if (!observed.ok) {

        if (capturePath !== undefined) removeScreenshot(capturePath);
        return failure(t, "computer_observe", observed.error);
      }

      let observation: ComputerObserveData;
      try {
        observation = state.observe({
          root: summary.data.ref,
          tree: observed.data.tree,
          ...(capture !== undefined ? { capture } : {}),
          ...(stateId !== undefined ? { stateId } : {}),
        });
      } catch (error) {

        if (capturePath !== undefined) removeScreenshot(capturePath);
        throw error;
      }

      if (capturePath !== undefined) {
        sweepScreenshots(screenshots.dir, summary.data.key, capturePath, screenshots.limitBytes);
      }

      const outline = cap(observation.outline, COMPUTER_OUTLINE_BUDGET, OUTLINE_TRUNCATED_MARKER);
      let data: ComputerObserveData = {
        ...observation,
        outline: outline.text,

        truncated: observation.truncated || outline.truncated || observed.data.truncated,
        ...(capture !== undefined ? { capture: toObserveCapture(capture) } : {}),
      };

      const text = cap(renderObservation(data));
      if (text.truncated) data = { ...data, truncated: true };
      return success(data, text.text);
    },
  });

  context.pi.registerTool({
    name: "computer_search",
    label: contracts.computer_search.title,
    description: contracts.computer_search.description,
    ...promptMeta(contracts.computer_search),
    parameters: contracts.computer_search.parameters,
    renderShell: "self",
    renderCall(args, theme, context) {
      return cardCall(t("module.computer.tool.computer_search.display"), searchCallObject(args), theme, context);
    },
    renderResult(result, options, theme, context) {
      return cardResult(
        t("module.computer.tool.computer_search.display"),
        searchCallObject(context?.args),
        searchCardLine,
        result,
        options,
        theme,
        context,
      );
    },
    executionMode: "sequential",
    async execute(
      _toolCallId: string,
      params: SearchParams,
    ): Promise<AgentToolResult<ToolDetails<ComputerSearchData>>> {
      if (params.text === undefined && params.role === undefined) {
        return failure(t, "computer_search", {
          code: "invalid_params",
          detail: "provide text or role (at least one); the schema cannot express this either-or",
        });
      }
      const snapshot = currentSnapshot(state, params.stateId);
      if (!snapshot.ok) return failure(t, "computer_search", snapshot.error);
      const matched = searchSnapshot(snapshot.data, params);
      const limit = params.limit ?? COMPUTER_SEARCH_DEFAULT_LIMIT;
      const data: ComputerSearchData = {
        matches: matched.slice(0, limit).map(toNodeSummary),
        total: matched.length,
      };
      const text = cap(renderSearch(data, params));
      return success(data, text.text);
    },
  });

  context.pi.registerTool({
    name: "computer_inspect",
    label: contracts.computer_inspect.title,
    description: contracts.computer_inspect.description,
    ...promptMeta(contracts.computer_inspect),
    parameters: contracts.computer_inspect.parameters,
    renderShell: "self",
    renderCall(args, theme, context) {
      return cardCall(t("module.computer.tool.computer_inspect.display"), refCallObject(args), theme, context);
    },
    renderResult(result, options, theme, context) {
      return cardResult(
        t("module.computer.tool.computer_inspect.display"),
        refCallObject(context?.args),
        inspectCardLine,
        result,
        options,
        theme,
        context,
      );
    },
    executionMode: "sequential",
    async execute(
      _toolCallId: string,
      params: InspectParams,
    ): Promise<AgentToolResult<ToolDetails<ComputerInspectData>>> {
      const resolved = resolveSnapshotRef(state, params.stateId, params.ref, { elementOnly: true });
      if (!resolved.ok) return failure(t, "computer_inspect", resolved.error);
      const data = inspectSnapshotNode(resolved.data.snapshot, resolved.data.node);
      const text = cap(renderInspect(data));
      return success(text.truncated ? { ...data, truncated: true } : data, text.text);
    },
  });

  context.pi.registerTool({
    name: "computer_act",
    label: contracts.computer_act.title,
    description: contracts.computer_act.description,
    ...promptMeta(contracts.computer_act),
    parameters: contracts.computer_act.parameters,
    renderShell: "self",
    renderCall(args, theme, context) {
      return cardCall(t("module.computer.tool.computer_act.display"), actCallObject(args), theme, context);
    },
    renderResult(result, options, theme, context) {
      return cardResult(
        t("module.computer.tool.computer_act.display"),
        actCallObject(context?.args),
        actCardLine,
        result,
        options,
        theme,
        context,
      );
    },
    executionMode: "sequential",
    async execute(_toolCallId: string, params: ActParams): Promise<AgentToolResult<ToolDetails<ComputerActData>>> {
      const snapshot = currentSnapshot(state, params.stateId);
      if (!snapshot.ok) return failure(t, "computer_act", snapshot.error);
      const prepared = prepareActions(state, params.stateId, snapshot.data, params.actions);
      if (!prepared.ok) return failure(t, "computer_act", prepared.error);

      if (
        prepared.data.some((entry) => entry.command.x !== undefined || entry.command.action === "scroll")
      ) {
        pointerActivityThisTurn = true;
      }

      const root = state.findRoot(snapshot.data.root);
      if (!root) {
        return failure(t, "computer_act", {
          code: "target_not_found",
          detail: `the observed root ${snapshot.data.root} is no longer registered`,
        });
      }
      const coordinateSnapshot = coordinateSnapshotFor(snapshot.data, root.key);
      const receipt = await backend.act({
        rootKey: root.key,
        actions: prepared.data,
        ...(coordinateSnapshot !== undefined ? { coordinateSnapshot } : {}),
      });

      let logNote = "";
      try {
        await actionLog(logEntries(params.stateId, snapshot.data.root, root.key, prepared.data, receipt));
      } catch (error) {
        logNote = `\n[action log write failed: ${describeError(error)}]`;
      }
      if (!receipt.ok) return failure(t, "computer_act", receipt.error, logNote);
      const next = state.observe({ root: snapshot.data.root, tree: receipt.data.tree });
      const data: ComputerActData = { stateId: next.stateId, changes: next.changes };

      const text = cap(`${renderAct(data, receipt.data.truncated)}${logNote}`);
      return success(data, text.text);
    },
  });

  context.pi.registerTool({
    name: "computer_read",
    label: contracts.computer_read.title,
    description: contracts.computer_read.description,
    ...promptMeta(contracts.computer_read),
    parameters: contracts.computer_read.parameters,
    renderShell: "self",
    renderCall(args, theme, context) {
      return cardCall(t("module.computer.tool.computer_read.display"), refCallObject(args), theme, context);
    },
    renderResult(result, options, theme, context) {
      return cardResult(
        t("module.computer.tool.computer_read.display"),
        refCallObject(context?.args),
        readCardLine,
        result,
        options,
        theme,
        context,
      );
    },
    executionMode: "sequential",
    async execute(
      _toolCallId: string,
      params: ReadParams,
    ): Promise<AgentToolResult<ToolDetails<ComputerReadData>>> {

      const resolved = resolveSnapshotRef(state, params.stateId, params.ref, { elementOnly: false });
      if (!resolved.ok) return failure(t, "computer_read", resolved.error);
      const node = resolved.data.node;

      const text = nodeText(node);
      const offset = params.offset ?? 0;
      const maxChars = params.maxChars ?? COMPUTER_READ_DEFAULT_CHARS;

      let end = offset + maxChars;
      if (end < text.length && isHighSurrogate(text, end - 1) && isLowSurrogate(text, end)) end -= 1;
      const chunk = text.slice(offset, end);
      const hasMore = offset + chunk.length < text.length;
      const data: ComputerReadData = {
        text: chunk,
        truncated: hasMore,
        ...(hasMore ? { nextOffset: offset + chunk.length } : {}),
      };
      return success(data, renderRead(node, data, offset, text.length));
    },
  });

  context.pi.registerTool({
    name: "computer_wait",
    label: contracts.computer_wait.title,
    description: contracts.computer_wait.description,
    ...promptMeta(contracts.computer_wait),
    parameters: contracts.computer_wait.parameters,
    renderShell: "self",
    renderCall(args, theme, context) {
      return cardCall(t("module.computer.tool.computer_wait.display"), waitCallObject(args), theme, context);
    },
    renderResult(result, options, theme, context) {
      return cardResult(
        t("module.computer.tool.computer_wait.display"),
        waitCallObject(context?.args),
        waitCardLine,
        result,
        options,
        theme,
        context,
      );
    },
    executionMode: "sequential",

    async execute(
      _toolCallId: string,
      params: WaitParams,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<ToolDetails<ComputerWaitData>> | undefined,
    ): Promise<AgentToolResult<ToolDetails<ComputerWaitData>>> {
      return executeComputerWait(t, state, backend, params, { signal, onUpdate });
    },
  });

  context.pi.registerTool({
    name: "computer_run",
    label: contracts.computer_run.title,
    description: contracts.computer_run.description,
    ...promptMeta(contracts.computer_run),
    parameters: contracts.computer_run.parameters,
    renderShell: "self",
    renderCall(args, theme, context) {
      return cardCall(t("module.computer.tool.computer_run.display"), runCallObject(args), theme, context);
    },
    renderResult(result, options, theme, context) {
      return cardResult(
        t("module.computer.tool.computer_run.display"),
        runCallObject(context?.args),
        runCardLine,
        result,
        options,
        theme,
        context,
      );
    },
    executionMode: "sequential",

    async execute(
      _toolCallId: string,
      params: RunParams,
      signal: AbortSignal | undefined,
    ): Promise<AgentToolResult<ToolDetails<ComputerRunData>>> {
      return executeComputerRun(t, state, backend, actionLog, params, {
        signal,

        markPointerActivity: () => {
          pointerActivityThisTurn = true;
        },
      });
    },
  });
}
