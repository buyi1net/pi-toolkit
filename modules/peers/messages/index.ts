import { createTableTranslator } from "../../../i18n/index.ts";
import type { MessageTables, MessageVars, ResolvedLanguage, Translator } from "../../../i18n/index.ts";

export const PEERS_SEND_REPLY_HINT = "Do not wait or poll for a reply; end this turn.";

const EN = {
  "module.peers.label": "Session discovery & messaging",
  "module.peers.description": "Discover peer pi sessions on this machine and exchange messages between them",
  "module.peers.enabled.label": "Enable session discovery",
  "module.peers.enabled.description": "When off, no peer discovery handle is registered and messaging is unavailable (reload to apply)",

  "module.peers.problem.init": "Peers module initialization problem: {detail}",
  "module.peers.problem.runtime": "Peers module hit a runtime problem",

  "module.peers.tool.list.label": "List peer sessions",
  "module.peers.tool.list.display": "List local sessions",
  "module.peers.tool.list.result.summary": "{online} online · {offline} offline",
  "module.peers.tool.list.result.stale": "Snapshot problem; showing the last successful scan",

  "module.peers.list.empty": "No peer sessions found",
  "module.peers.list.truncated": "List truncated; older entries hidden",
  "module.peers.list.onlineSection": "Online ({count})",
  "module.peers.list.offlineSection": "Offline ({count})",
  "module.peers.list.unnamed": "unnamed",
  "module.peers.list.self": "this session",
  "module.peers.list.selfOtherInstance": "another instance of this session",
  "module.peers.list.duplicateShortId": "duplicate short id",
  "module.peers.list.multipleInstances": "multiple instances",
  "module.peers.list.detailSession": "session {id}",
  "module.peers.list.detailInstance": "instance {id}",

  "module.peers.status.working": "working",
  "module.peers.status.idle": "idle",
  "module.peers.status.blocked": "blocked",
  "module.peers.status.sluggish": "sluggish",
  "module.peers.status.offline": "offline",

  "module.peers.tool.send.label": "Send message to peer session",
  "module.peers.tool.send.display": "Message",
  "module.peers.tool.send.result.submitted": "Peer endpoint accepted",
  "module.peers.tool.send.result.failed": "Delivery failed: {reason}",

  "module.peers.tool.notify.label": "Subscribe to an idle notice",
  "module.peers.tool.notify.display": "Notify when idle",
  "module.peers.tool.notify.result.armed": "Idle notice subscribed",
  "module.peers.tool.notify.result.fired": "Target already idle; notice delivered to this session",
  "module.peers.tool.notify.result.failed": "Subscription failed: {reason}",
  "module.peers.tool.send.result.subscribed": "idle notice subscribed",

  "module.peers.renderer.title": "External session",
  "module.peers.renderer.instance": "instance {id}",
  "module.peers.renderer.sentAt": "Sent {time}",
  "module.peers.renderer.received": "Received",
  "module.peers.renderer.cwd": "Working directory: {cwd}",
  "module.peers.renderer.bodyUnavailable": "Message body unavailable",
  "module.peers.reason.offline": "The target session is offline",
  "module.peers.reason.connect-timeout": "The connection timed out",
  "module.peers.reason.write-timeout": "Sending the message timed out",
  "module.peers.reason.protocol-version": "The peer speaks an incompatible protocol version",
  "module.peers.reason.invalid-frame": "The peer rejected the message format",
  "module.peers.reason.source-unregistered": "This session is not registered for peer messaging",
  "module.peers.reason.source-expired": "This session's peer registration has expired",
  "module.peers.reason.self-delivery": "The target is this same session",
  "module.peers.reason.rejected": "The peer refused the message",
  "module.peers.reason.queue-full": "The peer's inbound queue is full",
  "module.peers.reason.rate-limited": "Too many messages were sent in a short time",
  "module.peers.reason.content-too-large": "The message exceeds the size limit",
  "module.peers.reason.ambiguous-address": "The target matches more than one session",
  "module.peers.reason.unknown-target": "No session matches the target",
  "module.peers.reason.duplicate-message": "Duplicate message; the peer already received it",
  "module.peers.reason.receiver-injection-failed": "The peer accepted the message but could not hand it to its own session",
  "module.peers.tool.send.result.failedUnknown": "Delivery failed",
  "module.peers.tool.send.result.duplicateTag": "Duplicate message, not delivered again",
  "module.peers.tool.send.result.subscribedUntil": "Idle notice subscribed; expires {time}",
  "module.peers.tool.send.result.subscribedFired": "Target already idle; notice delivered to this session",
  "module.peers.tool.send.result.subscribeFailed": "Idle notice could not be set up: {reason}",
  "module.peers.tool.notify.result.failedUnknown": "Subscription failed",
  "module.peers.tool.notify.result.expiresAt": "One-shot; expires {time}",
  "module.peers.tool.notify.result.firedDetail": "Target already idle; notice delivered to this session",
} satisfies Record<string, string>;

