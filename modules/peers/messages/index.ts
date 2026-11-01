import { formatMessage } from "../../../i18n/index.ts";
import type { MessageTables, MessageVars, ResolvedLanguage, Translator } from "../../../i18n/index.ts";

const EN = {
  "module.peers.label": "Session discovery & messaging",
  "module.peers.description": "Discover peer pi sessions on this machine and exchange messages between them",
  "module.peers.enabled.label": "Enable session discovery",
  "module.peers.enabled.description": "When off, no peer discovery handle is registered and messaging is unavailable (reload to apply)",

  "module.peers.problem.init": "Peers module initialization problem: {detail}",
  "module.peers.problem.runtime": "Peers module runtime problem: {detail}",

  "module.peers.tool.list.label": "List peer sessions",
  "module.peers.tool.list.display": "List local sessions",
  "module.peers.tool.list.result.summary": "{online} online · {offline} offline",

  "module.peers.tool.send.label": "Send message to peer session",
  "module.peers.tool.send.display": "Message",
  "module.peers.tool.send.result.delivered": "Delivered",
  "module.peers.tool.send.result.failed": "Delivery failed: {reason}",
  "module.peers.tool.send.result.moreLines": "… {count} more lines",
  "module.peers.tool.send.result.bodyUnavailable": "Message body unavailable",

  "module.peers.renderer.title": "External session",
  "module.peers.renderer.instance": "instance {id}",
  "module.peers.renderer.sentAt": "Sent {time}",
  "module.peers.renderer.cwd": "Working directory: {cwd}",
  "module.peers.renderer.bodyUnavailable": "Message body unavailable",
} satisfies Record<string, string>;

const ZH_CN: typeof EN = {
  "module.peers.label": "会话发现与通讯",
  "module.peers.description": "发现本机开着其它 pi 会话，并在会话之间互发消息",
  "module.peers.enabled.label": "启用会话发现",
  "module.peers.enabled.description": "关闭后不注册会话发现句柄，通讯能力不可用（重载 pi 后生效）",

  "module.peers.problem.init": "会话发现与通讯模块初始化异常：{detail}",
  "module.peers.problem.runtime": "会话发现与通讯模块运行异常：{detail}",

  "module.peers.tool.list.label": "列出本机会话",
  "module.peers.tool.list.display": "查询本机会话列表",
  "module.peers.tool.list.result.summary": "{online} 在线 · {offline} 离线",

  "module.peers.tool.send.label": "给本机会话发消息",
  "module.peers.tool.send.display": "发消息给",
  "module.peers.tool.send.result.delivered": "已送达",
  "module.peers.tool.send.result.failed": "发送失败：{reason}",
  "module.peers.tool.send.result.moreLines": "… 还有 {count} 行",
  "module.peers.tool.send.result.bodyUnavailable": "消息正文不可用",

  "module.peers.renderer.title": "外部会话",
  "module.peers.renderer.instance": "实例 {id}",
  "module.peers.renderer.sentAt": "发送于 {time}",
  "module.peers.renderer.cwd": "工作目录：{cwd}",
  "module.peers.renderer.bodyUnavailable": "正文不可用",
};

const ZH_TW: typeof EN = {
  "module.peers.label": "會話發現與通訊",
  "module.peers.description": "發現本機開著其它 pi 會話，並在會話之間互傳訊息",
  "module.peers.enabled.label": "啟用會話發現",
  "module.peers.enabled.description": "關閉後不註冊會話發現句柄，通訊能力不可用（重新載入 pi 後生效）",

  "module.peers.problem.init": "會話發現與通訊模組初始化異常：{detail}",
  "module.peers.problem.runtime": "會話發現與通訊模組執行異常：{detail}",

  "module.peers.tool.list.label": "列出本機會話",
  "module.peers.tool.list.display": "查詢本機會話列表",
  "module.peers.tool.list.result.summary": "{online} 線上 · {offline} 離線",

  "module.peers.tool.send.label": "給本機會話傳訊息",
  "module.peers.tool.send.display": "發訊息給",
  "module.peers.tool.send.result.delivered": "已送達",
  "module.peers.tool.send.result.failed": "傳送失敗：{reason}",
  "module.peers.tool.send.result.moreLines": "… 還有 {count} 行",
  "module.peers.tool.send.result.bodyUnavailable": "訊息內文無法取得",

  "module.peers.renderer.title": "外部會話",
  "module.peers.renderer.instance": "實例 {id}",
  "module.peers.renderer.sentAt": "傳送於 {time}",
  "module.peers.renderer.cwd": "工作目錄：{cwd}",
  "module.peers.renderer.bodyUnavailable": "內文無法取得",
};

export const PEERS_MESSAGES = { en: EN, "zh-CN": ZH_CN, "zh-TW": ZH_TW } satisfies MessageTables;

export type PeersMessageKey = keyof typeof EN;

export type PeersTranslate = (key: PeersMessageKey, vars?: MessageVars) => string;

export function peersTableTranslator(language: ResolvedLanguage): Translator {
  const table: Record<string, string> = PEERS_MESSAGES[language];
  return (key, vars) => formatMessage(table[key], key, vars);
}
