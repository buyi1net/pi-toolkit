import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { compactRenderText, renderToolCardCall, renderToolCardResult, toolCardText } from "../../../kit/tool-card.ts";
import { subagentsTableTranslator, type SubagentsTranslate } from "../messages/index.ts";
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

export function parseDuckDuckGoResults(html: string, maxResults = DEFAULT_MAX_RESULTS): WebSearchResult[] {
  const results: WebSearchResult[] = [];

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

function collapsedReason(text: string): string | undefined {
  const compact = compactRenderText(text);
  if (!compact) return undefined;
  return compact.length > 48 ? `${compact.slice(0, 47)}…` : compact;
}

export default function webSearchExtension(pi: ExtensionAPI, t: SubagentsTranslate = subagentsTableTranslator("en")) {
  pi.registerTool({
    name: "web_search",
    label: "web_search",
    renderShell: "self",
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
    renderCall(args, theme, context) {
      const query = typeof args.query === "string" ? args.query.replace(/\s+/g, " ").trim() : "(query)";
      return renderToolCardCall(
        { title: t("module.subagents.tool.web_search.display"), object: query || "(query)" },
        theme,
        context,
      );
    },
    renderResult(result, options, theme, context) {
      const details = (result.details ?? {}) as { query?: unknown };
      const query =
        compactRenderText(details.query) ||
        (typeof context?.args?.query === "string" ? context.args.query.replace(/\s+/g, " ").trim() : "") ||
        "(query)";
      const text = toolCardText(result);
      const topCount = /\(top (\d+)\)/.exec(text)?.[1];
      return renderToolCardResult(
        {
          title: t("module.subagents.tool.web_search.display"),
          object: query,
          status: context?.isError ? collapsedReason(text) : topCount ? `${topCount} results` : undefined,
          details: options.expanded ? text.split("\n") : [],
        },
        theme,
        options,
        context,
      );
    },
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
