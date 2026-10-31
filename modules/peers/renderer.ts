import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, MouseRegion, Text, truncateToWidth, stripTerminalSequences, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { deriveSessionShortId } from "../../shared/short-id.ts";
import { expandedToolCardIds as expandedPeersMessageIds, formatToolCardLine, cardBackground } from "../../kit/tool-card.ts";
import { PEERS_BODY_BEGIN_MARKER, PEERS_MESSAGE_CUSTOM_TYPE, sanitizePeersEnvelopeField, type PeersMessageDetails } from "./messaging.ts";
import { peersTableTranslator, type PeersTranslate } from "./messages/index.ts";

export const PEERS_RENDERER_MESSAGE_KEYS = [
  "module.peers.renderer.title",
  "module.peers.renderer.instance",
  "module.peers.renderer.sentAt",
  "module.peers.renderer.cwd",
  "module.peers.renderer.bodyUnavailable",
] as const;

const BODY_BEGIN_MARKER_BYTES = Buffer.from(PEERS_BODY_BEGIN_MARKER, "utf8");

function cardField(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  return sanitizePeersEnvelopeField(value);
}

const MAX_DATE_MS = 8.64e15;

function validSentAt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_DATE_MS
    ? value
    : null;
}

interface PeersCardData {
  readonly name: string | null;
  readonly sessionId: string | null;
  readonly instanceId: string | null;
  readonly sentAt: number | null;
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
    cwd: cardField(sender?.cwd),
    bodyBytes:
      typeof record.bodyBytes === "number" && Number.isInteger(record.bodyBytes) && record.bodyBytes >= 0
        ? record.bodyBytes
        : null,
  };
}

export function extractPeersCardBody(content: string, bodyBytes: number): string | null {
  const buffer = Buffer.from(content, "utf8");
  const beginIndex = buffer.indexOf(BODY_BEGIN_MARKER_BYTES);
  if (beginIndex < 0) return null;
  const afterMarker = beginIndex + BODY_BEGIN_MARKER_BYTES.length;

  if (buffer[afterMarker] !== 0x0a) return null;
  const start = afterMarker + 1;
  const end = start + bodyBytes;
  if (end > buffer.length) return null;
  try {

    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(start, end));
  } catch {
    return null;
  }
}

function cardSource(data: PeersCardData | null): string | null {
  if (data === null) return null;
  if (data.name !== null) return data.name;
  if (data.sessionId === null) return null;
  const shortId = deriveSessionShortId(data.sessionId);
  return shortId !== null ? `#${shortId}` : data.sessionId;
}

function peersMessageKey(details: unknown): string | null {
  if (typeof details !== "object" || details === null) return null;
  const messageId = (details as Record<string, unknown>).messageId;
  return typeof messageId === "string" && messageId.trim() !== "" ? messageId : null;
}

export function registerPeersRenderers(
  pi: ExtensionAPI,
  t: PeersTranslate = peersTableTranslator("en"),
): void {
  if (typeof pi.registerMessageRenderer !== "function") return;
  pi.registerMessageRenderer<PeersMessageDetails>(PEERS_MESSAGE_CUSTOM_TYPE, (message, options, theme) => {
    const key = peersMessageKey(message.details);
    const card = {
      invalidate() {},
      render(width: number): string[] {
        const data = readCardData(message.details);
        const content = typeof message.content === "string" ? message.content : null;
        const body =
          data !== null && data.bodyBytes !== null && content !== null
            ? extractPeersCardBody(content, data.bodyBytes)
            : null;

        const source = cardSource(data);
        const contentLines = [formatToolCardLine({
          title: t("module.peers.renderer.title"),
          object: source ?? undefined,
        }, theme)];
        const expanded = options.expanded || (key !== null && expandedPeersMessageIds.has(key));

        if (expanded) {
          const lineWidth = Math.max(0, width - 6);
          if (data !== null && data.instanceId !== null) {
            contentLines.push(theme.fg("dim", truncateToWidth(t("module.peers.renderer.instance", { id: data.instanceId }), lineWidth)));
          }
          if (data !== null && data.sentAt !== null) {
            const time = new Date(data.sentAt).toLocaleString();
            contentLines.push(theme.fg("dim", truncateToWidth(t("module.peers.renderer.sentAt", { time }), lineWidth)));
          }
          if (data !== null && data.cwd !== null) {
            contentLines.push(theme.fg("dim", truncateToWidth(t("module.peers.renderer.cwd", { cwd: data.cwd }), lineWidth)));
          }

          if (body === null) {
            contentLines.push("", theme.fg("warning", t("module.peers.renderer.bodyUnavailable")));
          } else {
            contentLines.push(
              "",
              ...body.split("\n").flatMap((line) => wrapTextWithAnsi(stripTerminalSequences(line), Math.max(1, width - 2))),
            );
          }
        }

        const box = new Box(1, 1, cardBackground(theme, "toolSuccessBg"));
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
    return new MouseRegion(card, (event) => {
      if (key === null || event.type !== "click" || event.button !== "left") return undefined;
      if (expandedPeersMessageIds.has(key)) expandedPeersMessageIds.delete(key);
      else expandedPeersMessageIds.set(key, true);
      return { handled: true };
    });
  });
}
