// peers_send 模型侧工具（工单 39）：按目标寻址投递一句话，返回三态结果与原因码。
//
// 文案口径与 peers_list 相同：工具名、描述与模型可见的结果文本是稳定的协议文本
// （英文），不随界面语言变化；人类界面的工具显示名走三语键表（mod.ts 装配时解析）。
// 发送语义（寻址、组帧、三态映射）全部在 messaging.ts 的 deliverPeersMessage；本文件
// 只做参数形状与结果呈现，不含判定逻辑。

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { describePeersReason, deliverPeersMessage, type PeersSendDeps, type PeersSendReport, type PeersTargetStatusSnapshot } from "./messaging.ts";

export interface PeersSendToolDeps extends PeersSendDeps {
  /** 工具显示名（三语键表在装配时解析） */
  readonly label: string;
}

/** 寻址时刻对端状态快照的模型可见文案（新增文案用英文）：注册候选给活性 / 活动 /
 * 心跳年龄；纯磁盘离线候选中活动与心跳不可得，写 unavailable，不伪造数值。 */
function formatTargetStatus(status: PeersTargetStatusSnapshot): string {
  if (status.source === "disk") {
    return "offline (no live instance; activity and heartbeat age unavailable)";
  }
  return `${status.liveness} / ${status.activity} / heartbeat age ${status.heartbeatAgeMs}ms`;
}

/** 把发送报告折成模型可见文本（稳定英文协议文本） */
function formatSendReport(report: PeersSendReport, target: string): string {
  const head = `peers_send → target ${JSON.stringify(target)}`;
  if (report.result === "accepted") {
    const duplicate = report.reason === "duplicate-message";
    // 成功回执按 id 形状给出引用：UUID 给完整 id 加 `@` 短码，非 UUID 只给完整 id（决策 4）
    const reference =
      report.messageId !== null
        ? ` message id ${report.messageId}${report.messageShortId !== null ? ` (@${report.messageShortId})` : ""}.`
        : "";
    return `${head}: DELIVERED (accepted${duplicate ? ", duplicate message id — receiver did not inject it again" : ""}). ${report.detail}${reference}`;
  }
  const reasonText =
    report.reason !== null ? `${report.reason} (${describePeersReason(report.reason)})` : "no reason code";
  // 传输类失败带阶段（connect / write / response）：只作可观测信息，不对模型暴露重试策略细节
  const stageText = report.stage !== null ? `; stage: ${report.stage}` : "";
  // 失败回执带上寻址时刻的对端状态（决策 9）；多义 / 目标不明等无单一对端的拒绝不带
  const statusText =
    report.targetStatus !== null
      ? ` Target status at resolution: ${formatTargetStatus(report.targetStatus)}.`
      : "";
  if (report.result === "rejected") {
    return `${head}: NOT DELIVERED (rejected: ${reasonText}${stageText}).${statusText} ${report.detail}`;
  }
  return `${head}: DELIVERY FAILED (error: ${reasonText}${stageText}).${statusText} ${report.detail}`;
}

export function registerPeersSendTool(pi: ExtensionAPI, deps: PeersSendToolDeps): void {
  pi.registerTool({
    name: "peers_send",
    label: deps.label,
    description:
      "Send a message to another local pi session on this machine (same agent directory). " +
      "The send completes immediately once the target endpoint accepts it; it does not wait for the receiver's LLM to process it. " +
      "Target may be: a 6-char short id with # prefix (like #62nvbt, from peers_list), a session name, a full session UUID or a unique lowercase prefix (min 4 chars), or an instance id (needed when one session runs multiple instances). " +
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

    async execute(
      _toolCallId: string,
      params: { target: string; body: string; replyTo?: string },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: ExtensionContext | undefined,
    ): Promise<{
      content: { type: "text"; text: string }[];
      details: PeersSendReport & { readonly target: string };
    }> {
      const report = await deliverPeersMessage(deps, params.target, params.body, params.replyTo ?? null);
      return {
        content: [{ type: "text", text: formatSendReport(report, params.target) }],
        details: { ...report, target: params.target },
      };
    },
  });
}
