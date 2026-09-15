import { sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SubagentStatusKind } from "./status.ts";
import { baseModelRef } from "./model-health.ts";
import {
  layoutTwoColumnSegments,
  type StatusSegment,
} from "../tui/status/segment-layout.ts";
import { formatElapsed as formatElapsedMs } from "../tui/status/status-segments.ts";

const ACCENT = "\x1b[38;2;77;163;255m";
const RST = "\x1b[0m";
const ICON_GREEN = "\x1b[38;2;126;186;103m";
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
    // 工单 45：stale 档是「信息陈旧、死活未知」——不作警示色，文案负责区分。
    case "stale":
    case "stale-tool":
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

// ── 工单 27：子代理状态行的段位化渲染 ──────────────────────────────
//
// 布局优先级（规格《模型编排》§7）靠 TUI 段位压缩循环实现，本文件不另造
// 宽度算法：右侧运行状态与左侧身份是 required 段（只压缩不隐藏，宽度
// 吃紧时由截断兑底），中间模型名/思考等级是可压缩可隐藏段。优先级数值
// 越大越早压缩/隐藏：思考等级先隐藏，模型名先退短名（剥供应商路径
// 前缀）再隐藏。中间段位紧随身份段之后，位于名称与右侧运行状态之间。

/** 子代理状态行各段位的压缩优先级（数值越大越早压缩/隐藏）。 */
export const SUBAGENT_WIDGET_SEGMENT_PRIORITIES = {
  /** 右侧运行状态：优先保留（required，必要时截断兑底）。 */
  status: 0,
  /** 左侧身份（图标/耗时/名称）：其次保留（required，必要时截断兑底）。 */
  identity: 1,
  /** 中间模型名：先退紧凑短名，再隐藏。 */
  model: 2,
  /** 中间归属段（工单 43 直接父代理名）：隐藏早于模型名、晚于思考等级。 */
  via: 3,
  /** 中间思考等级：最先隐藏。 */
  thinking: 4,
} as const;

/** 模型引用的紧凑形态：剥供应商路径前缀（与 TUI 顶边 formatHeaderModel 同规则）。 */
function compactModelRef(ref: string): string {
  const separator = ref.lastIndexOf("/");
  return separator >= 0 ? ref.slice(separator + 1) : ref;
}

/**
 * 中间模型信息段位（工单 27）：显示实际调用模型与实际思考等级，两段不带
 * 图标标记，靠段位分隔符「 · 」相连（模型 · 等级）。模型名一律剥供应商前缀
 * 只显短名（与 TUI 顶边 formatHeaderModel 同规则），不再区分完整/紧凑双形态。
 * model 可携带 ":level" 自带后缀（显示时剥掉，等级由 thinking 给出——覆盖链
 * 解析后的实际生效值）；两者都缺省时返回空数组（不渲染中间段）。降级重试
 * 换候选后调用方传入新的 running.model/thinking，状态行即跟随实际模型。
 */
export function buildSubagentModelSegments(
  model: string | null | undefined,
  thinking: string | null | undefined,
): StatusSegment[] {
  const ref = typeof model === "string" ? model.trim() : "";
  if (!ref) return [];
  const segments: StatusSegment[] = [{
    id: "model",
    text: compactModelRef(baseModelRef(ref)),
    priority: SUBAGENT_WIDGET_SEGMENT_PRIORITIES.model,
  }];
  const level = typeof thinking === "string" ? thinking.trim() : "";
  if (level) {
    segments.push({
      id: "thinking",
      text: level,
      priority: SUBAGENT_WIDGET_SEGMENT_PRIORITIES.thinking,
    });
  }
  return segments;
}

/**
 * 归属段（工单 43）：后代行的直接父代理名。完整形态 `via <name>`，压缩
 * 形态 `↳<name>`；第一层行不携带此段。隐藏顺序位于思考等级与模型名
 * 之间（thinking > via > model）。
 */
export function buildSubagentViaSegment(via: string): StatusSegment {
  return {
    id: "via",
    text: `${ICON_DIM}via${RST} ${via}`,
    compactText: `${ICON_DIM}↳${RST}${via}`,
    priority: SUBAGENT_WIDGET_SEGMENT_PRIORITIES.via,
  };
}

