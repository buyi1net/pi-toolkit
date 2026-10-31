import type {
  AgentToolResult,
  ExtensionContext,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { compactSegment, renderToolCardCall, renderToolCardResult, toolCardText } from "../../../kit/tool-card.ts";
import type { Translator } from "../../../i18n/index.ts";
import type { AcpCompressionEngine, AcpDecompressOutcome } from "./engine.ts";
import {
  acpToolUnavailable,
  isAcpToolUnavailableDetails,
  TOOL_UNAVAILABLE_REASON,
} from "./tool-guard.ts";

const DecompressParams = Type.Object({
  blockId: Type.String({
    description:
      'Block id to restore, e.g. "b5". Also accepts a message ref ("m00012" or a search hit id) — restores that single message from the session log.',
  }),
  full: Type.Optional(
    Type.Boolean({
      description:
        "If true, recurse through all nested block tiers to original messages. Default: false (restores one tier up — nested block summaries shown, direct messages in full).",
    }),
  ),
  toFile: Type.Optional(
    Type.String({
      description:
        "Write restored content to this file path (must be under /tmp, ~/.cache/opencode, or ~/.cache/pi) instead of the default auto-generated path. Block stays compressed.",
    }),
  ),
  inline: Type.Optional(
    Type.Boolean({
      description:
        "If true, return content inline as this tool's result (back into the current request view). Default: false — block content is written to an auto-generated file to avoid context bloat. Only set true when the content is small or you accept the context cost.",
    }),
  ),
});

const TOOL_LABEL = "Decompress";
const OBJECT_WIDTH = 40;
const STATUS_WIDTH = 64;

export interface AcpDecompressToolDetails {
  readonly toolUnavailable?: typeof TOOL_UNAVAILABLE_REASON;
  readonly mode?: AcpDecompressOutcome["mode"];
  readonly blockId?: string;
}

function failureStatus(result: AgentToolResult<unknown> | undefined): string {
  if (result && isAcpToolUnavailableDetails(result.details)) return "unavailable";
  const firstLine = toolCardText(result ?? {}).split("\n").find((line) => line.trim()) ?? "";
  return compactSegment(firstLine, STATUS_WIDTH) ?? "failed";
}

const MODE_STATUS: Record<AcpDecompressOutcome["mode"], string> = {
  "block-inline": "restored inline",
  "block-file": "written to file",
  "message-inline": "message restored inline",
  "message-file": "message written to file",
  notice: "notice",
};

function decompressStatusText(
  details: AcpDecompressToolDetails | undefined,
  result: AgentToolResult<unknown> | undefined,
): string | undefined {
  const mode = details?.mode;
  if (mode === undefined) return undefined;
  if (mode !== "notice") return MODE_STATUS[mode];
  const firstLine = toolCardText(result ?? {}).split("\n").find((line) => line.trim()) ?? "";
  return compactSegment(firstLine, STATUS_WIDTH) ?? MODE_STATUS.notice;
}

function decompressObject(args: { blockId?: unknown } | undefined): string | undefined {
  return compactSegment(typeof args?.blockId === "string" ? args.blockId : undefined, OBJECT_WIDTH);
}

export interface AcpDecompressToolDeps {

  readonly engine: () => AcpCompressionEngine | undefined;
  readonly t: Translator;

  readonly isSessionActive: (ctx: ExtensionContext) => boolean;
}

export function makeAcpDecompressTool(deps: AcpDecompressToolDeps): ToolDefinition<typeof DecompressParams> {
  const { t } = deps;
  return {
    name: "decompress",
    label: "Decompress",
    description:
      "Restore a previously compressed block's content, or a single message by its ref. The block/message stays compressed — context and cache prefix are not disrupted. " +
      'BLOCK decompress (blockId "b5") defaults to writing a file (blocks can be large); use the read tool to access it, or inline: true to return it into the conversation. ' +
      "MESSAGE decompress (blockId = a message ref from search_context) returns that ONE message's original text — defaults to inline since a single message is usually small; oversized messages go to a file. full: true recurses through nested block tiers (block mode only).",
    promptSnippet:
      'decompress({ blockId: "b5" }) — writes to file by default; add inline: true to restore into the conversation',
    promptGuidelines: [
      "Decompress when you need exact details lost in compression (file contents, error messages, signatures).",
      "Search first (search_context) to locate the right block, then decompress it — cheaper than restoring blind.",
      "Pass inline: true ONLY when content is small or you accept the context cost (block mode).",
      "Restored content re-enters the conversation via this tool's result; re-fold it with compress when done.",
    ],
    parameters: DecompressParams,
    renderShell: "self",
    renderCall(args, theme: Theme, context) {
      return renderToolCardCall({ title: TOOL_LABEL, object: decompressObject(args) }, theme, context);
    },
    renderResult(result, options, theme: Theme, context) {
      const status = context?.isError
        ? failureStatus(result)
        : decompressStatusText(result.details as AcpDecompressToolDetails | undefined, result);
      return renderToolCardResult(
        {
          title: TOOL_LABEL,
          object: decompressObject(context?.args),
          status,
          details: options.expanded ? toolCardText(result).split("\n") : [],
        },
        theme,
        options,
        context,
      );
    },
    async execute(toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
      if (!deps.isSessionActive(ctx)) return acpToolUnavailable(t);
      const engine = deps.engine();
      if (!engine) return acpToolUnavailable(t);

      const outcome = await engine.executeDecompress(
        {
          blockId: params.blockId,
          ...(params.full === undefined ? {} : { full: params.full }),
          ...(params.toFile === undefined ? {} : { toFile: params.toFile }),
          ...(params.inline === undefined ? {} : { inline: params.inline }),
        },
        ctx,
        toolCallId,
      );
      return {
        details: {
          mode: outcome.mode,
          ...(outcome.blockId === undefined ? {} : { blockId: outcome.blockId }),
        } satisfies AcpDecompressToolDetails,
        content: [{ type: "text", text: outcome.text }],
      };
    },
  };
}
