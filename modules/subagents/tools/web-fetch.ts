/**
 * web_fetch 扩展：给声明了 `web_fetch` 工具的子代理提供 URL 抓取能力（工单 29）。
 *
 * 背景：researcher 等 profile 长期声明 web_fetch/web_search，但背书扩展被
 * 期望安装在 `<agentDir>/extensions/web-fetch/index.ts`——多数机器上从未
 * 存在，pi 又会静默丢弃 --tools 白名单里没有提供方的名字，子代理于是只剩
 * ask_question。本文件与 web-search.ts 一起作为模块捆绑的兜底实现，由
 * getToolExtensionPath 在用户未安装扩展时回退注入（-e 本文件）。
 *
 * 代理与网络：Node ≥ 24 的全局 fetch 只在 NODE_USE_ENV_PROXY=1 时才走
 * HTTP(S)_PROXY；启动事务在装载 web 工具时会为子进程设置该变量。
 * 旧 Node 上该变量是 no-op，fetch 直连（目标不可达时报清晰的 fetch 失败）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { assertFetchableUrl, htmlToText, urlForMessage } from "./web-html.ts";

export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/126.0.0.0 Safari/537.36";

/** 单次抓取超时（毫秒）。 */
export const FETCH_TIMEOUT_MS = 30_000;
/** 返回给模型的最大字符数（约 15–20k token，防止单次抓取塞爆上下文）。 */
export const MAX_CONTENT_CHARS = 60_000;

const FETCH_HEADERS: Record<string, string> = {
  "user-agent": BROWSER_USER_AGENT,
  accept: "text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.7",
  "accept-language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
};

/** 手动跟随的跳转上限（工单 32：每跳都要重跑 SSRF 校验）。 */
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * 抓取并手动跟随跳转：`redirect: "follow"` 会把校验过的公网地址直接带到
 * 内网/回环目标上，因此逐跳用 assertFetchableUrl 重校验；跳转目标不合法
 * 当场拒绝，绝不发出那一跳的请求。
 */
async function fetchFollowingRedirects(rawUrl: string): Promise<Response> {
  let currentUrl = rawUrl;
  for (let hop = 0; ; hop += 1) {
    let response: Response;
    try {
      response = await fetch(currentUrl, {
        headers: FETCH_HEADERS,
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (error: any) {
      const cause = error?.cause?.code ?? error?.code ?? "";
      const hint =
        cause === "UND_ERR_CONNECT_TIMEOUT" || cause === "ENOTFOUND" || cause === "ECONNREFUSED"
          ? " (direct connection failed; if this network needs a proxy, run Node >= 24 with NODE_USE_ENV_PROXY=1 and HTTP(S)_PROXY set)"
          : "";
      throw new Error(`web_fetch failed for ${urlForMessage(currentUrl)}: ${error?.message ?? String(error)}${cause ? ` [${cause}]` : ""}${hint}`);
    }
    const location = response.headers.get("location");
    if (!location || !REDIRECT_STATUSES.has(response.status)) return response;
    if (hop >= MAX_REDIRECTS) {
      throw new Error(`web_fetch exceeded ${MAX_REDIRECTS} redirects for ${urlForMessage(rawUrl)}`);
    }
    let nextUrl: string;
    try {
      nextUrl = new URL(location, currentUrl).toString();
    } catch {
      throw new Error(`web_fetch got an unusable redirect target from ${urlForMessage(currentUrl)}`);
    }
    const blocked = assertFetchableUrl(nextUrl);
    if (blocked) {
      throw new Error(
        `web_fetch refused redirect target (${urlForMessage(currentUrl)} → ${urlForMessage(nextUrl)}): ${blocked}`,
      );
    }
    // 未消费的重定向响应体会占住连接池，换下一跳前排空。
    await response.body?.cancel().catch(() => {});
    currentUrl = nextUrl;
  }
}

/** 抓单个 URL 并整理为模型可读文本（导出供测试与 web-search 复用语义）。 */
export async function fetchUrlAsText(
  rawUrl: string,
  opts: { raw?: boolean } = {},
): Promise<string> {
  const blocked = assertFetchableUrl(rawUrl);
  if (blocked) throw new Error(blocked);
  if (typeof fetch !== "function") {
    throw new Error("global fetch is unavailable (Node < 18); web_fetch requires a modern runtime.");
  }
  const response = await fetchFollowingRedirects(rawUrl);
  if (!response.ok) {
    throw new Error(`web_fetch got HTTP ${response.status} ${response.statusText} for ${urlForMessage(rawUrl)}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();
  const looksHtml = /html|xml/i.test(contentType) || /^\s*<(?:!doctype html|html)/i.test(body);
  const rendered =
    opts.raw || !looksHtml ? body : htmlToText(body);
  const truncated = rendered.length > MAX_CONTENT_CHARS;
  const content = truncated ? rendered.slice(0, MAX_CONTENT_CHARS) : rendered;
  const finalUrl = response.url && response.url !== rawUrl ? `final URL: ${response.url}\n` : "";
  return (
    `url: ${rawUrl}\n${finalUrl}status: ${response.status}\ncontent-type: ${contentType || "unknown"}\n\n` +
    content +
    (truncated ? `\n\n[truncated at ${MAX_CONTENT_CHARS} chars of ${rendered.length}]` : "")
  );
}

export default function webFetchExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_fetch",
    label: "web_fetch",
    description:
      "Fetch a single http(s) URL and return its content as readable text (HTML is converted to plain text). " +
      "Use it for fetching a known documentation page, raw file, or API endpoint. " +
      "Internal/loopback addresses are refused.",
    promptSnippet:
      "Use this tool to fetch one specific http(s) URL and read its content when the exact address is already known.",
    promptGuidelines: [
      "Fetch one URL per call.",
      "Prefer canonical documentation URLs; follow redirects is automatic.",
      "If the result is truncated, refine the query or fetch more specific pages instead of re-fetching the same URL.",
    ],
    parameters: Type.Object({
      url: Type.String({
        description: "The absolute http(s) URL to fetch.",
      }),
      raw: Type.Optional(
        Type.Boolean({
          description: "Return the raw body without HTML-to-text conversion (default false).",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const url = String((params as { url?: unknown }).url ?? "");
      const raw = Boolean((params as { raw?: unknown }).raw);
      const text = await fetchUrlAsText(url, { raw });
      return {
        content: [{ type: "text" as const, text }],
        details: { url, raw },
      };
    },
  });
}
