import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import {
  compactRenderText,
  renderToolCardCall,
  renderToolCardResult,
  toolCardText,
  type ToolCardFailureLabels,
  type ToolCardRenderContext,
} from "../../kit/tool-card.ts";
import type { Translator } from "../../i18n/index.ts";
import { COMPUTER_ERROR_MESSAGE_KEYS } from "./messages/index.ts";
import type {
  ComputerActData,
  ComputerError,
  ComputerInspectData,
  ComputerObserveData,
  ComputerReadData,
  ComputerRootsData,
  ComputerRunData,
  ComputerRunStatus,
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

export function computerFailureLabels(t: Translator): ToolCardFailureLabels {
  const byCode: Record<string, string> = {};
  for (const [code, key] of Object.entries(COMPUTER_ERROR_MESSAGE_KEYS)) byCode[code] = t(key);
  return { fallback: t("module.computer.error.failed"), byCode };
}

export function cardCall(
  title: string,
  object: string | undefined,
  theme: Theme,
  context: ToolCardRenderContext | undefined,
): Component {
  return renderToolCardCall(object === undefined ? { title } : { title, object }, theme, context);
}

export function cardStatusLine<T>(
  details: ToolDetails<T> | undefined,
  summarize: (data: T) => string | undefined,
  labels: ToolCardFailureLabels,
): string | undefined {
  if (details === undefined) return undefined;
  if (details.ok) return summarize(details.data);
  const label = labels.byCode?.[details.error.code] ?? labels.fallback;
  return truncateToWidth(compactRenderText(label), 60, "…");
}

export function cardResult<T>(
  t: Translator,
  title: string,
  object: string | undefined,
  summarize: (data: T) => string | undefined,
  result: { readonly content: AgentToolResult<unknown>["content"]; readonly details: unknown },
  options: ToolRenderResultOptions,
  theme: Theme,
  context: ToolCardRenderContext | undefined,
  detailsLines?: (data: T) => readonly string[],
): Component {
  const details = result.details as ToolDetails<T> | undefined;
  const status = cardStatusLine(details, summarize, computerFailureLabels(t));
  const expandedLines = options.expanded
    ? details === undefined
      ? []
      : details.ok
        ? [...(detailsLines?.(details.data) ?? [])]
        : [failureDetailLine(t, details.error)]
    : [];
  return renderToolCardResult(
    { title, object, status, details: expandedLines },
    theme,
    options,
    context,
  );
}

function failureDetailLine(t: Translator, error: ComputerError): string {
  return t(COMPUTER_ERROR_MESSAGE_KEYS[error.code]);
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
  const params = (args as WaitParams | undefined);
  if (params?.text !== undefined) return "text";
  if (params?.window !== undefined) return "window";
  if (params?.delayMs !== undefined) return `delay ${params.delayMs}ms`;
  return undefined;
}

export function runCallObject(args: unknown): string | undefined {
  const steps = (args as RunParams | undefined)?.steps;
  return steps === undefined ? undefined : countCardPart(steps.length, "step");
}

function runStatusLabel(t: Translator, status: ComputerRunStatus): string {
  switch (status) {
    case "completed":
      return t("module.computer.card.statusCompleted");
    case "failed":
      return t("module.computer.card.statusFailed");
    case "timeout":
      return t("module.computer.card.statusTimeout");
  }
}

function platformLabel(t: Translator, platform: string): string {
  const key = `module.computer.card.platform.${platform}`;
  const label = t(key);
  return label === key ? platform : label;
}

export function statusCardLine(t: Translator, data: ComputerStatusData): string {
  const platform = platformLabel(t, data.capabilities.platform);
  return data.bridge.ready
    ? t("module.computer.card.helperReady", { platform })
    : t("module.computer.card.helperNotReady", { platform });
}

export function rootsCardLine(t: Translator, data: ComputerRootsData): string {
  return t("module.computer.card.roots", { count: data.roots.length });
}

export function observeCardLine(t: Translator, data: ComputerObserveData): string | undefined {
  return joinCardParts([
    t("module.computer.card.nodes", { count: data.nodeCount }),
    ...(data.truncated ? [t("module.computer.card.truncated")] : []),
  ]);
}

export function observeDetailsLines(t: Translator, data: ComputerObserveData): readonly string[] {
  return [
    t("module.computer.card.stateId", { stateId: data.stateId }),
    ...(data.capture !== undefined ? [t("module.computer.card.captureSaved", { path: data.capture.path })] : []),
  ];
}

export function searchCardLine(t: Translator, data: ComputerSearchData): string {
  if (data.total === 0) return t("module.computer.card.noMatch");
  const shown = data.matches.length < data.total
    ? ` (${t("module.computer.card.matchesShown", { count: data.matches.length })})`
    : "";
  return `${t("module.computer.card.matches", { count: data.total })}${shown}`;
}

export function inspectCardLine(t: Translator, data: ComputerInspectData): string | undefined {
  return joinCardParts([
    data.node.role,
    t("module.computer.card.nodes", { count: data.nodeCount }),
  ]);
}

export function inspectDetailsLines(t: Translator, data: ComputerInspectData): readonly string[] {
  return [`${data.node.ref} ${data.node.role}`];
}

export function actCardLine(t: Translator, data: ComputerActData): string | undefined {
  return data.changes.length > 0
    ? t("module.computer.card.changes", { count: data.changes.length })
    : t("module.computer.card.noChanges");
}

export function actDetailsLines(t: Translator, data: ComputerActData, logWriteError?: string): readonly string[] {
  return [
    t("module.computer.card.stateId", { stateId: data.stateId }),
    ...(logWriteError !== undefined ? [t("module.computer.card.logWriteFailed", { reason: logWriteError })] : []),
  ];
}

export function readCardLine(t: Translator, data: ComputerReadData): string | undefined {
  if (data.text.length === 0) return data.truncated ? t("module.computer.card.emptyPage") : t("module.computer.card.noText");
  return joinCardParts([
    t("module.computer.card.chars", { count: data.text.length }),
    ...(data.nextOffset !== undefined ? [t("module.computer.card.moreAtOffset", { offset: data.nextOffset })] : []),
  ]);
}

export function waitCardLine(t: Translator, data: ComputerWaitData): string | undefined {
  return joinCardParts([
    data.met ? t("module.computer.card.met") : t("module.computer.card.unmet"),
    `${data.elapsedMs}ms`,
  ]);
}

export function runCardLine(t: Translator, data: ComputerRunData): string | undefined {
  return joinCardParts([
    runStatusLabel(t, data.status),
    t("module.computer.card.stepsOk", { count: data.completed }),
    ...(data.failedStep !== undefined ? [t("module.computer.card.stepFailed", { step: data.failedStep })] : []),
    ...(data.effectsUnknown ? [t("module.computer.card.effectsUnknown")] : []),
  ]);
}
