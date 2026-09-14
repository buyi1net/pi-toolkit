// peers 模块三语键表（自包含：本模块的文案只在这里；模块目录拿走则这些文案一起消失）。
// 框架级键（command/menu/group/problem/language/common/hint/notify）在 i18n/messages.ts。
// 三语（en / zh-CN / zh-TW）必须同时补齐：ZH_CN / ZH_TW 以 typeof EN 断言，缺键/多键 typecheck 报错；
// 三语键集合相等与无未翻译值由 tests/pi-toolkit/i18n-messages.test.ts 兜底。

import { formatMessage } from "../../../i18n/index.ts";
import type { MessageTables, MessageVars, ResolvedLanguage, Translator } from "../../../i18n/index.ts";

const EN = {
  "module.peers.label": "Session discovery & messaging",
  "module.peers.description": "Discover peer pi sessions on this machine and exchange messages between them",
  "module.peers.enabled.label": "Enable session discovery",
  "module.peers.enabled.description": "When off, no peer discovery handle is registered and messaging is unavailable (reload to apply)",

  "module.peers.inboundPolicy.label": "Cross-session collaboration",
  "module.peers.inboundPolicy.description": "Whether this session accepts messages sent by other local sessions",
  "module.peers.inboundPolicy.accept": "Accept messages",
  "module.peers.inboundPolicy.reject": "Reject messages",

  "module.peers.problem.init": "Peers module initialization problem: {detail}",
  "module.peers.problem.runtime": "Peers module runtime problem: {detail}",

  "module.peers.tool.list.label": "List peer sessions",

  "module.peers.tool.send.label": "Send message to peer session",

  // 外部消息卡片渲染器（工单 50）：标题 / 元信息 / 正文不可用与折叠提示
  "module.peers.renderer.title": "External session",
  "module.peers.renderer.instance": "instance {id}",
  "module.peers.renderer.sentAt": "Sent {time}",
  "module.peers.renderer.replyClaim": "Reply relation: the sender claims this is a reply to @{shortId}",
  "module.peers.renderer.replyClaimFull": "Reply relation: the sender claims this is a reply to {id}",
  "module.peers.renderer.cwd": "Working directory: {cwd}",
  "module.peers.renderer.bodyUnavailable": "Message body unavailable",
  "module.peers.renderer.moreLines": "… {count} more lines",
} satisfies Record<string, string>;

const ZH_CN: typeof EN = {
  "module.peers.label": "会话发现与通讯",
  "module.peers.description": "发现本机开着其它 pi 会话，并在会话之间互发消息",
  "module.peers.enabled.label": "启用会话发现",
  "module.peers.enabled.description": "关闭后不注册会话发现句柄，通讯能力不可用（重载 pi 后生效）",

  "module.peers.inboundPolicy.label": "跨会话协作",
  "module.peers.inboundPolicy.description": "本会话是否接收其它本机会话发来的消息",
  "module.peers.inboundPolicy.accept": "接收",
  "module.peers.inboundPolicy.reject": "拒收",

  "module.peers.problem.init": "会话发现与通讯模块初始化异常：{detail}",
  "module.peers.problem.runtime": "会话发现与通讯模块运行异常：{detail}",

  "module.peers.tool.list.label": "列出本机会话",

  "module.peers.tool.send.label": "给本机会话发消息",

  // 外部消息卡片渲染器（工单 50）
  "module.peers.renderer.title": "外部会话",
  "module.peers.renderer.instance": "实例 {id}",
  "module.peers.renderer.sentAt": "发送于 {time}",
  "module.peers.renderer.replyClaim": "回复关系：对方声称这是对 @{shortId} 的回复",
  "module.peers.renderer.replyClaimFull": "回复关系：对方声称这是对 {id} 的回复",
  "module.peers.renderer.cwd": "工作目录：{cwd}",
  "module.peers.renderer.bodyUnavailable": "正文不可用",
  "module.peers.renderer.moreLines": "… 还有 {count} 行",
};

const ZH_TW: typeof EN = {
  "module.peers.label": "會話發現與通訊",
  "module.peers.description": "發現本機開著其它 pi 會話，並在會話之間互傳訊息",
  "module.peers.enabled.label": "啟用會話發現",
  "module.peers.enabled.description": "關閉後不註冊會話發現句柄，通訊能力不可用（重新載入 pi 後生效）",

  "module.peers.inboundPolicy.label": "跨會話協作",
  "module.peers.inboundPolicy.description": "本會話是否接收其它本機會話傳來的訊息",
  "module.peers.inboundPolicy.accept": "接收",
  "module.peers.inboundPolicy.reject": "拒收",

  "module.peers.problem.init": "會話發現與通訊模組初始化異常：{detail}",
  "module.peers.problem.runtime": "會話發現與通訊模組執行異常：{detail}",

  "module.peers.tool.list.label": "列出本機會話",

  "module.peers.tool.send.label": "給本機會話傳訊息",

  // 外部訊息卡片渲染器（工單 50）
  "module.peers.renderer.title": "外部會話",
  "module.peers.renderer.instance": "實例 {id}",
  "module.peers.renderer.sentAt": "傳送於 {time}",
  "module.peers.renderer.replyClaim": "回覆關係：對方聲稱這是對 @{shortId} 的回覆",
  "module.peers.renderer.replyClaimFull": "回覆關係：對方聲稱這是對 {id} 的回覆",
  "module.peers.renderer.cwd": "工作目錄：{cwd}",
  "module.peers.renderer.bodyUnavailable": "內文無法取得",
  "module.peers.renderer.moreLines": "… 還有 {count} 行",
};

/** 本键表：全部模块键表在 modules/index.ts 聚合登记 */
export const PEERS_MESSAGES = { en: EN, "zh-CN": ZH_CN, "zh-TW": ZH_TW } satisfies MessageTables;

/** 模块内使用的键类型 */
export type PeersMessageKey = keyof typeof EN;

/** 模块内取词函数（键收窄到本模块键表）：mod.ts 装配时注入宿主实时译者 */
export type PeersTranslate = (key: PeersMessageKey, vars?: MessageVars) => string;

/**
 * 只读本模块键表的译者（对标 subagents 的 subagentsTableTranslator）：不依赖
 * modules/index.ts 的全局登记，供测试与独立装载直接取三语文案。
 */
export function peersTableTranslator(language: ResolvedLanguage): Translator {
  const table: Record<string, string> = PEERS_MESSAGES[language];
  return (key, vars) => formatMessage(table[key], key, vars);
}
