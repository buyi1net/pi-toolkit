import type {
  AgentToolResult,
  ExtensionContext,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { compactSegment, renderToolCardCall, renderToolCardResult } from "../../../kit/tool-card.ts";
import type { Translator } from "../../../i18n/index.ts";
import { decompressCardDetails } from "../messages/index.ts";
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

const OBJECT_WIDTH = 40;

export interface AcpDecompressToolDetails {
  readonly toolUnavailable?: typeof TOOL_UNAVAILABLE_REASON;
  readonly mode?: AcpDecompressOutcome["mode"];
  readonly blockId?: string;
  readonly restored?: AcpDecompressOutcome["restored"];
}

function failureStatus(t: Translator, result: AgentToolResult<unknown> | undefined): string {
  return result && isAcpToolUnavailableDetails(result.details)
    ? t("module.compression.card.status.unavailable")
    : t("module.compression.card.status.failed");
}

const MODE_STATUS_KEYS: Record<AcpDecompressOutcome["mode"], string> = {
  "block-inline": "module.compression.card.decompress.mode.inline",
  "block-file": "module.compression.card.decompress.mode.file",
  "message-inline": "module.compression.card.decompress.mode.messageInline",
  "message-file": "module.compression.card.decompress.mode.messageFile",
  notice: "module.compression.card.decompress.mode.notice",
};

function decompressStatusText(
  t: Translator,
  details: AcpDecompressToolDetails | undefined,
): string | undefined {
  const mode = details?.mode;
  return mode === undefined ? undefined : t(MODE_STATUS_KEYS[mode]);
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
      return renderToolCardCall({ title: t("module.compression.tool.decompress.display"), object: decompressObject(args) }, theme, context);
    },
    renderResult(result, options, theme: Theme, context) {
      const isError = context?.isError === true;
      const status = isError
        ? failureStatus(t, result)
        : decompressStatusText(t, result.details as AcpDecompressToolDetails | undefined);
      const details = options.expanded && !isError
        ? decompressCardDetails(result.details as AcpDecompressToolDetails | undefined, t)
        : [];
      return renderToolCardResult(
        {
          title: t("module.compression.tool.decompress.display"),
          object: decompressObject(context?.args),
          status,
          details,
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

      try {
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
            ...(outcome.restored === undefined ? {} : { restored: outcome.restored }),
          } satisfies AcpDecompressToolDetails,
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
