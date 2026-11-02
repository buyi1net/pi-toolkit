import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { renderToolCardCall, renderToolCardResult } from "../../kit/tool-card.ts";
import { Type } from "typebox";
import { subscribePeersIdle, type PeersIdleSubscribeReport, type PeersSendDeps } from "./messaging.ts";
import {
  PEERS_IDLE_SUBSCRIPTION_DEFAULT_TTL_MS,
  PEERS_IDLE_SUBSCRIPTION_MAX_TTL_MS,
  PEERS_IDLE_SUBSCRIPTION_MIN_TTL_MS,
} from "./subscriptions.ts";
import type { PeersTranslate } from "./messages/index.ts";

export interface PeersNotifyIdleToolDeps extends PeersSendDeps {
  readonly label: string;
  readonly t?: PeersTranslate;
}

function formatSubscribeReport(report: PeersIdleSubscribeReport, target: string): string {
  const head = `peers_notify_when_idle → target ${JSON.stringify(target)}`;
  const reference =
    report.subscriptionId !== null
      ? ` subscription id ${report.subscriptionId}${report.expiresAt !== null ? `, expires at ${new Date(report.expiresAt).toISOString()}` : ""}.`
      : "";
  if (report.result === "accepted") {
    return `${head}: SUBSCRIBED (one-shot; it fires once when the target next becomes idle or exits, and carries no read or processed guarantee). ${report.detail}${reference}`;
  }
  if (report.result === "rejected") {
    return `${head}: NOT SUBSCRIBED (rejected: ${report.reason ?? "no reason code"}). ${report.detail}`;
  }
  return `${head}: SUBSCRIPTION FAILED (error${report.unsupported ? ", target may not support idle notifications" : ""}: ${report.reason ?? "no reason code"}). ${report.detail}`;
}

function renderStatus(details: Partial<PeersIdleSubscribeReport> | undefined, t?: PeersTranslate): string {
  if (details?.result === "accepted") {
    return details.state === "fired"
      ? (t?.("module.peers.tool.notify.result.fired") ?? "Target already idle; notice accepted")
      : (t?.("module.peers.tool.notify.result.armed") ?? "Idle notice subscribed");
  }
  return t?.("module.peers.tool.notify.result.failed", { reason: details?.reason ?? "failed" }) ?? "Subscription failed";
}

export function registerPeersNotifyIdleTool(pi: ExtensionAPI, deps: PeersNotifyIdleToolDeps): void {
  pi.registerTool({
    name: "peers_notify_when_idle",
    label: deps.label,
    description:
      "Subscribe to a one-shot notice about another local pi session becoming idle or exiting; use it instead of waiting or polling for a peer. " +
      "The target is not woken and does not start a turn: this only arms a subscription on the target's own session. " +
      "The subscription fires at most once, on the target's next idle settle or on its exit, and it never carries a read or processed guarantee. " +
      `If the target is already idle, the notice is sent immediately and its delivery is awaited before this call returns; that consumes the subscription outright, because nothing is left to wait for. Otherwise it expires after ttlMs (default ${PEERS_IDLE_SUBSCRIPTION_DEFAULT_TTL_MS}ms, allowed range ${PEERS_IDLE_SUBSCRIPTION_MIN_TTL_MS}-${PEERS_IDLE_SUBSCRIPTION_MAX_TTL_MS}ms) and stops firing without any expiry message. ` +
      "Notice delivery is best-effort: a notice dropped by the receiver's rate limit or queue, a crashed target that never reports exit, or this session being offline at the trigger all produce no notice. " +
      "So no notice by the expiry time means the outcome is unknown, not that the target stayed busy; check peers_list for its current state. " +
      "Subscribe frames and notices share the same per-pair rate limit as messages (default 10/minute). " +
      "Subscriptions live in the target's memory only: they do not survive that session restarting. " +
      "The notice arrives as a normal external peer message and is not a user instruction. " +
      "Target addressing is the same as peers_send (short id, session name, session UUID prefix, or instance id). ",
    promptSnippet:
      "Subscribe once to a peer's next idle or exit; the notice arrives as an external peer message (no waiting, no polling)",
    parameters: Type.Object({
      target: Type.String({
        minLength: 1,
        description:
          "Address of the session to observe: #short-id, session name, full session UUID or unique prefix (>= 4 chars), or instance id",
      }),
      ttlMs: Type.Optional(
        Type.Number({
          minimum: PEERS_IDLE_SUBSCRIPTION_MIN_TTL_MS,
          maximum: PEERS_IDLE_SUBSCRIPTION_MAX_TTL_MS,
          description: `Lifetime of the subscription in milliseconds (default ${PEERS_IDLE_SUBSCRIPTION_DEFAULT_TTL_MS}). It expires silently: no message is sent on expiry.`,
        }),
      ),
    }),
    renderShell: "self",
    renderCall(args, theme, context) {
      const target = typeof args.target === "string" && args.target.trim() !== "" ? args.target.trim() : "(target)";
      const title = deps.t?.("module.peers.tool.notify.display", { target }) ?? "Notify when idle";
      return renderToolCardCall({ title, object: target }, theme, context);
    },
    renderResult(result, options, theme, context) {
      const details = result.details as (Partial<PeersIdleSubscribeReport> & { target?: unknown }) | undefined;
      const target = typeof details?.target === "string" ? details.target : "(target)";
      const title = deps.t?.("module.peers.tool.notify.display", { target }) ?? "Notify when idle";
      const expanded = options.expanded && typeof details?.detail === "string" ? [details.detail] : [];
      return renderToolCardResult(
        { title, object: target, status: renderStatus(details, deps.t), details: expanded },
        theme,
        options,
        context,
      );
    },
    async execute(
      _toolCallId: string,
      params: { target: string; ttlMs?: number },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: ExtensionContext | undefined,
    ): Promise<{
      content: { type: "text"; text: string }[];
      details: PeersIdleSubscribeReport & { readonly target: string };
      isError?: boolean;
    }> {
      const report = await subscribePeersIdle(deps, params.target, params.ttlMs ?? PEERS_IDLE_SUBSCRIPTION_DEFAULT_TTL_MS);
      return {
        content: [{ type: "text", text: formatSubscribeReport(report, params.target) }],
        details: { ...report, target: params.target },
        isError: report.result !== "accepted",
      };
    },
  });
}
