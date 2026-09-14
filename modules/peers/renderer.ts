// peers 外部消息卡片渲染器（工单 50；规格《会话通讯消息关联与链路优化规格说明》决策 6）：
// 把 peers_message 消息从「带英文安全提示的日志块」渲染成卡片——外部来源标记、发送方名字
// （注册表权威值）或会话短码、实例 id、发送时刻、回复关系与正文。安全提示段落属于模型
// 上下文（封套），卡片不显示；来源与回复关系只读结构化详情，不从正文文本解析。
//
// 硬约束（工单阻断项）：渲染器任何情况下都不返回 undefined——详情缺失、字段不全或正文
// 提取失败时渲染最小安全卡片并标注正文不可用，绝不回退完整消息文本（那会把安全提示与
// 未清洗的封套泄漏到界面）。
//
// 正文提取按位置、不靠文本搜索边界（规格决策 6）：起点是第一个 begin 标记及其紧随换行
// 之后的第一个字节，长度取详情记录的正文字节数（UTF-8），切片后严格解码；因此正文自带
// 分隔标记、首尾是多字节字符时都正确。短码由渲染器从完整 id 即时派生（shared/short-id.ts
// 是唯一实现），不信任详情里可能过时的短码字段。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Box, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { deriveSessionShortId } from "../../shared/short-id.ts";
import { PEERS_BODY_BEGIN_MARKER, PEERS_MESSAGE_CUSTOM_TYPE, sanitizePeersEnvelopeField, type PeersMessageDetails } from "./messaging.ts";
import { peersTableTranslator, type PeersTranslate } from "./messages/index.ts";

/** 折叠态正文预览行数（对齐 subagents 终态行的 5 行口径） */
const BODY_PREVIEW_LINES = 5;

/** 渲染器文案键清单：测试据此校验三语齐全，并能发现「表里加键但渲染器没用」的漂移 */
export const PEERS_RENDERER_MESSAGE_KEYS = [
  "module.peers.renderer.title",
  "module.peers.renderer.instance",
  "module.peers.renderer.sentAt",
  "module.peers.renderer.replyClaim",
  "module.peers.renderer.replyClaimFull",
  "module.peers.renderer.cwd",
  "module.peers.renderer.bodyUnavailable",
  "module.peers.renderer.moreLines",
] as const;

/** begin 标记的字节形式：正文起点按字节（UTF-8）定位，不按字符偏移 */
const BODY_BEGIN_MARKER_BYTES = Buffer.from(PEERS_BODY_BEGIN_MARKER, "utf8");

/**
 * 展示用动态字段取值：空值 / 非字符串先挡掉，再过与封套构建同一口径的
 * sanitizePeersEnvelopeField 兜底清洗——清洗只发生在封套构建期，改动前落盘的旧消息 details
 * 可能带换行、控制字符或分隔标记字面量，渲染器不得原样显示（破坏卡片结构 / 露出可劫持标记）。
 * 封套侧已清洗的值再洗一次无副作用（幂等）。
 */
function cardField(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  return sanitizePeersEnvelopeField(value);
}

/** Date 可表示的时间范围端点（±8.64e15 ms）：超出后 new Date(...).toISOString() 抛 RangeError。
 * sentAt 是详情透传的裸数值，渲染期是最后一道防线：超范围按「时刻不可用」处理（不渲染
 * 时刻行、不留占位噪音），保证任何数值输入下 render 不抛。 */
const MAX_DATE_MS = 8.64e15;

function validSentAt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_DATE_MS
    ? value
    : null;
}

/** 卡片可用的结构化字段；详情缺失或字段不全时对应项为 null（渲染最小安全卡片） */
interface PeersCardData {
  readonly name: string | null;
  readonly sessionId: string | null;
  readonly instanceId: string | null;
  readonly sentAt: number | null;
  readonly replyTo: string | null;
  readonly cwd: string | null;
  readonly bodyBytes: number | null;
}

function readCardData(details: unknown): PeersCardData | null {
  if (typeof details !== "object" || details === null) return null;
  const record = details as Record<string, unknown>;
  const sender =
    typeof record.sender === "object" && record.sender !== null
      ? (record.sender as Record<string, unknown>)
      : null;
  return {
    name: cardField(sender?.name),
    sessionId: cardField(sender?.sessionId),
    instanceId: cardField(sender?.instanceId),
    sentAt: validSentAt(record.sentAt),
    replyTo: cardField(record.replyTo),
    cwd: cardField(sender?.cwd),
    bodyBytes:
      typeof record.bodyBytes === "number" && Number.isInteger(record.bodyBytes) && record.bodyBytes >= 0
        ? record.bodyBytes
        : null,
  };
}

/**
 * 按位置提取正文：返回 null 走异常路径（起点找不到 / 长度不足 / 严格解码失败），
 * 调用方只渲染最小安全卡片，绝不回退完整消息文本。
 */
