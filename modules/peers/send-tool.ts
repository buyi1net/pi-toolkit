import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { compactRenderText, renderToolCardCall, renderToolCardResult } from "../../kit/tool-card.ts";
import { Type } from "typebox";
import { describePeersReason, deliverPeersMessage, type PeersSendDeps, type PeersSendReport, type PeersTargetStatusSnapshot } from "./messaging.ts";
import type { PeersTranslate } from "./messages/index.ts";

export interface PeersSendToolDeps extends PeersSendDeps {

  readonly label: string;

  readonly t?: PeersTranslate;
}

function formatTargetStatus(status: PeersTargetStatusSnapshot): string {
  if (status.source === "disk") {
    return "offline (no live instance; activity and heartbeat age unavailable)";
  }
  return `${status.liveness} / ${status.activity} / heartbeat age ${status.heartbeatAgeMs}ms`;
}

function formatSendReport(report: PeersSendReport, target: string): string {
  const head = `peers_send → target ${JSON.stringify(target)}`;
  if (report.result === "accepted") {
    const duplicate = report.reason === "duplicate-message";

    const reference =
      report.messageId !== null
        ? ` message id ${report.messageId}${report.messageShortId !== null ? ` (@${report.messageShortId})` : ""}.`
        : "";
    return `${head}: DELIVERED (accepted${duplicate ? ", duplicate message id — receiver did not inject it again" : ""}). ${report.detail}${reference}`;
  }
  const reasonText =
    report.reason !== null ? `${report.reason} (${describePeersReason(report.reason)})` : "no reason code";

  const stageText = report.stage !== null ? `; stage: ${report.stage}` : "";

  const statusText =
    report.targetStatus !== null
      ? ` Target status at resolution: ${formatTargetStatus(report.targetStatus)}.`
      : "";
  if (report.result === "rejected") {
    const recoveryHint = report.reason === "self-delivery"
      ? " Choose another peer target from peers_list; this session cannot send a peers message to itself."
      : "";
    return `${head}: NOT DELIVERED (rejected: ${reasonText}${stageText}).${statusText} ${report.detail}${recoveryHint}`;
  }
  return `${head}: DELIVERY FAILED (error: ${reasonText}${stageText}).${statusText} ${report.detail}`;
}

function sendRenderStatus(
  result: { details?: unknown },
  t?: PeersTranslate,
): string {
  const details = result.details as (Partial<PeersSendReport> & { target?: unknown }) | undefined;
  const target = compactRenderText(details?.target) || "(target)";
  if (details?.result === "accepted") {
    return t?.("module.peers.tool.send.result.delivered", { target }) ?? "Delivered";
  }
  const reason = typeof details?.reason === "string"
    ? describePeersReason(details.reason as Parameters<typeof describePeersReason>[0])
    : compactRenderText(details?.detail) || compactRenderText(details?.result) || "delivery failed";
  return t?.("module.peers.tool.send.result.failed", { reason }) ?? `Delivery failed: ${reason}`;
}

function normalizeReplyTo(replyTo: string | undefined): string | null {
  return typeof replyTo === "string" && replyTo.trim() !== "" ? replyTo : null;
}

function sendBodyLines(body: unknown): string[] {
  if (typeof body !== "string" || body.length === 0) return [];
  return body.split("\n").map((line) => stripTerminalSequences(line));
}

