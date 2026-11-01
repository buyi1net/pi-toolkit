import type {
  AgentToolResult,
  ExtensionContext,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { compactSegment, renderToolCardCall, renderToolCardResult, toolCardText } from "../../../kit/tool-card.ts";
import type { Translator } from "../../../i18n/index.ts";
import type { AcpCompressionEngine } from "./engine.ts";
import {
  acpToolUnavailable,
  isAcpToolUnavailableDetails,
  TOOL_UNAVAILABLE_REASON,
} from "./tool-guard.ts";

const SearchParams = Type.Object({
  query: Type.String({
    description: "Keywords to locate detail folded into compressed summaries or historical messages.",
  }),
  limit: Type.Optional(Type.Number({ description: "Max results (default 10)." })),
});

const TOOL_LABEL = "Search Context";
const OBJECT_WIDTH = 40;
const STATUS_WIDTH = 64;

export interface AcpSearchToolDetails {
  readonly toolUnavailable?: typeof TOOL_UNAVAILABLE_REASON;
  readonly matches?: number;
}

function failureStatus(result: AgentToolResult<unknown> | undefined): string {
  if (result && isAcpToolUnavailableDetails(result.details)) return "unavailable";
  const firstLine = toolCardText(result ?? {}).split("\n").find((line) => line.trim()) ?? "";
  return compactSegment(firstLine, STATUS_WIDTH) ?? "failed";
}

function searchStatusText(details: AcpSearchToolDetails | undefined): string | undefined {
  const matches = details?.matches;
  if (typeof matches !== "number") return undefined;
  if (matches <= 0) return "no matches";
  return matches === 1 ? "1 match" : `${matches} matches`;
}

function searchObject(args: { query?: unknown } | undefined): string | undefined {
  return compactSegment(typeof args?.query === "string" ? args.query : undefined, OBJECT_WIDTH);
}

export interface AcpSearchToolDeps {

  readonly engine: () => AcpCompressionEngine | undefined;
  readonly t: Translator;

  readonly isSessionActive: (ctx: ExtensionContext) => boolean;
}

export function makeAcpSearchTool(deps: AcpSearchToolDeps): ToolDefinition<typeof SearchParams> {
  const { t } = deps;
  return {
    name: "search_context",
    label: "Search Context",
    description:
      "Search compressed blocks AND folded historical messages by keyword. Use to cheaply locate detail before decompressing. Returns ranked results with ref, size, preview, the owning block's range, and the decompress command to retrieve full content.",
    promptSnippet: 'search_context({ query: "auth token" })',
    promptGuidelines: [
      "Search locates detail folded into summaries or past messages — cheaper than decompressing blind.",
      "Each result shows a ref (b3 block / m00350 message), size, the block's covered range, and the exact decompress command for full content.",
      "Message hits link to the owning block — decompress that block to recover surrounding detail.",
    ],
    parameters: SearchParams,
    renderShell: "self",
    renderCall(args, theme: Theme, context) {
      return renderToolCardCall({ title: TOOL_LABEL, object: searchObject(args) }, theme, context);
    },
    renderResult(result, options, theme: Theme, context) {
      const status = context?.isError
        ? failureStatus(result)
        : searchStatusText(result.details as AcpSearchToolDetails | undefined);
      return renderToolCardResult(
        {
          title: TOOL_LABEL,
          object: searchObject(context?.args),
          status,
          details: options.expanded ? toolCardText(result).split("\n") : [],
        },
        theme,
        options,
        context,
      );
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
      if (!deps.isSessionActive(ctx)) return acpToolUnavailable(t);
      const engine = deps.engine();
      if (!engine) return acpToolUnavailable(t);
      try {
        const outcome = await engine.executeSearch(
          {
            query: params.query,
            ...(params.limit === undefined ? {} : { limit: params.limit }),
          },
          ctx,
        );
        return {
          details: { matches: outcome.matches } satisfies AcpSearchToolDetails,
          content: [{ type: "text", text: outcome.text }],
          isError: outcome.failed === true,
        };
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        return { details: { error: text }, content: [{ type: "text", text }], isError: true };
      }
    },
  };
}