const ZH_CN: typeof EN = {
  "module.peers.label": "会话发现与通讯",
  "module.peers.description": "发现本机开着其它 pi 会话，并在会话之间互发消息",
  "module.peers.enabled.label": "启用会话发现",
  "module.peers.enabled.description": "关闭后不注册会话发现句柄，通讯能力不可用（重载 pi 后生效）",

  "module.peers.problem.init": "会话发现与通讯模块初始化异常：{detail}",
  "module.peers.problem.runtime": "会话发现与通讯出现运行异常",

  "module.peers.tool.list.label": "列出本机会话",
  "module.peers.tool.list.display": "查询本机会话列表",
  "module.peers.tool.list.result.summary": "{online} 在线 · {offline} 离线",
  "module.peers.tool.list.result.stale": "快照异常，显示上次结果",

  "module.peers.list.empty": "未发现本机其它会话",
  "module.peers.list.truncated": "列表已截断，较早的条目未显示",
  "module.peers.list.onlineSection": "在线（{count}）",
  "module.peers.list.offlineSection": "离线（{count}）",
  "module.peers.list.unnamed": "未命名",
  "module.peers.list.self": "本会话",
  "module.peers.list.selfOtherInstance": "本会话的另一实例",
  "module.peers.list.duplicateShortId": "短码重码",
  "module.peers.list.multipleInstances": "多实例",
  "module.peers.list.detailSession": "会话 {id}",
  "module.peers.list.detailInstance": "实例 {id}",

  "module.peers.status.working": "工作中",
  "module.peers.status.idle": "空闲",
  "module.peers.status.blocked": "等待确认",
  "module.peers.status.sluggish": "响应迟缓",
  "module.peers.status.offline": "离线",

  "module.peers.tool.send.label": "给本机会话发消息",
  "module.peers.tool.send.display": "发消息给",
  "module.peers.tool.send.result.submitted": "对方端点已接受",
  "module.peers.tool.send.result.failed": "发送失败：{reason}",

  "module.peers.tool.notify.label": "订阅对方空闲通知",
  "module.peers.tool.notify.display": "空闲时通知我",
  "module.peers.tool.notify.result.armed": "已订阅空闲通知",
  "module.peers.tool.notify.result.fired": "对方已空闲，通知已送达本会话",
  "module.peers.tool.notify.result.failed": "订阅失败：{reason}",
  "module.peers.tool.send.result.subscribed": "已订阅空闲通知",

  "module.peers.renderer.title": "外部会话",
  "module.peers.renderer.instance": "实例 {id}",
  "module.peers.renderer.sentAt": "发送于 {time}",
  "module.peers.renderer.received": "已接收",
  "module.peers.renderer.cwd": "工作目录：{cwd}",
  "module.peers.renderer.bodyUnavailable": "正文不可用",
  "module.peers.reason.offline": "对方会话不在线",
  "module.peers.reason.connect-timeout": "连接超时",
  "module.peers.reason.write-timeout": "发送超时",
  "module.peers.reason.protocol-version": "对方协议版本不兼容",
  "module.peers.reason.invalid-frame": "对方拒绝了这条消息的格式",
  "module.peers.reason.source-unregistered": "本会话尚未登记会话通讯",
  "module.peers.reason.source-expired": "本会话的通讯登记已过期",
  "module.peers.reason.self-delivery": "目标就是本会话自己",
  "module.peers.reason.rejected": "对方拒收了这条消息",
  "module.peers.reason.queue-full": "对方的接收队列已满",
  "module.peers.reason.rate-limited": "短时间内发送的消息太多",
  "module.peers.reason.content-too-large": "消息超过大小上限",
  "module.peers.reason.ambiguous-address": "目标匹配到多个会话",
  "module.peers.reason.unknown-target": "没有匹配的会话",
  "module.peers.reason.duplicate-message": "重复消息，对方此前已收到",
  "module.peers.reason.receiver-injection-failed": "对方虽接收了消息，但没能交给自己的会话",
  "module.peers.tool.send.result.failedUnknown": "发送失败",
  "module.peers.tool.send.result.duplicateTag": "重复消息，未再次投递",
  "module.peers.tool.send.result.subscribedUntil": "已订阅空闲通知，到期时间 {time}",
  "module.peers.tool.send.result.subscribedFired": "对方已空闲，通知已送达本会话",
  "module.peers.tool.send.result.subscribeFailed": "空闲通知未能建立：{reason}",
  "module.peers.tool.notify.result.failedUnknown": "订阅失败",
  "module.peers.tool.notify.result.expiresAt": "一次性订阅，到期时间 {time}",
  "module.peers.tool.notify.result.firedDetail": "对方已空闲，通知已送达本会话",
};