export function registerPeersSendTool(pi: ExtensionAPI, deps: PeersSendToolDeps): void {
  pi.registerTool({
    name: "peers_send",
    label: deps.label,
    description:
      "Send a message to another local pi session on this machine (same agent directory). " +
      "The send completes immediately once the target endpoint accepts it; it does not wait for the receiver's LLM to process it. " +
      "Replies from the receiver arrive automatically as new messages; do not use wait_agent or repeatedly poll peers_list for them. " +
      "Target may be: a 6-char short id with # prefix (like #62nvbt, from peers_list), a session name, a full session UUID or a unique lowercase prefix (min 4 chars), or an instance id (needed when one session runs multiple instances). " +
      "This target namespace contains peer session identities; a spawn_agent task_name such as dup_demo is resolved by send_message or followup_task in the parent session instead. " +
      "Optional replyTo carries the full message id of the message this one replies to; omit it when there is no reply relation. It is declarative metadata and is NOT validated against existing messages. " +
      "Large bodies are supported: content over the large-content threshold (default 8192 UTF-8 bytes) is automatically written to a file in the peers shared area and delivered as a file reference with size and sha256; the receiver validates the path and hash before injecting. " +
      "If that integrity validation fails (missing file, size or hash mismatch), the receiver rejects the injection and records a local diagnostic — the sender receives only the generic rejection reason code and gets NO reverse notification about the cause, so verify or re-send on your own. " +
      "Each sender is rate limited per receiver window (default 10 messages/minute) and excessive ping-pong between a session pair is throttled (rate-limited). " +
      "Returns a three-state outcome with a reason code: accepted (delivered into the receiver's injection flow), rejected (offline / ambiguous address / unknown target / self-delivery / receiver policy / queue full / rate limited / content too large) or error (timeouts, protocol problems). ",
    promptSnippet:
      "Send a message to a local peer pi session by short id, name, session id or instance id; returns accepted/rejected/error with reason",
    parameters: Type.Object({
      target: Type.String({
        minLength: 1,
        description:
          "Address of the receiver: #short-id, session name, full session UUID or unique prefix (>= 4 chars), or instance id",
      }),
      body: Type.String({
        minLength: 1,
        description:
          "Message body to deliver (plain text). Bodies over the large-content threshold (default 8192 UTF-8 bytes) are " +
          "automatically stored as a file and delivered as a file reference with size and sha256; if the receiver's integrity " +
          "validation of that file fails, the message is rejected there and the sender is NOT notified about the cause " +
          "(no reverse notification) — re-send if the target reports rejection",
      }),
      replyTo: Type.Optional(
        Type.String({
          minLength: 1,
          description:
            "Full message id this message replies to (from the Message id line of an inbound envelope or the receipt of your " +
            "own peers_send). Declarative metadata: not checked for existence, not part of any delivery judgment",
        }),
      ),
    }),
    renderShell: "self",
    renderCall(args, theme, context) {
      const rawTarget = typeof args.target === "string" ? args.target : "";
      const target = rawTarget.trim() || "(target)";
      const title = deps.t?.("module.peers.tool.send.display", { target }) ?? "Message";
      return renderToolCardCall({ title, object: target }, theme, context);
    },
    renderResult(result, options, theme, context) {
      const details = result.details as (Partial<PeersSendReport> & { target?: unknown }) | undefined;
      const target = compactRenderText(details?.target) || compactRenderText(context?.args?.target) || "(target)";
      const title = deps.t?.("module.peers.tool.send.display", { target }) ?? "Message";
      const body = sendBodyLines(context?.args?.body);
      const expandedDetails = options.expanded
        ? [
            ...(details?.result ? [`result: ${details.result}`] : []),
            ...(details?.reason ? [`reason: ${details.reason}`] : []),
            ...(details?.stage ? [`stage: ${details.stage}`] : []),
            ...body,
          ]
        : [];
      return renderToolCardResult(
        { title, object: target, status: sendRenderStatus(result, deps.t), details: expandedDetails },
        theme,
        options,
        context,
      );
    },

    async execute(
      _toolCallId: string,
      params: { target: string; body: string; replyTo?: string },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: ExtensionContext | undefined,
    ): Promise<{
      content: { type: "text"; text: string }[];
      details: PeersSendReport & { readonly target: string };
      isError?: boolean;
    }> {
      const report = await deliverPeersMessage(deps, params.target, params.body, normalizeReplyTo(params.replyTo));
      return {
        content: [{ type: "text", text: formatSendReport(report, params.target) }],
        details: { ...report, target: params.target },
        isError: report.result !== "accepted",
      };
    },
  });
}
