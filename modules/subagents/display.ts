import { sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SubagentStatusKind } from "./status.ts";
import { baseModelRef } from "./model-health.ts";
import {
  layoutTwoColumnSegments,
  type StatusSegment,
} from "../tui/status/segment-layout.ts";
import { formatElapsed as formatElapsedMs } from "../tui/status/status-segments.ts";

const RST = "\x1b[0m";
const ICON_YELLOW = "\x1b[38;2;214;181;94m";
const ICON_RED = "\x1b[38;2;224;108;117m";
const ICON_DIM = "\x1b[38;2;128;128;128m";

export function formatElapsed(seconds: number): string {
  return formatElapsedMs(seconds * 1000);
}

export function formatTokens(value: number): string {
  return value < 1000 ? String(value) : value < 10000 ? `${(value / 1000).toFixed(1)}k` : `${Math.round(value / 1000)}k`;
}

export function contextWindowFor(model: string | null | undefined): number | undefined {
  if (!model) return undefined;
  const value = model.toLowerCase();
  if (value.includes("claude")) return 200_000;
  if (value.includes("gpt-4.1") || value.includes("gpt-4o")) return 128_000;
  if (value.includes("gemini")) return 1_000_000;
  return undefined;
}

export function formatContextUsage(tokens: number, contextWindow: number | undefined): string {
  if (!contextWindow) return `${formatTokens(tokens)} ctx`;
  const percent = (tokens / contextWindow) * 100;
  const max = contextWindow >= 1_000_000
    ? `${(contextWindow / 1_000_000).toFixed(1)}M`
    : `${Math.round(contextWindow / 1000)}k`;
  return `${percent.toFixed(1)}%/${max}`;
}

export function formatUsageSegments(stats: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
}): string[] {
  const segments: string[] = [];
  if (stats.inputTokens) segments.push(`↑${formatTokens(stats.inputTokens)}`);
  if (stats.outputTokens) segments.push(`↓${formatTokens(stats.outputTokens)}`);
  if (stats.cacheReadTokens) segments.push(`R${formatTokens(stats.cacheReadTokens)}`);
  if (stats.cacheWriteTokens) segments.push(`W${formatTokens(stats.cacheWriteTokens)}`);
  if (stats.cost) segments.push(`$${stats.cost.toFixed(3)}`);
  return segments;
}

export function widgetIcon(kind: SubagentStatusKind): string {
  switch (kind) {
    case "active":
    case "running":

    case "stale":
    case "stale-tool":
      return `${ICON_YELLOW}⟳${RST}`;
    case "stalled":
      return `${ICON_RED}⟳${RST}`;
    default:
      return `${ICON_DIM}○${RST}`;
  }
}

export type BorderColorizer = (text: string) => string;

const plainBorder: BorderColorizer = (text) => text;

export function borderLine(left: string, right: string, width: number, colorize: BorderColorizer = plainBorder): string {
  if (width <= 0) return "";
  if (width === 1) return colorize("│");
  const contentWidth = Math.max(0, width - 2);
  const rightWidth = visibleWidth(right);
  if (rightWidth >= contentWidth) {
    const truncated = truncateToWidth(right, contentWidth);
    return `${colorize("│")}${truncated}${" ".repeat(Math.max(0, contentWidth - visibleWidth(truncated)))}${colorize("│")}`;
  }
  const truncatedLeft = truncateToWidth(left, contentWidth - rightWidth);
  const padding = Math.max(0, contentWidth - visibleWidth(truncatedLeft) - rightWidth);
  return `${colorize("│")}${truncatedLeft}${" ".repeat(padding)}${right}${colorize("│")}`;
}

export const SUBAGENT_WIDGET_SEGMENT_PRIORITIES = {

  status: 0,

  identity: 1,

  model: 2,
} as const;

function compactModelRef(ref: string): string {
  const separator = ref.lastIndexOf("/");
  return separator >= 0 ? ref.slice(separator + 1) : ref;
}

export type SubagentMetadataLevel = "full" | "compact" | "hidden";

export function buildSubagentMetadataSegment(
  model: string | null | undefined,
  thinking: string | null | undefined,
  _level: Exclude<SubagentMetadataLevel, "hidden">,
): StatusSegment | null {
  const modelRef = typeof model === "string" && model.trim() ? baseModelRef(model.trim()) : "";
  const modelText = compactModelRef(modelRef);
  const thinkingText = typeof thinking === "string" && thinking.trim() ? thinking.trim() : "";
  if (!modelText && !thinkingText) return null;

  const parts = [modelText, thinkingText].filter(Boolean);
  return {
    id: "metadata",
    text: parts.join(":"),
    priority: SUBAGENT_WIDGET_SEGMENT_PRIORITIES.model,
    required: true,
  };
}

export function borderSegmentLine(
  left: readonly StatusSegment[],
  right: readonly StatusSegment[],
  width: number,
  colorize: BorderColorizer = plainBorder,
): string {
  if (width <= 0) return "";
  if (width === 1) return colorize("│");
  const layout = layoutTwoColumnSegments(left, right, Math.max(0, width - 2));
  return borderLine(layout.left, layout.right, width, colorize);
}

export type SubagentTreeTier = "full" | "cap1" | "single" | "none";

export function subagentTreeTier(width: number): SubagentTreeTier {
  const contentWidth = width - 2;
  if (contentWidth >= 48) return "full";
  if (contentWidth >= 32) return "cap1";
  if (contentWidth >= 12) return "single";
  return "none";
}

export function subagentTreePrefix(
  depth: number,
  lastFlags: readonly boolean[],
  isLast: boolean,
  tier: SubagentTreeTier,
  muted: BorderColorizer = plainBorder,
): string {
  if (depth <= 0 || tier === "none") return "";

  const units = tier === "cap1" ? 1 : Math.min(depth, 2, lastFlags.length + 1);
  const simplified = depth > 2;
  const parts: string[] = [];
  for (let unit = 1; unit <= units; unit++) {
    const connector = unit === units;
    if (tier === "single") {
      if (connector) parts.push(simplified ? `${muted("↳")} ` : isLast ? `${muted("└")} ` : `${muted("├")} `);
      else parts.push(lastFlags[unit - 1] ? "  " : `${muted("│")} `);
    } else {
      if (connector) parts.push(simplified ? `${muted("↳")}  ` : isLast ? `${muted("└─")} ` : `${muted("├─")} `);
      else parts.push(lastFlags[unit - 1] ? "   " : `${muted("│")}  `);
    }
  }
  return parts.join("");
}

export function borderTop(title: string, info: string, width: number, colorize: BorderColorizer = plainBorder): string {
  if (width <= 0) return "";
  if (width === 1) return colorize("╭");
  const inner = Math.max(0, width - 2);
  const titlePart = `─ ${title} `;
  const infoPart = ` ${info} ─`;

  const fill = "─".repeat(Math.max(0, inner - visibleWidth(titlePart) - visibleWidth(infoPart)));
  const content = sliceByColumn(`${titlePart}${fill}${infoPart}`, 0, inner, true);
  const padding = "─".repeat(Math.max(0, inner - visibleWidth(content)));

  return `╭${content}${padding}╮`.replace(/╭─*|─*╮|─+/g, (run) => colorize(run));
}

export function borderBottom(width: number, colorize: BorderColorizer = plainBorder): string {
  if (width <= 0) return "";
  if (width === 1) return colorize("╰");

  return colorize(`╰${"─".repeat(Math.max(0, width - 2))}╯`);
}
