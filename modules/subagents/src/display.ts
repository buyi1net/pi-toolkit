import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const ACCENT = "\x1b[38;2;77;163;255m";
const RST = "\x1b[0m";
const ICON_GREEN = "\x1b[38;2;126;186;103m";
const ICON_YELLOW = "\x1b[38;2;214;181;94m";
const ICON_RED = "\x1b[38;2;224;108;117m";
const ICON_DIM = "\x1b[38;2;128;128;128m";

export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
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

export function widgetIcon(kind: "active" | "running" | "stalled" | "waiting" | "starting"): string {
  switch (kind) {
    case "active":
    case "running":
      return `${ICON_YELLOW}⟳${RST}`;
    case "stalled":
      return `${ICON_RED}⟳${RST}`;
    default:
      return `${ICON_DIM}○${RST}`;
  }
}

export function borderLine(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}│${RST}`;
  const contentWidth = Math.max(0, width - 2);
  const rightWidth = visibleWidth(right);
  if (rightWidth >= contentWidth) {
    const truncated = truncateToWidth(right, contentWidth);
    return `${ACCENT}│${RST}${truncated}${" ".repeat(Math.max(0, contentWidth - visibleWidth(truncated)))}${ACCENT}│${RST}`;
  }
  const truncatedLeft = truncateToWidth(left, contentWidth - rightWidth);
  const padding = Math.max(0, contentWidth - visibleWidth(truncatedLeft) - rightWidth);
  return `${ACCENT}│${RST}${truncatedLeft}${" ".repeat(padding)}${right}${ACCENT}│${RST}`;
}

export function borderTop(title: string, info: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╭${RST}`;
  const inner = Math.max(0, width - 2);
  const titlePart = `─ ${title} `;
  const infoPart = ` ${info} ─`;
  const fill = "─".repeat(Math.max(0, inner - titlePart.length - infoPart.length));
  return `${ACCENT}╭${`${titlePart}${fill}${infoPart}`.slice(0, inner).padEnd(inner, "─")}╮${RST}`;
}

export function borderBottom(width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╰${RST}`;
  return `${ACCENT}╰${"─".repeat(Math.max(0, width - 2))}╯${RST}`;
}
