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
  /** 展开区行：只放面向用户的说明，不得直接放工具返回给模型的结果原文。 */
  readonly details?: readonly string[];
}

export interface ToolCardFailureLabels {
  /** 没有对应人话时使用的通用文案。 */
  readonly fallback: string;
  /** 机器码 → 面向用户的文案；码只当查找键，查不到时用 fallback。 */
  readonly byCode?: Readonly<Record<string, string>>;
}

type BackgroundToken = Parameters<Theme["bg"]>[0];

/**
 * 卡片背景函数：内层文本（如 truncateToWidth 的省略号）带完整重置码 \x1b[0m 时，
 * 背景会在该处中断，行尾露出终端底色。每个重置码后重新铺回背景。
 */
export function cardBackground(theme: Theme, token: BackgroundToken): (text: string) => string {
  if (typeof (theme as Theme & { bg?: unknown }).bg !== "function") return (text) => text;
  return (text) => {
    const wrapped = theme.bg(token, "\u0000");
    const at = wrapped.indexOf("\u0000");
    if (at <= 0) return theme.bg(token, text);
    const start = wrapped.slice(0, at);
    return theme.bg(token, text.replace(/\x1b\[(?:0|49)?m/g, (reset) => reset + start));
  };
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

type ToolCardLineTheme = Pick<Theme, "fg" | "bold">;

export function formatToolCardLine(
  content: ToolCardContent,
  theme?: ToolCardLineTheme,
  isError = false,
): string {
  const title = normalizePart(content.title);
  const object = normalizePart(content.object);
  const status = normalizePart(content.status);
  const parts = theme
    ? [
        title === undefined ? undefined : theme.fg("toolTitle", theme.bold(title)),
        object === undefined ? undefined : theme.fg("accent", object),
        status === undefined ? undefined : theme.fg(isError ? "error" : "toolOutput", status),
      ]
    : [title, object, status];
  return parts.filter((part): part is string => part !== undefined).join(" · ");
}

export function compactRenderText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

export function compactSegment(value: string | undefined, width: number): string | undefined {
  const text = compactRenderText(value);
  return text ? truncateToWidth(text, width, "…") : undefined;
}

/** 失败结果折叠态的单行原因：code 只用于查人话，查不到时回落到调用方提供的通用文案。 */
export function toolCardFailureReason(details: unknown, labels: ToolCardFailureLabels, maxWidth = 60): string {
  const code = (details as { code?: unknown } | undefined)?.code;
  const label = typeof code === "string" && code !== "" ? labels.byCode?.[code] : undefined;
  return truncateToWidth(compactRenderText(label ?? labels.fallback), maxWidth, "…");
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

function cardBox(
  content: ToolCardContent,
  theme: Theme,
  context: ToolCardRenderContext | undefined,
  fallbackStatus: ToolCardStatus,
  expanded: boolean,
): Component {
  const lines = [formatToolCardLine(content, theme, context?.isError === true || fallbackStatus === "error")];
  if (expanded && content.details && content.details.length > 0) lines.push(...content.details);
  const bg = cardBackground(theme, statusToken(context, fallbackStatus));
  const box = new Box(context?.outputPad ?? 1, 1, bg);
  box.addChild(new Text(lines.join("\n"), 0, 0));
  return box;
}

export const EXPANDED_TOOL_CARD_LIMIT = 256;

const expandedToolCardIds = new Map<string, true>();

export function isToolCardExpanded(key: string | null, globallyExpanded: boolean): boolean {
  return globallyExpanded || (key !== null && expandedToolCardIds.has(key));
}

export function setToolCardExpanded(key: string, expanded: boolean): void {
  expandedToolCardIds.delete(key);
  if (!expanded) return;
  expandedToolCardIds.set(key, true);
  while (expandedToolCardIds.size > EXPANDED_TOOL_CARD_LIMIT) {
    const oldest = expandedToolCardIds.keys().next();
    if (oldest.done) break;
    expandedToolCardIds.delete(oldest.value);
  }
}

export function toggleToolCardExpanded(key: string): void {
  setToolCardExpanded(key, !expandedToolCardIds.has(key));
}

export function renderToolCardCall(
  content: Omit<ToolCardContent, "status" | "details">,
  theme: Theme,
  context?: ToolCardRenderContext,
): Component {
  // 执行已开始，或结果已落定（刷新/回放历史时 executionStarted 为 false，isPartial 为 false）：
  // 结果卡片已经承载信息，调用行不再占一行。
  if (context?.executionStarted || context?.isPartial === false) return new Text("", 0, 0);
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