const ZH_TW: typeof EN = {
  "module.peers.label": "會話發現與通訊",
  "module.peers.description": "發現本機開著其它 pi 會話，並在會話之間互傳訊息",
  "module.peers.enabled.label": "啟用會話發現",
  "module.peers.enabled.description": "關閉後不註冊會話發現句柄，通訊能力不可用（重新載入 pi 後生效）",

  "module.peers.problem.init": "會話發現與通訊模組初始化異常：{detail}",
  "module.peers.problem.runtime": "會話發現與通訊出現執行異常",

  "module.peers.tool.list.label": "列出本機會話",
  "module.peers.tool.list.display": "查詢本機會話列表",
  "module.peers.tool.list.result.summary": "{online} 線上 · {offline} 離線",
  "module.peers.tool.list.result.stale": "快照異常，顯示上次結果",

  "module.peers.list.empty": "未發現本機其它會話",
  "module.peers.list.truncated": "列表已截斷，較早的條目未顯示",
  "module.peers.list.onlineSection": "線上（{count}）",
  "module.peers.list.offlineSection": "離線（{count}）",
  "module.peers.list.unnamed": "未命名",
  "module.peers.list.self": "本會話",
  "module.peers.list.selfOtherInstance": "本會話的另一實例",
  "module.peers.list.duplicateShortId": "短碼重碼",
  "module.peers.list.multipleInstances": "多實例",
  "module.peers.list.detailSession": "會話 {id}",
  "module.peers.list.detailInstance": "實例 {id}",

  "module.peers.status.working": "工作中",
  "module.peers.status.idle": "閒置",
  "module.peers.status.blocked": "等待確認",
  "module.peers.status.sluggish": "回應遲緩",
  "module.peers.status.offline": "離線",

  "module.peers.tool.send.label": "給本機會話傳訊息",
  "module.peers.tool.send.display": "發訊息給",
  "module.peers.tool.send.result.submitted": "對方端點已接受",
  "module.peers.tool.send.result.failed": "傳送失敗：{reason}",

  "module.peers.tool.notify.label": "訂閱對方空閒通知",
  "module.peers.tool.notify.display": "空閒時通知我",
  "module.peers.tool.notify.result.armed": "已訂閱空閒通知",
  "module.peers.tool.notify.result.fired": "對方已空閒，通知已送達本會話",
  "module.peers.tool.notify.result.failed": "訂閱失敗：{reason}",
  "module.peers.tool.send.result.subscribed": "已訂閱空閒通知",

  "module.peers.renderer.title": "外部會話",
  "module.peers.renderer.instance": "實例 {id}",
  "module.peers.renderer.sentAt": "傳送於 {time}",
  "module.peers.renderer.received": "已接收",
  "module.peers.renderer.cwd": "工作目錄：{cwd}",
  "module.peers.renderer.bodyUnavailable": "內文無法取得",
  "module.peers.reason.offline": "對方會話不在線",
  "module.peers.reason.connect-timeout": "連線逾時",
  "module.peers.reason.write-timeout": "傳送逾時",
  "module.peers.reason.protocol-version": "對方協定版本不相容",
  "module.peers.reason.invalid-frame": "對方拒絕了這則訊息的格式",
  "module.peers.reason.source-unregistered": "本會話尚未登記會話通訊",
  "module.peers.reason.source-expired": "本會話的通訊登記已過期",
  "module.peers.reason.self-delivery": "目標就是本會話自己",
  "module.peers.reason.rejected": "對方拒收了這則訊息",
  "module.peers.reason.queue-full": "對方的接收佇列已滿",
  "module.peers.reason.rate-limited": "短時間內傳送的訊息太多",
  "module.peers.reason.content-too-large": "訊息超過大小上限",
  "module.peers.reason.ambiguous-address": "目標符合多個會話",
  "module.peers.reason.unknown-target": "沒有符合的會話",
  "module.peers.reason.duplicate-message": "重複訊息，對方此前已收到",
  "module.peers.reason.receiver-injection-failed": "對方雖接收了訊息，但沒能交給自己的會話",
  "module.peers.tool.send.result.failedUnknown": "傳送失敗",
  "module.peers.tool.send.result.duplicateTag": "重複訊息，未再次投遞",
  "module.peers.tool.send.result.subscribedUntil": "已訂閱空閒通知，到期時間 {time}",
  "module.peers.tool.send.result.subscribedFired": "對方已空閒，通知已送達本會話",
  "module.peers.tool.send.result.subscribeFailed": "空閒通知未能建立：{reason}",
  "module.peers.tool.notify.result.failedUnknown": "訂閱失敗",
  "module.peers.tool.notify.result.expiresAt": "一次性訂閱，到期時間 {time}",
  "module.peers.tool.notify.result.firedDetail": "對方已空閒，通知已送達本會話",
};

export const PEERS_MESSAGES = { en: EN, "zh-CN": ZH_CN, "zh-TW": ZH_TW } satisfies MessageTables;

export type PeersMessageKey = keyof typeof EN;

export type PeersTranslate = (key: PeersMessageKey, vars?: MessageVars) => string;

export function peersReasonLabel(code: unknown, t?: PeersTranslate): string | null {
  if (typeof code !== "string" || code === "") return null;
  const key = `module.peers.reason.${code}` as PeersMessageKey;
  return key in EN ? (t?.(key) ?? EN[key]) : null;
}

export function peersStatusLabel(status: string, t?: PeersTranslate): string {
  const key = `module.peers.status.${status}` as PeersMessageKey;
  return key in EN ? (t?.(key) ?? EN[key]) : status;
}

export function peersTableTranslator(language: ResolvedLanguage): Translator {
  return createTableTranslator(PEERS_MESSAGES[language], language);
}
