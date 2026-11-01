import type { AgentToolResult, ExtensionContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { cloneWithDescriptions, LEAN_HOW_TO_COMPRESS, leanPack, type Pack } from "acp-kernel";
import { Type } from "typebox";
import { compactSegment, renderToolCardCall, renderToolCardResult, toolCardText } from "../../../kit/tool-card.ts";
import type { Translator } from "../../../i18n/index.ts";
import {
  EMPTY_ACP_ADVANCED_SETTINGS,
  type AcpAdvancedSettings,
  type AcpPromptPack,
} from "../api.ts";
import { resolveAcpRuntimeConfig } from "./config.ts";
import type { AcpCompressionEngine } from "./engine.ts";
import {
  acpToolUnavailable,
  isAcpToolUnavailableDetails,
  TOOL_UNAVAILABLE_REASON,
} from "./tool-guard.ts";

const RangeSpec = Type.Object({
  startId: Type.String({
    description: 'Message ref, e.g. "m00005" (from the acp tag), or a block id "b3".',
  }),
  endId: Type.String({ description: "Inclusive end ref. Must be at or after startId." }),
  summary: Type.String({
    description:
      "Complete technical summary replacing all content in range. Keep only essential details (conclusions, file paths, decisions, exact values, etc.).",
  }),
  topic: Type.Optional(
    Type.String({
      description:
        "Short label (3-5 words) for THIS range, e.g. 'Auth System Exploration'. Omit to use the top-level topic.",
    }),
  ),
});

const CompressParams = Type.Object({
  topic: Type.Optional(
    Type.String({
      description: "Fallback topic for entries without their own. Omit when each content entry specifies its own topic.",
    }),
  ),
  content: Type.Union([Type.Array(RangeSpec), Type.String()], {
    description:
      "One or more ranges to compress, each with start/end boundaries and a summary. When compressing multiple unrelated ranges in one call, give each range its own topic.",
  }),
  summaryMaxChars: Type.Optional(
    Type.Number({
      description:
        "Override max summary length (default max: 20000 chars). Use when content is important and needs more detail — don't lose critical info just to fit the limit.",
    }),
  ),
});

export interface AcpCompressToolSurface {
  readonly description?: string;
  readonly promptSnippet?: string;
  readonly promptGuidelines?: readonly string[];
  readonly paramDescriptions?: Readonly<Record<string, string>>;
}

const BASE_GUIDELINES = [
  "Each message carries an acp tag with its mNNNNN ref, token size, and type. Compress ranges by their refs.",
  "Batch multiple unrelated ranges in one call — each gets its own topic and summary.",
  "Write dense, self-contained summaries — preserve file paths, signatures, errors, and decisions verbatim.",
  "Never compress content the current step is actively using.",
];

function leanCompressSurface(pack: Pack): AcpCompressToolSurface {
  const toolPrompts = pack.surface.toolPrompts?.compress as
    | { description?: unknown; paramDescriptions?: unknown }
    | undefined;
  const description = typeof toolPrompts?.description === "string" ? toolPrompts.description : undefined;
  const paramDescriptionsRaw = toolPrompts?.paramDescriptions;
  const paramDescriptions: Record<string, string> = {};
  if (paramDescriptionsRaw && typeof paramDescriptionsRaw === "object" && !Array.isArray(paramDescriptionsRaw)) {
    for (const [key, value] of Object.entries(paramDescriptionsRaw as Record<string, unknown>)) {
      if (typeof value === "string") paramDescriptions[key] = value;
    }
  }
  const extras = (pack.surface.adapters?.pi as { toolExtras?: Record<string, unknown> } | undefined)?.toolExtras
    ?.compress as { promptSnippet?: unknown; promptGuidelines?: unknown } | undefined;
  const promptSnippet = typeof extras?.promptSnippet === "string" ? extras.promptSnippet : "";
  return {
    ...(description !== undefined ? { description } : {}),
    ...(Object.keys(paramDescriptions).length > 0 ? { paramDescriptions } : {}),
    promptSnippet,
  };
}

export function acpCompressToolSurfaceFor(acp: AcpAdvancedSettings | undefined): AcpCompressToolSurface | undefined {
  const resolved = resolveAcpRuntimeConfig({}, acp ?? EMPTY_ACP_ADVANCED_SETTINGS);
  const merged = resolved.merged;
  const overriddenRules = merged.prompts?.howToCompressRules;
  const pack: AcpPromptPack = resolved.promptPack;
  if (pack !== "lean") {

    return overriddenRules === undefined
      ? undefined
      : { promptGuidelines: [...BASE_GUIDELINES, overriddenRules] };
  }
  const contract = overriddenRules ?? LEAN_HOW_TO_COMPRESS;
  return {
    ...leanCompressSurface(leanPack),
    promptGuidelines: [contract],
  };
}

const TOOL_LABEL = "Compress";
const OBJECT_WIDTH = 40;
const STATUS_WIDTH = 64;

export interface AcpCompressToolDetails {
  readonly toolUnavailable?: typeof TOOL_UNAVAILABLE_REASON;
  readonly blocksCreated?: number;
  readonly tokensCompressed?: number;
}

function failureStatus(result: AgentToolResult<unknown> | undefined): string {
  if (result && isAcpToolUnavailableDetails(result.details)) return "unavailable";
  const firstLine = toolCardText(result ?? {}).split("\n").find((line) => line.trim()) ?? "";
  return compactSegment(firstLine, STATUS_WIDTH) ?? "failed";
}

function compressStatusText(details: AcpCompressToolDetails | undefined): string | undefined {
  const blocks = details?.blocksCreated;
  if (typeof blocks !== "number") return undefined;
  if (blocks <= 0) return "no blocks created";
  const tokens = details?.tokensCompressed;
  const tokensText = typeof tokens === "number" && tokens > 0 ? `, ${tokens} tokens` : "";
  return `${blocks} block${blocks === 1 ? "" : "s"} compressed${tokensText}`;
}

function compressObject(args: { topic?: unknown; content?: unknown } | undefined): string | undefined {
  const topic = compactSegment(typeof args?.topic === "string" ? args.topic : undefined, OBJECT_WIDTH);
  if (topic) return topic;
  return Array.isArray(args?.content)
    ? (args.content.length === 1 ? "1 range" : `${args.content.length} ranges`)
    : undefined;
}

export interface AcpCompressToolDeps {

  readonly engine: () => AcpCompressionEngine | undefined;
  readonly t: Translator;

  readonly isSessionActive: (ctx: ExtensionContext) => boolean;

  readonly readAcpSettings?: () => AcpAdvancedSettings;

  readonly clearFallback?: () => void;

  readonly conclude?: (ctx: ExtensionContext) => void;
}

function applySurface(
  def: ToolDefinition<typeof CompressParams>,
  surface: AcpCompressToolSurface | undefined,
): ToolDefinition<typeof CompressParams> {
  if (!surface) return def;
  return {
    ...def,
    ...(surface.description !== undefined ? { description: surface.description } : {}),
    ...(surface.promptSnippet !== undefined ? { promptSnippet: surface.promptSnippet } : {}),
    ...(surface.promptGuidelines !== undefined ? { promptGuidelines: [...surface.promptGuidelines] } : {}),
    ...(surface.paramDescriptions !== undefined
      ? { parameters: cloneWithDescriptions(def.parameters, { ...surface.paramDescriptions }) as typeof def.parameters }
      : {}),
  };
}

export function makeAcpCompressTool(deps: AcpCompressToolDeps): ToolDefinition<typeof CompressParams> {
  const { t } = deps;
  const surface = acpCompressToolSurfaceFor(deps.readAcpSettings?.());
  return applySurface({
    name: "compress",
    label: "Compress",
    description:
      "Replace older conversation ranges with detailed summaries you write. Single range: compress({ content: [{ startId, endId, summary }] }). " +
      "Batch: compress({ content: [{ topic, startId, endId, summary }, ...] }) — each entry gets its own topic and summary.",
    promptSnippet: "compress({ content: [{ startId, endId, summary }] }) or batch multiple ranges",
    promptGuidelines: [...BASE_GUIDELINES],
    parameters: CompressParams,
    renderShell: "self",
    renderCall(args, theme: Theme, context) {
      return renderToolCardCall({ title: TOOL_LABEL, object: compressObject(args) }, theme, context);
    },
    renderResult(result, options, theme: Theme, context) {
      const status = context?.isError
        ? failureStatus(result)
        : compressStatusText(result.details as AcpCompressToolDetails | undefined);
      return renderToolCardResult(
        {
          title: TOOL_LABEL,
          object: compressObject(context?.args),
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
      let text: string;
      let details: AcpCompressToolDetails = {};
      try {
        const outcome = await engine.executeCompress(
          {
            content: params.content,
            ...(params.topic === undefined ? {} : { topic: params.topic }),
            ...(params.summaryMaxChars === undefined ? {} : { summaryMaxChars: params.summaryMaxChars }),
          },
          ctx,
          toolCallId,
        );
        text = outcome.text;
        details = { blocksCreated: outcome.blocksCreated, tokensCompressed: outcome.tokensCompressed };

        if (outcome.persisted) deps.clearFallback?.();

        if (outcome.persisted) deps.conclude?.(ctx);
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        return {
          details: { error: text },
          content: [{ type: "text", text }],
          isError: true,
        };
      }
      return { details, content: [{ type: "text", text }] };
    },
  }, surface);
}