export function extractPeersCardBody(content: string, bodyBytes: number): string | null {
  const buffer = Buffer.from(content, "utf8");
  const beginIndex = buffer.indexOf(BODY_BEGIN_MARKER_BYTES);
  if (beginIndex < 0) return null;
  const afterMarker = beginIndex + BODY_BEGIN_MARKER_BYTES.length;
  // 标记行与正文之间必须恰好是一个换行字节；不满足说明封套结构不可信，按起点异常处理
  if (buffer[afterMarker] !== 0x0a) return null;
  const start = afterMarker + 1;
  const end = start + bodyBytes;
  if (end > buffer.length) return null;
  try {
    // fatal：切片落多字节字符中间时抛错；ignoreBOM：不吞正文开头的 BOM，逐字节还原
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(start, end));
  } catch {
    return null;
  }
}

/** 来源展示：注册表权威名字优先，缺失时回退会话短码（再缺则完整会话 id），不造占位噪音 */
function cardSource(data: PeersCardData | null): string | null {
  if (data === null) return null;
  if (data.name !== null) return data.name;
  if (data.sessionId === null) return null;
  const shortId = deriveSessionShortId(data.sessionId);
  return shortId !== null ? `#${shortId}` : data.sessionId;
}

/** 回复关系行：短码由完整 id 即时派生，措辞固定「对方声称」（未经验证的声明） */
function cardReplyLine(data: PeersCardData, t: PeersTranslate): string | null {
  if (data.replyTo === null) return null;
  const shortId = deriveSessionShortId(data.replyTo);
  return shortId !== null
    ? t("module.peers.renderer.replyClaim", { shortId })
    : t("module.peers.renderer.replyClaimFull", { id: data.replyTo });
}

export function registerPeersRenderers(
  pi: ExtensionAPI,
  t: PeersTranslate = peersTableTranslator("en"),
): void {
  // 装配接缝容错：全链路装配测试面（最小假 pi）未必提供 UI 注册位；渲染器只服务 TUI，
  // 缺位时跳过注册，不影响通讯与模型上下文
  if (typeof pi.registerMessageRenderer !== "function") return;
  pi.registerMessageRenderer<PeersMessageDetails>(PEERS_MESSAGE_CUSTOM_TYPE, (message, options, theme) => ({
    invalidate() {},
    render(width: number): string[] {
      const data = readCardData(message.details);
      const content = typeof message.content === "string" ? message.content : null;
      const body =
        data !== null && data.bodyBytes !== null && content !== null
          ? extractPeersCardBody(content, data.bodyBytes)
          : null;

      const headerParts = [
        `${theme.fg("accent", "◆")} ${theme.fg("toolTitle", theme.bold(t("module.peers.renderer.title")))}`,
      ];
      const source = cardSource(data);
      if (source !== null) headerParts.push(theme.fg("toolTitle", source));
      if (data !== null && data.instanceId !== null) {
        headerParts.push(theme.fg("dim", t("module.peers.renderer.instance", { id: data.instanceId })));
      }
      const contentLines = [headerParts.join(theme.fg("dim", " · "))];

      const lineWidth = Math.max(0, width - 6);
      if (data !== null && data.sentAt !== null) {
        const time = new Date(data.sentAt).toISOString();
        contentLines.push(theme.fg("dim", truncateToWidth(t("module.peers.renderer.sentAt", { time }), lineWidth)));
      }
      const replyLine = data !== null ? cardReplyLine(data, t) : null;
      if (replyLine !== null) contentLines.push(theme.fg("dim", truncateToWidth(replyLine, lineWidth)));
      if (options.expanded && data !== null && data.cwd !== null) {
        contentLines.push(theme.fg("dim", truncateToWidth(t("module.peers.renderer.cwd", { cwd: data.cwd }), lineWidth)));
      }

      if (body === null) {
        // 异常路径 / 详情缺失：只给结构化字段 + 正文不可用；绝不渲染完整消息文本
        contentLines.push("", theme.fg("warning", t("module.peers.renderer.bodyUnavailable")));
      } else if (options.expanded) {
        contentLines.push("", ...body.split("\n").map((line) => truncateToWidth(line, lineWidth)));
      } else {
        const bodyLines = body.split("\n");
        contentLines.push(
          "",
          ...bodyLines.slice(0, BODY_PREVIEW_LINES).map((line) => theme.fg("dim", truncateToWidth(line, lineWidth))),
        );
        if (bodyLines.length > BODY_PREVIEW_LINES) {
          contentLines.push(
            theme.fg("muted", t("module.peers.renderer.moreLines", { count: bodyLines.length - BODY_PREVIEW_LINES })),
          );
        }
        contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
      }

      const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
      box.addChild(new Text(contentLines.join("\n"), 0, 0));
      return ["", ...box.render(width)];
    },
  }));
}
