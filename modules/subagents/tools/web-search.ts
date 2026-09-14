/**
 * web_search 扩展：给声明了 `web_search` 工具的子代理提供无密钥网页搜索
 * （工单 29）。与 web-fetch.ts 同为模块捆绑兜底实现：用户在
 * `<agentDir>/extensions/web-search/index.ts` 安装了自己的实现时以用户版为准，
 * 否则由 getToolExtensionPath 回退注入本文件。
 *
 * 搜索后端：DuckDuckGo HTML 端点（html.duckduckgo.com/html/?q=…），带浏览器
 * UA 实测可稳定返回结果页；结果锚点是 //duckduckgo.com/l/?uddg=<encoded>
 * 跳转，解析时还原真实目标 URL。无 API key、无配额，代价是反爬策略变化
 * 时可能空手而归——此时返回明确的原因与状态码，不编造结果。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { assertFetchableUrl, decodeDuckRedirect, htmlToText } from "./web-html.ts";
import { BROWSER_USER_AGENT, FETCH_TIMEOUT_MS } from "./web-fetch.ts";

const SEARCH_ENDPOINT = "https://html.duckduckgo.com/html/";
const DEFAULT_MAX_RESULTS = 8;
const HARD_MAX_RESULTS = 10;

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** 从 DuckDuckGo HTML 结果页解析结果列表（纯函数，导出供单测）。 */
export function parseDuckDuckGoResults(html: string, maxResults = DEFAULT_MAX_RESULTS): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  // 结果锚点：<a class="result__a" href="…">标题（可含 <b>）</a>
  const anchorPattern = /<a[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorPattern.exec(html)) !== null && results.length < maxResults) {
    const href = match[1];
    const title = htmlToText(match[2]);
    if (!title) continue;
    let url: string | null;
    if (href.startsWith("//") || href.startsWith("https://duckduckgo.com/l/") || href.startsWith("/l/")) {
      url = decodeDuckRedirect(href);
    } else {
      const blocked = assertFetchableUrl(href);
      url = blocked ? null : href;
    }
    if (!url) continue;
    // 摘要锚点跟在同一个结果块里：从锚点结束位置向后找最近的 result__snippet。
    const snippetPattern = /<a[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i;
    const after = html.slice(anchorPattern.lastIndex);
    const snippetMatch = snippetPattern.exec(after);
    const snippet = snippetMatch ? htmlToText(snippetMatch[1]) : "";
    results.push({ title, url, snippet });
  }
  return results;
}

async function searchDuckDuckGo(query: string, maxResults: number): Promise<string> {
  const requestUrl = `${SEARCH_ENDPOINT}?q=${encodeURIComponent(query)}`;
  let response: Response;
  try {
    response = await fetch(requestUrl, {
      headers: {
        "user-agent": BROWSER_USER_AGENT,
        accept: "text/html,application/xhtml+xml",
        "accept-language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error: any) {
    const cause = error?.cause?.code ?? error?.code ?? "";
    const hint =
      cause === "UND_ERR_CONNECT_TIMEOUT" || cause === "ENOTFOUND"
        ? " (search engine unreachable; if this network needs a proxy, run Node >= 24 with NODE_USE_ENV_PROXY=1 and HTTP(S)_PROXY set)"
        : "";
    throw new Error(`web_search request failed: ${error?.message ?? String(error)}${cause ? ` [${cause}]` : ""}${hint}`);
  }
  if (!response.ok) {
    throw new Error(
      `web_search got HTTP ${response.status} from the search backend ` +
        `(the keyless HTML endpoint may be rate-limited or challenged; retry later or install a dedicated web-search extension).`,
    );
  }
  const html = await response.text();
  const results = parseDuckDuckGoResults(html, maxResults);
  if (results.length === 0) {
    return (
      `No results parsed for "${query}" (backend status ${response.status}). ` +
      "The engine may have returned an anti-bot challenge page. Try rephrasing the query or fetching a known URL with web_fetch."
    );
  }
  return (
    `Search results for "${query}" (top ${results.length}):\n\n` +
    results
      .map((result, index) => `${index + 1}. ${result.title}\n   ${result.url}${result.snippet ? `\n   ${result.snippet}` : ""}`)
      .join("\n\n")
  );
}

export default function webSearchExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "web_search",
    description:
      "Search the web (keyless DuckDuckGo backend) and return top results with titles, URLs and snippets. " +
      "Use it to discover sources; then use web_fetch to read the promising ones.",
    promptSnippet:
      "Use this tool to run a web search and collect candidate sources (titles + URLs + snippets) before fetching pages.",
    promptGuidelines: [
      "One focused query per call; use several targeted queries rather than one broad one.",
      "Follow up promising results with web_fetch instead of re-searching.",
      "Cite sources by their URL in the final brief.",
    ],
    parameters: Type.Object({
      query: Type.String({
        description: "The search query (keep it focused, <= 400 characters).",
        maxLength: 400,
      }),
      max_results: Type.Optional(
        Type.Integer({
          description: `Maximum number of results to return (1-${HARD_MAX_RESULTS}, default ${DEFAULT_MAX_RESULTS}).`,
          minimum: 1,
          maximum: HARD_MAX_RESULTS,
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const query = String((params as { query?: unknown }).query ?? "").trim();
      if (!query) throw new Error("web_search requires a non-empty query.");
      const requested = Number((params as { max_results?: unknown }).max_results ?? DEFAULT_MAX_RESULTS);
      const maxResults = Number.isInteger(requested)
        ? Math.min(Math.max(requested, 1), HARD_MAX_RESULTS)
        : DEFAULT_MAX_RESULTS;
      const text = await searchDuckDuckGo(query, maxResults);
      return {
        content: [{ type: "text" as const, text }],
        details: { query, maxResults },
      };
    },
  });
}

export const __test__ = { parseDuckDuckGoResults };
