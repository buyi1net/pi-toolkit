import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { Translator } from "../../i18n/index.ts";
import { COMPUTER_ERROR_MESSAGE_KEYS } from "./messages/index.ts";
import {
  COMPUTER_TEXT_BUDGET,
  type ComputerAction,
  type ComputerError,
  type ComputerExpectation,
  type ComputerResult,
  type ComputerWaitUntil,
} from "./contract.ts";

export {
  computerWaitPollDelayMs,
  describeWaitCondition,
  executeComputerWait,
  observedTextFound,
  snapshotScopeNodes,
  waitSleepSlices,
  windowRootFound,
} from "./wait-engine.ts";
export type { WaitCondition, WaitScope } from "./wait-engine.ts";
export { executeComputerRun } from "./run-engine.ts";
export { registerComputerTools } from "./registrations.ts";
export {
  renderAct,
  renderInspect,
  renderRead,
  renderRoots,
  renderRun,
  renderSearch,
  renderStatus,
  renderWait,
  renderObservation,
} from "./text-rendering.ts";
export {
  captureWithBudget,
  currentSnapshot,
  inspectSnapshotNode,
  nodeText,
  pickRoot,
  resolveSnapshotRef,
  searchSnapshot,
  toNodeSummary,
  toObserveCapture,
  treeCapabilityError,
  snapshotPath,
  isHighSurrogate,
  isLowSurrogate,
} from "./readers.ts";
export {
  coordinateSnapshotFor,
  logEntries,
  prepareActions,
} from "./actions.ts";
export {
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

export const OUTLINE_TRUNCATED_MARKER =
  "... outline truncated; use computer_search with this stateId to find elements by text or role";

const TRUNCATED_MARKER = "... truncated; narrow the query or act on what is already listed";

export interface ObserveParams {
  readonly root?: string;
  readonly capture?: boolean;
}
export interface SearchParams {
  readonly stateId: string;
  readonly text?: string;
  readonly role?: string;
  readonly limit?: number;
}
export interface InspectParams {
  readonly stateId: string;
  readonly ref: string;
}
export interface ActParams {
  readonly stateId: string;
  readonly actions: readonly ComputerAction[];
}
export interface ReadParams {
  readonly stateId: string;
  readonly ref: string;
  readonly offset?: number;
  readonly maxChars?: number;
}
export interface WaitWindowParams {
  readonly ref?: string;
  readonly title?: string;
  readonly app?: string;
}
export interface WaitParams {
  readonly stateId?: string;
  readonly text?: string;
  readonly ref?: string;
  readonly until?: ComputerWaitUntil;
  readonly window?: WaitWindowParams;
  readonly delayMs?: number;
  readonly timeoutMs?: number;
}
export interface RunStepParams {
  readonly actions?: readonly ComputerAction[];
  readonly expect?: ComputerExpectation;
}
export interface RunParams {
  readonly stateId: string;
  readonly steps: readonly RunStepParams[];
  readonly timeoutMs?: number;
}

export type ToolDetails<T> = ComputerResult<T>;

export function success<T>(data: T, text: string): AgentToolResult<ToolDetails<T>> {
  return { content: [{ type: "text", text }], details: { ok: true, data } };
}

export function failure<T>(t: Translator, tool: string, error: ComputerError, note = ""): AgentToolResult<ToolDetails<T>> {
  const message = t(COMPUTER_ERROR_MESSAGE_KEYS[error.code]);
  const detail = error.detail === undefined ? "" : `\nDetail: ${error.detail}`;
  const text = cap(`${tool} failed with ${error.code}: ${message}${detail}${note}`);
  return { content: [{ type: "text", text: text.text }], details: { ok: false, error }, isError: true };
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function cap(
  text: string,
  budget: number = COMPUTER_TEXT_BUDGET,
  marker: string = TRUNCATED_MARKER,
): { readonly text: string; readonly truncated: boolean } {
  if (text.length <= budget) return { text, truncated: false };
  const cut = text.slice(0, budget);
  const lastNewline = cut.lastIndexOf("\n");
  const body = lastNewline > 0 ? cut.slice(0, lastNewline) : cut;
  return { text: `${body}\n${marker}`, truncated: true };
}
