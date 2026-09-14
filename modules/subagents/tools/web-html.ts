/**
 * web_fetch / web_search 共用的 HTML 处理纯函数（工单 29）。
 *
 * 捆绑网络工具（tools/web-fetch.ts、tools/web-search.ts）的公共落点：
 *  - htmlToText：把 HTML 正文转成模型可读的纯文本（剥 script/style/注释、
 *    标签转分隔、解码常见实体、折叠空白）；
 *  - assertFetchableUrl：SSRF-lite 防线，只放行 http(s) 公网地址。
 * 本文件不依赖 pi API（可被两个独立扩展各自 import，也便于单测）。
 */

/** 常见 HTML 实体 → 字符（十进制/十六进制数字实体单独处理）。 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
  "#x27": "'",
  "#x2F": "/",
};

function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, entity: string) => {
    const named = NAMED_ENTITIES[entity];
    if (named !== undefined) return named;
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      if (Number.isInteger(code) && code > 0 && code <= 0x10ffff) return String.fromCodePoint(code);
      return whole;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      if (Number.isInteger(code) && code > 0 && code <= 0x10ffff) return String.fromCodePoint(code);
      return whole;
    }
    return whole;
  });
}

/** HTML → 可读纯文本。不追求 DOM 保真，目标是让模型读正文不挨标签噪音。 */
export function htmlToText(html: string): string {
  let text = html;
  // 块级/换行标签转分隔，再剥 script/style/head/meta 与注释的内容。
  text = text.replace(/<(script|style|noscript|template|svg|head)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  text = text.replace(/<!--[\s\S]*?-->/g, " ");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre|table|ul|ol|dl|dd|dt|nav|footer|header)\s*>/gi, "\n");
  // 剩余标签整体剥掉（含自闭合与属性内的引号）。
  text = text.replace(/<[^>]+>/g, " ");
  text = decodeEntities(text);
  // 折叠空白：同一行内多个空格合一，三个以上连续换行压成两个。
  text = text.replace(/[ \t\f\v]+/g, " ");
  text = text.replace(/\n[ \t]+/g, "\n");
  text = text.replace(/[ \t]+\n/g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

/** 解码 DuckDuckGo 结果锚点的 //duckduckgo.com/l/?uddg=<urlencoded> 跳转。 */
export function decodeDuckRedirect(href: string): string | null {
  try {
    const raw = href.trim();
    const url = new URL(raw, "https://duckduckgo.com");
    if (url.hostname !== "duckduckgo.com" || url.pathname !== "/l/") return null;
    const target = url.searchParams.get("uddg");
    if (!target) return null;
    const decoded = new URL(target);
    return decoded.protocol === "http:" || decoded.protocol === "https:" ? decoded.toString() : null;
  } catch {
    return null;
  }
}

/**
 * 错误文案里的 URL 摘要：丢掉可能携带凭据的 userinfo 与 query / fragment（工单 32）。
 * 解析不了的字符串按同一规则做字面裁剪，不整体回显。
 */
export function urlForMessage(rawUrl: string): string {
  const head = rawUrl.split(/[?#]/, 1)[0]!;
  return head.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1");
}

/** IPv4 字面量的内网/保留段判定。 */
function isPrivateIpv4(host: string): boolean {
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return /^(0\.|255\.)/.test(host);
}

/**
 * 从 IPv4 映射/兼容形态的 IPv6 里取出内嵌 IPv4（工单 32）：`::ffff:7f00:1`、
 * `::ffff:127.0.0.1`、`::a00:1` 都指向一个可以点分写出的 IPv4；只看字面前缀
 * 会把它们当公网地址放行。非这两种形态返回 undefined。
 */
function embeddedIpv4(host: string): string | undefined {
  const tail = host.startsWith("::ffff:") ? host.slice(7) : host.startsWith("::") ? host.slice(2) : undefined;
  if (tail === undefined) return undefined;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(tail)) return tail;
  const last = tail.split(":").slice(-2);
  if (last.length !== 2 || !last.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return undefined;
  const high = Number.parseInt(last[0]!, 16);
  const low = Number.parseInt(last[1]!, 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

/** 判断主机名是否为内网/本机/链路本地目标（SSRF-lite 防线）。 */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return true;
  }
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  if (host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) return true;
  const embedded = embeddedIpv4(host);
  if (embedded !== undefined) return isPrivateIpv4(embedded);
  if (isPrivateIpv4(host)) return true;
  // 未加密 DNS 通配（*.internal 之外的元数据常见名）。
  if (host === "metadata.google.internal") return true;
  return false;
}

/**
 * 校验一个 URL 是否允许抓取：仅 http(s) 且非内网/本机地址。
 * 返回 null 表示放行；否则返回面向工具结果的原因文案。
 */
export function assertFetchableUrl(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return `Invalid URL: ${urlForMessage(rawUrl)}`;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `Unsupported protocol "${url.protocol}" — only http/https URLs can be fetched.`;
  }
  if (url.username || url.password) {
    return "URLs with embedded credentials are refused.";
  }
  if (isPrivateHost(url.hostname)) {
    return (
      `Refusing to fetch internal/loopback address "${url.hostname}" — only public http(s) targets are allowed.`
    );
  }
  return null;
}
