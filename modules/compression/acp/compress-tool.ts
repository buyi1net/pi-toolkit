// ACP compress 工具（工单 08 最小闭环）：模型驱动的压缩执行入口。
//
// 移植自 billion-context-pi 的 src/compress-tool.ts（MIT），按工单 08 裁剪；
// 评审修复 F1 接上 prompt pack 的工具面：
// - 工具名 `compress`，参数 { content: [{startId, endId, summary, topic?}],
//   topic?, summaryMaxChars? }；内核的宽容解析器负责救回字符串化/尾逗号/
//   截断的参数（parseCompressArgs）；
// - 执行链：ensure 状态 → processTurn 分配引用 → applyCompression 建块 →
//   sidecar 原子落盘 → 面板文本（块跨度 + 摘要指纹 + 警告/错误）；
// - 参数解析失败按异常抛出（Pi 标记 isError，会话日志里成为重建时跳过的
//   失败调用）；内核校验失败（0 块）以面板文本返回，错误逐条列出；
// - 会话未命中 ACP（模型不在 ACP 策略下）时返回引导文本，不执行任何压缩；
// - prompt pack 工具面（上游 makeCompressTool + applyToolPromptOverrides 同款
//   机制）：注册期按全局级 ACP 配置解析一次（Pi 宿主在注册时快照 description/
//   promptSnippet/promptGuidelines，会话内不可变；无模型身份，取全局层），
//   lean = 内核 lean 包的一行描述 + 精简参数说明，snippet/guideline 裁掉，
//   压缩契约（LEAN_HOW_TO_COMPRESS）随 guidelines 走（本仓无系统提示接缝，
//   上游放在系统提示 howToCompress 节）；full 维持现状。提示词覆写
//   （howToCompressRules 槽位）追加进 guidelines，与 nudge 渲染同源生效。
//
// 未移植（按需再议）：死范围重复熔断、压缩失败重试上限、T3 重写拒绝。

import type {
  AgentToolResult,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { cloneWithDescriptions, LEAN_HOW_TO_COMPRESS, leanPack, type Pack } from "acp-kernel";
import { Type } from "typebox";
import type { Translator } from "../../../i18n/index.ts";
import {
  EMPTY_ACP_ADVANCED_SETTINGS,
  type AcpAdvancedSettings,
  type AcpPromptPack,
} from "../api.ts";
import { resolveAcpRuntimeConfig } from "./config.ts";
import type { AcpCompressionEngine } from "./engine.ts";

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

/** compress 工具的提示面覆写（上游 surface.ts 的 ToolPromptOverrides 同形状） */
export interface AcpCompressToolSurface {
  readonly description?: string;
  readonly promptSnippet?: string;
  readonly promptGuidelines?: readonly string[];
  readonly paramDescriptions?: Readonly<Record<string, string>>;
}

/** 基准（full 包）guidelines：与上游 compress-tool.ts 的四条同款 */
const BASE_GUIDELINES = [
  "Each message carries an acp tag with its mNNNNN ref, token size, and type. Compress ranges by their refs.",
  "Batch multiple unrelated ranges in one call — each gets its own topic and summary.",
  "Write dense, self-contained summaries — preserve file paths, signatures, errors, and decisions verbatim.",
  "Never compress content the current step is actively using.",
];

/** 内核 lean 包的 compress 工具面（toolPrompts + pi 适配的 toolExtras，运行时
 *  防御性读取——结构对不上时退回裁剪不变体） */
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

/** compress 工具提示面解析（注册期一次，全局级；无配置 → undefined = 现状）：
 *  - promptPack=lean：内核 lean 包的一行描述 + 精简参数说明 + 空 snippet；压缩
 *    契约（LEAN_HOW_TO_COMPRESS）进 guidelines——本仓无系统提示接缝，上游放在
 *    系统 howToCompress 节；
 *  - 提示词覆写（howToCompressRules 槽位）：追加进 guidelines（lean 下替换契约），
 *    与 nudge 渲染同源。 */
export function acpCompressToolSurfaceFor(acp: AcpAdvancedSettings | undefined): AcpCompressToolSurface | undefined {
  const resolved = resolveAcpRuntimeConfig({}, acp ?? EMPTY_ACP_ADVANCED_SETTINGS);
  const merged = resolved.merged;
  const overriddenRules = merged.prompts?.howToCompressRules;
  const pack: AcpPromptPack = resolved.promptPack;
  if (pack !== "lean") {
    // full：维持现状；仅提示词覆写时追加进 guidelines（配置承诺的行为）
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

export interface AcpCompressToolDeps {
  readonly engine: AcpCompressionEngine;
  readonly t: Translator;
  /** 当前会话是否命中 ACP 策略（mod.ts 每次调用时解析） */
  readonly isSessionActive: (ctx: ExtensionContext) => boolean;
  /** ACP 高级配置读取口（与引擎同源；注册期解析一次工具提示面，缺省 = full 现状） */
  readonly readAcpSettings?: () => AcpAdvancedSettings;
}

/** 工具面覆写应用到定义（上游 surface.ts 的 applyToolPromptOverrides 同款；
 *  参数说明经内核 cloneWithDescriptions 按属性名深度替换） */
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
  const { engine, t } = deps;
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
    async execute(toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
      if (!deps.isSessionActive(ctx)) {
        return {
          details: undefined,
          content: [{ type: "text", text: t("module.compression.acp.toolNotActive") }],
        };
      }
      let text: string;
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
      } catch (error) {
        // 参数/状态错误：抛出让 Pi 标记 isError（会话日志里的失败调用，
        // 重建流程会跳过它）
        throw error instanceof Error ? error : new Error(String(error));
      }
      return { details: undefined, content: [{ type: "text", text }] };
    },
  }, surface);
}
