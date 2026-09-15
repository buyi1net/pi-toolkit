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

// ── 工单 27/62：子代理状态行的段位化渲染 ──────────────────────────
//
// 布局优先级靠 TUI 段位压缩循环实现，本文件不另造宽度算法：右侧运行
// 状态与左侧身份是 required 段（只压缩不隐藏，宽度吃紧时由截断兑底）。
// 工单 62 起模型、思考等级和角色合并为一个元信息组，由 widget 级别统一
// 决定完整、紧凑或整组隐藏，不再逐段参与压缩循环（旧的角色/归属/独立
// 模型段位随之移除，避免字段按行拆散）。

/** 子代理状态行各段位的压缩优先级（数值越大越早压缩/隐藏）。 */
export const SUBAGENT_WIDGET_SEGMENT_PRIORITIES = {
  /** 右侧运行状态：优先保留（required，必要时截断兑底）。 */
  status: 0,
  /** 左侧身份（图标/耗时/名称）：其次保留（required，必要时截断兑底）。 */
  identity: 1,
  /** 中间元信息组：widget 级别整组显隐，不参与逐段压缩。 */
  model: 2,
} as const;

/** 模型引用的紧凑形态：剥供应商路径前缀（与 TUI 顶边 formatHeaderModel 同规则）。 */
function compactModelRef(ref: string): string {
  const separator = ref.lastIndexOf("/");
  return separator >= 0 ? ref.slice(separator + 1) : ref;
}

export type SubagentMetadataLevel = "full" | "compact" | "hidden";

/**
 * 子代理行的元信息组（工单 62）：模型、思考等级和角色作为一个整体进入
 * 布局，由 widget 级别统一决定显示级别，段位压缩循环不再拆动它们。形态
 * 统一为剥掉供应商前缀的 `model:max(role)`：`:` 连接模型与思考等级，角色
 * 用档案名的小写形式放在尾部英文括号内；缺字段时省略对应部分（无等级
 * 省 `:level`，无角色省括号），不再出现带空格的 ` · ` 和 ` (role)`。
 * model 可携带 ":level" 自带后缀（显示时剥掉，等级由 thinking 给出——
 * 覆盖链解析后的实际生效值）。level 参数保留规格的完整→紧凑梯位语义：
 * 第一版两档同文，后续差异形态在此分叉。三元组全空时返回 null（无段可
 * 渲染）。降级重试换候选后调用方传入新的 running.model/thinking，状态
 * 行即跟随实际模型。
 */
export function buildSubagentMetadataSegment(
  model: string | null | undefined,
  thinking: string | null | undefined,
  role: string | null | undefined,
  _level: Exclude<SubagentMetadataLevel, "hidden">,
): StatusSegment | null {
  const modelRef = typeof model === "string" && model.trim() ? baseModelRef(model.trim()) : "";
  const modelText = compactModelRef(modelRef);
  const thinkingText = typeof thinking === "string" && thinking.trim() ? thinking.trim() : "";
  const roleText = typeof role === "string" && role.trim() ? role.trim().toLowerCase() : "";
  if (!modelText && !thinkingText && !roleText) return null;

  const parts = [modelText, thinkingText].filter(Boolean);
  return {
    id: "metadata",
    text: `${parts.join(":")}${roleText ? `(${roleText})` : ""}`,
    priority: SUBAGENT_WIDGET_SEGMENT_PRIORITIES.model,
    required: true,
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
  colorize: BorderColorizer = plainBorder,
): string {
  if (width <= 0) return "";
  if (width === 1) return colorize("│");
  const layout = layoutTwoColumnSegments(left, right, Math.max(0, width - 2));
  return borderLine(layout.left, layout.right, width, colorize);
}

// ── 工单 43/63：后代行的树形前缀（固定 chrome）──────────────────────
//
// 前缀不进段位压缩循环，单独计宽（段位预算 = 宽度 − 2 边框 − 前缀），
// 否则布局对 required 段的截断会把前缀一起吃掉。工单 63 起采用固定 3 列
// 槽位节奏：顶层「图标+两空格」、后代「连接符+一空格」占同一槽位（外列
// 边距由调用方统一加），时间列对齐；缩进封顶 2 层，第三层及以后统一用
// 简化连接符 ↳，时间列不随深度无限右移；连接符与续行用 muted，不抢
// 状态色。窄宽降级梯：缩进封顶逐级收（2 层 → 1 层）→ 连接符降到单字符
// → 无前缀；任何档位以不越界优先，borderLine 截断只作最后防线。

export type SubagentTreeTier = "full" | "cap1" | "single" | "none";

export function subagentTreeTier(width: number): SubagentTreeTier {
  const contentWidth = width - 2;
  if (contentWidth >= 48) return "full";
  if (contentWidth >= 32) return "cap1";
  if (contentWidth >= 12) return "single";
  return "none";
}

/**
 * 后代行树形前缀（工单 63）：固定 3 列槽位节奏逐层 +3 列，缩进封顶 2 层；
 * 第三层及以后连接符统一简化为 ↳（3 列节奏同 ↳+两空格），与二层孙代理
 * 时间列同列，不再随深度右移。lastFlags 为各层祖先是否末子（续行 │/空白），
 * isLast 为自身连接符（└─ 末子 / ├─ 非末子）。muted 用于连接符与续行符号
 * （规格：树形符号用 muted，不抢状态色），缺省不着色。
 */
export function subagentTreePrefix(
  depth: number,
  lastFlags: readonly boolean[],
  isLast: boolean,
  tier: SubagentTreeTier,
  muted: BorderColorizer = plainBorder,
): string {
  if (depth <= 0 || tier === "none") return "";
  // 转正/被提升的行（父行缺失后成为渲染根）lastFlags 可能短于 depth − 1：
  // 单元数以 lastFlags 为上限，取不到祖先标记的层不渲染悬空续行 │。
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
  // 工单 44：info 会携带全角文案（如中文计数），长度必须按可见列算；
  // 按代码单元 slice/padEnd 会让宽字符把行撑出边框（borderLine 同理用
  // truncateToWidth/visibleWidth 兑底）。
  // 窄宽截断用 sliceByColumn(strict) 而非 truncateToWidth：后者的默认省略号
  // 会把 "..." 连同 \x1b[0m 注进边框行（英文帧 "2 run" 变 "2 ..." 且 ╮ 断色），
  // 旧实现是干净切齐再补 ─，这里保持该行为。
  const fill = "─".repeat(Math.max(0, inner - visibleWidth(titlePart) - visibleWidth(infoPart)));
  const content = sliceByColumn(`${titlePart}${fill}${infoPart}`, 0, inner, true);
  const padding = "─".repeat(Math.max(0, inner - visibleWidth(content)));
  return `${colorize("╭")}${content}${padding}${colorize("╮")}`;
}

export function borderBottom(width: number, colorize: BorderColorizer = plainBorder): string {
  if (width <= 0) return "";
  if (width === 1) return colorize("╰");
  return `${colorize("╰")}${"─".repeat(Math.max(0, width - 2))}${colorize("╯")}`;
}
