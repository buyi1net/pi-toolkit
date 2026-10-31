import type { Component } from "@earendil-works/pi-tui";
import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { renderToolCardCall, renderToolCardResult, toolCardText, type ToolCardRenderContext } from "../../kit/tool-card.ts";
import type {
  ComputerActData,
  ComputerInspectData,
  ComputerObserveData,
  ComputerReadData,
  ComputerResult,
  ComputerRootSummary,
  ComputerRootsData,
  ComputerRunData,
  ComputerSearchData,
  ComputerStatusData,
  ComputerWaitData,
} from "./contract.ts";
import type {
  ActParams,
  InspectParams,
  ObserveParams,
  ReadParams,
  RunParams,
  SearchParams,
  ToolDetails,
  WaitParams,
} from "./tools.ts";

export function joinCardParts(parts: readonly (string | undefined)[]): string | undefined {
  const joined = parts.filter((part) => part !== undefined).join(" · ");
  return joined === "" ? undefined : joined;
}

function countCardPart(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

export function cardCall(
  title: string,
  object: string | undefined,
  theme: Theme,
  context: ToolCardRenderContext | undefined,
): Component {
  return renderToolCardCall(object === undefined ? { title } : { title, object }, theme, context);
}

export function cardStatusLine<T>(details: ToolDetails<T> | undefined, summarize: (data: T) => string | undefined): string | undefined {
  if (details === undefined) return undefined;
  return details.ok ? summarize(details.data) : `failed: ${details.error.code}`;
}

export function cardResult<T>(
  title: string,
  object: string | undefined,
  summarize: (data: T) => string | undefined,
  result: { readonly content: AgentToolResult<unknown>["content"]; readonly details: unknown },
  options: ToolRenderResultOptions,
  theme: Theme,
  context: ToolCardRenderContext | undefined,
): Component {
  const fullText = toolCardText(result);
  const status = cardStatusLine(result.details as ToolDetails<T> | undefined, summarize);
  return renderToolCardResult(
    { title, object, status, details: options.expanded && fullText !== "" ? fullText.split("\n") : [] },
    theme,
    options,
    context,
  );
}

export function observeCallObject(args: unknown): string | undefined {
  const params = args as ObserveParams | undefined;
  return joinCardParts([params?.root, ...(params?.capture === true ? ["capture"] : [])]);
}

export function searchCallObject(args: unknown): string | undefined {
  const params = args as SearchParams | undefined;
  return joinCardParts([
    params?.text !== undefined ? `text=${JSON.stringify(params.text)}` : undefined,
    params?.role !== undefined ? `role=${params.role}` : undefined,
  ]);
}

export function refCallObject(args: unknown): string | undefined {
  return (args as { readonly ref?: string } | undefined)?.ref;
}

export function actCallObject(args: unknown): string | undefined {
  const actions = (args as ActParams | undefined)?.actions;
  return actions === undefined ? undefined : countCardPart(actions.length, "action");
}

export function waitCallObject(args: unknown): string | undefined {
  const params = args as WaitParams | undefined;
  if (params?.text !== undefined) return "text";
  if (params?.window !== undefined) return "window";
  if (params?.delayMs !== undefined) return `delay ${params.delayMs}ms`;
  return undefined;
}

export function runCallObject(args: unknown): string | undefined {
  const steps = (args as RunParams | undefined)?.steps;
  return steps === undefined ? undefined : countCardPart(steps.length, "step");
}

export function statusCardLine(data: ComputerStatusData): string {
  return `helper ${data.bridge.ready ? "ready" : "not ready"} (${data.capabilities.platform})`;
}

export function rootsCardLine(data: ComputerRootsData): string {
  return countCardPart(data.roots.length, "root");
}

export function observeCardLine(data: ComputerObserveData): string | undefined {
  return joinCardParts([
    data.stateId,
    countCardPart(data.nodeCount, "node"),
    ...(data.truncated ? ["truncated"] : []),
  ]);
}

export function searchCardLine(data: ComputerSearchData): string {
  if (data.total === 0) return "no match";
  const shown = data.matches.length < data.total ? ` (${data.matches.length} shown)` : "";
  return `${countCardPart(data.total, "match")}${shown}`;
}

export function inspectCardLine(data: ComputerInspectData): string | undefined {
  return joinCardParts([`${data.node.ref} ${data.node.role}`, countCardPart(data.nodeCount, "node")]);
}

export function actCardLine(data: ComputerActData): string | undefined {
  return joinCardParts([
    data.stateId,
    data.changes.length > 0 ? countCardPart(data.changes.length, "change") : "no changes",
  ]);
}

export function readCardLine(data: ComputerReadData): string | undefined {
  if (data.text.length === 0) return data.truncated ? "empty page" : "no text";
  return joinCardParts([
    countCardPart(data.text.length, "char"),
    ...(data.nextOffset !== undefined ? [`more at offset ${data.nextOffset}`] : []),
  ]);
}

export function waitCardLine(data: ComputerWaitData): string | undefined {
  return joinCardParts([data.met ? "met" : "unmet", `${data.elapsedMs}ms`]);
}

export function runCardLine(data: ComputerRunData): string | undefined {
  return joinCardParts([
    data.status,
    `${countCardPart(data.completed, "step")} ok`,
    ...(data.failedStep !== undefined ? [`step ${data.failedStep} failed`] : []),
    ...(data.effectsUnknown ? ["effects unknown"] : []),
  ]);
}
