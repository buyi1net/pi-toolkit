import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";

export type ToolCardStatus = "pending" | "success" | "error";

export interface ToolCardRenderContext {
  readonly state?: Record<string, unknown>;
  readonly executionStarted?: boolean;
  readonly outputPad?: number;
  readonly isPartial?: boolean;
  readonly isError?: boolean;
  readonly expanded?: boolean;
  readonly invalidate?: () => void;
}

export interface ToolCardContext {
  readonly context?: ToolCardRenderContext;
  readonly theme: Theme;
}

export interface ToolCardContent {
  readonly title: string;
  readonly object?: string;
  readonly status?: string;
  readonly details?: readonly string[];
}

function statusToken(
  context: ToolCardRenderContext | undefined,
  fallback: ToolCardStatus,
): "toolPendingBg" | "toolErrorBg" | "toolSuccessBg" {
  if (context?.isPartial) return "toolPendingBg";
  if (context?.isError) return "toolErrorBg";
  return fallback === "error" ? "toolErrorBg" : fallback === "pending" ? "toolPendingBg" : "toolSuccessBg";
}

function normalizePart(value: string | undefined): string | undefined {
  const text = value?.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.replace(/^◆\s*/, "");
}

export function formatToolCardLine(content: ToolCardContent): string {
  const parts = [content.title, content.object, content.status]
    .map(normalizePart)
    .filter((part): part is string => part !== undefined);
  return `◆ ${parts.join(" · ")}`;
}

export function compactRenderText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

export function compactSegment(value: string | undefined, width: number): string | undefined {
  const text = compactRenderText(value);
  return text ? truncateToWidth(text, width, "…") : undefined;
}

export interface ToolCardTextPart {
  readonly type?: unknown;
  readonly text?: unknown;
}

export interface ToolCardTextResult {
  readonly content?: ReadonlyArray<ToolCardTextPart>;
}

export function toolCardText(result: ToolCardTextResult | undefined): string {
  const part = result?.content?.find((candidate) => candidate?.type === "text");
  return typeof part?.text === "string" ? part.text : "";
}

export function toolCardTextLines(result: ToolCardTextResult | undefined): string[] {
  const text = toolCardText(result);
  return text ? text.split("\n") : [];
}

function cardBox(
  content: ToolCardContent,
  theme: Theme,
  context: ToolCardRenderContext | undefined,
  fallbackStatus: ToolCardStatus,
  expanded: boolean,
): Component {
  const lines = [formatToolCardLine(content)];
  if (expanded && content.details && content.details.length > 0) lines.push(...content.details);
  const bg = typeof (theme as Theme & { bg?: unknown }).bg === "function"
    ? (text: string) => theme.bg(statusToken(context, fallbackStatus), text)
    : (text: string) => text;
  const box = new Box(context?.outputPad ?? 1, 1, bg);
  box.addChild(new Text(lines.join("\n"), 0, 0));
  return box;
}

export const expandedToolCardIds = new Map<string, true>();

export function isToolCardExpanded(key: string | null, globallyExpanded: boolean): boolean {
  return globallyExpanded || (key !== null && expandedToolCardIds.has(key));
}

export function toggleToolCardExpanded(key: string): void {
  if (expandedToolCardIds.has(key)) expandedToolCardIds.delete(key);
  else expandedToolCardIds.set(key, true);
}

export function renderToolCardCall(
  content: Omit<ToolCardContent, "status" | "details">,
  theme: Theme,
  context?: ToolCardRenderContext,
): Component {
  if (context?.executionStarted) return new Text("", 0, 0);
  return cardBox(content, theme, context, "pending", false);
}

export function renderToolCardResult(
  content: ToolCardContent,
  theme: Theme,
  options: { expanded: boolean },
  context?: ToolCardRenderContext,
): Component {
  return cardBox(content, theme, context, "success", options.expanded);
}