/**
 * 段位化的子代理状态行：左右两栏经 TUI 段位压缩循环（显式预算 =
 * 终端宽度 - 2 列边框）后交给 borderLine 拼边框；压缩循环保证两侧不
 * 越界，borderLine 自带的截断只作防御性兑底。
 */
export function borderSegmentLine(
  left: readonly StatusSegment[],
  right: readonly StatusSegment[],
  width: number,
): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}│${RST}`;
  const layout = layoutTwoColumnSegments(left, right, Math.max(0, width - 2));
  return borderLine(layout.left, layout.right, width);
}

// ── 工单 43：后代行的树形前缀（固定 chrome）──────────────────────────
//
// 前缀不进段位压缩循环，单独计宽（段位预算 = 宽度 − 2 边框 − 前缀），
// 否则布局对 required 段的截断会把前缀一起吃掉。窄宽降级梯：缩进封顶
// 逐级收（2 层 → 1 层）→ 连接符降到单字符 → 无前缀；任何档位以不越界
// 优先，borderLine 截断只作最后防线。阈值按「还能放下最小行内容」估的
// 经验值，不是规格定数。

export type SubagentTreeTier = "full" | "cap1" | "single" | "none";

export function subagentTreeTier(width: number): SubagentTreeTier {
  const contentWidth = width - 2;
  if (contentWidth >= 48) return "full";
  if (contentWidth >= 32) return "cap1";
  if (contentWidth >= 12) return "single";
  return "none";
}

/**
 * 后代行树形前缀：逐层 +3 列，缩进封顶 2 层（更深层不再加宽，靠归属段
 * 区分）。lastFlags 为各层祖先是否末子（续行 │/空白），isLast 为自身
 * 连接符（└─ 末子 / ├─ 非末子）。
 */
export function subagentTreePrefix(
  depth: number,
  lastFlags: readonly boolean[],
  isLast: boolean,
  tier: SubagentTreeTier,
): string {
  if (depth <= 0 || tier === "none") return "";
  // 转正/被提升的行（父行缺失后成为渲染根）lastFlags 可能短于 depth − 1：
  // 单元数以 lastFlags 为上限，取不到祖先标记的层不渲染悬空续行 │。
  const units = tier === "cap1" ? 1 : Math.min(depth, 2, lastFlags.length + 1);
  const parts: string[] = [];
  for (let unit = 1; unit <= units; unit++) {
    const connector = unit === units;
    if (tier === "single") {
      if (connector) parts.push(isLast ? "└ " : "├ ");
      else parts.push(lastFlags[unit - 1] ? "  " : "│ ");
    } else {
      if (connector) parts.push(isLast ? "└─ " : "├─ ");
      else parts.push(lastFlags[unit - 1] ? "   " : "│  ");
    }
  }
  return parts.join("");
}

export function borderTop(title: string, info: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╭${RST}`;
  const inner = Math.max(0, width - 2);
  const titlePart = `─ ${title} `;
  const infoPart = ` ${info} ─`;
  // 工单 44：info 会携带全角文案（如中文计数），长度必须按可见列算；
  // 按代码单元 slice/padEnd 会让宽字符把行撑出边框（borderLine 同理用
  // truncateToWidth/visibleWidth 兑底）。
  // 窄宽截断用 sliceByColumn(strict) 而非 truncateToWidth：后者的默认省略号
  // 会把 "..." 连同 \x1b[0m 注进边框行（英文帧 "2 run" 变 "2 ..." 且 ╮ 断色），
  // 旧实现是干净切齐再补 ─，这里保持该行为。
  const fill = "─".repeat(Math.max(0, inner - visibleWidth(titlePart) - visibleWidth(infoPart)));
  const content = sliceByColumn(`${titlePart}${fill}${infoPart}`, 0, inner, true);
  const padding = "─".repeat(Math.max(0, inner - visibleWidth(content)));
  return `${ACCENT}╭${content}${padding}╮${RST}`;
}

export function borderBottom(width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╰${RST}`;
  return `${ACCENT}╰${"─".repeat(Math.max(0, width - 2))}╯${RST}`;
}
