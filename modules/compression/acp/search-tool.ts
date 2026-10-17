// ACP search_context 工具（工单 09）：按关键词定位压缩块与被折叠消息。
//
// 移植自 billion-context-pi 的 src/search-tool.ts（MIT，见模块 UPSTREAM.md），
// 执行链在引擎（engine.executeSearch → acp/search.ts）：块摘要 + 被覆盖原始
// 消息建索引 → 内核 searchBlocks 排序 → 格式化（命中带 ref / 归属块 / 块
// 跨度 / decompress 指令）；空结果返回可理解反馈（搜索范围 + 下一步建议）。
// 会话未命中 ACP 时返回引导文本。

import type {
  AgentToolResult,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Translator } from "../../../i18n/index.ts";
import type { AcpCompressionEngine } from "./engine.ts";

const SearchParams = Type.Object({
  query: Type.String({
    description: "Keywords to locate detail folded into compressed summaries or historical messages.",
  }),
  limit: Type.Optional(Type.Number({ description: "Max results (default 10)." })),
});

export interface AcpSearchToolDeps {
  readonly engine: AcpCompressionEngine;
  readonly t: Translator;
  /** 当前会话是否命中 ACP 策略（mod.ts 每次调用时解析） */
  readonly isSessionActive: (ctx: ExtensionContext) => boolean;
}

export function makeAcpSearchTool(deps: AcpSearchToolDeps): ToolDefinition<typeof SearchParams> {
  const { engine, t } = deps;
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
    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
      if (!deps.isSessionActive(ctx)) {
        return {
          details: undefined,
          content: [{ type: "text", text: t("module.compression.acp.toolNotActive") }],
        };
      }
      const outcome = await engine.executeSearch(
        {
          query: params.query,
          ...(params.limit === undefined ? {} : { limit: params.limit }),
        },
        ctx,
      );
      return { details: undefined, content: [{ type: "text", text: outcome.text }] };
    },
  };
}
