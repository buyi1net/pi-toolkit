import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { compactRenderText, renderToolCardCall, renderToolCardResult, toolCardText } from "../../../kit/tool-card.ts";
import { subagentsTableTranslator, type SubagentsTranslate } from "../messages/index.ts";
import { assertFetchableUrl, htmlToText, urlForMessage } from "./web-html.ts";

export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/126.0.0.0 Safari/537.36";

export const FETCH_TIMEOUT_MS = 30_000;

export const MAX_CONTENT_CHARS = 60_000;

const FETCH_HEADERS: Record<string, string> = {
  "user-agent": BROWSER_USER_AGENT,
  accept: "text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.7",
  "accept-language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
};

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

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

    await response.body?.cancel().catch(() => {});
    currentUrl = nextUrl;
  }
}

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

function collapsedReason(text: string): string | undefined {
  const compact = compactRenderText(text);
  if (!compact) return undefined;
  return compact.length > 48 ? `${compact.slice(0, 47)}…` : compact;
}

export default function webFetchExtension(pi: ExtensionAPI, t: SubagentsTranslate = subagentsTableTranslator("en")) {
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
    renderShell: "self",
    renderCall(args, theme, context) {
      const url = typeof args.url === "string" ? args.url.trim() : "(url)";
      return renderToolCardCall(
        { title: t("module.subagents.tool.web_fetch.display"), object: url || "(url)" },
        theme,
        context,
      );
    },
    renderResult(result, options, theme, context) {
      const details = (result.details ?? {}) as { url?: unknown };
      const url =
        (typeof details.url === "string" && details.url.trim()) ||
        (typeof context?.args?.url === "string" && context.args.url.trim()) ||
        "(url)";
      const text = toolCardText(result);
      const httpStatus = /^status: (\d{3})/m.exec(text)?.[1];
      return renderToolCardResult(
        {
          title: t("module.subagents.tool.web_fetch.display"),
          object: url,
          status: context?.isError ? collapsedReason(text) : httpStatus ? `HTTP ${httpStatus}` : undefined,
          details: options.expanded ? text.split("\n") : [],
        },
        theme,
        options,
        context,
      );
    },
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
