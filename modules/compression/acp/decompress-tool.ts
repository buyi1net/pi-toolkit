// ACP decompress 工具（工单 09）：把压缩块或单条消息的原文找回。
//
// 移植自 billion-context-pi 的 src/decompress-tool.ts（MIT，见模块
// UPSTREAM.md），按本仓口径裁剪：
// - 工具名 `decompress`，参数 { blockId, full?, toFile?, inline? }；
// - 块模式默认写文件（块可能很大），inline: true 才把内容作为工具结果带回
//   当前请求视图（引用回到视图 + 重复插入被引擎拒绝）；单消息模式默认内联；
// - toFile 只允许临时/缓存目录（路径安全见 restore.ts）；
// - 执行链在引擎（engine.executeDecompress）：collectBlockContent 只读收集 →
//   内联登记（markBlockRestoredInline，支持 K2 原地重折叠）→ sidecar 落盘；
// - 模块关闭或会话未命中 ACP 时返回标准拒绝结果（工单 01），不触碰任何状态。
//
// 未移植（上游裁剪）：omp 宿主 refused 口径、abort 信号细粒度检查、祖先
// 会话日志回溯与 live-* 引用桥接（归后续工单）。

import type {
  AgentToolResult,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Translator } from "../../../i18n/index.ts";
import type { AcpCompressionEngine } from "./engine.ts";
import { acpToolUnavailable } from "./tool-guard.ts";

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

export interface AcpDecompressToolDeps {
  /** Lazy engine 代理（工单 01）：未启用或非 ACP 模式时不取用（不会创建引擎） */
  readonly engine: () => AcpCompressionEngine | undefined;
  readonly t: Translator;
  /** 当前会话是否走 ACP（模块启用且模型命中 ACP 策略；mod.ts 每次调用时解析） */
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
    async execute(toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
      if (!deps.isSessionActive(ctx)) return acpToolUnavailable(t);
      const engine = deps.engine();
      if (!engine) return acpToolUnavailable(t);
      // 状态不可用等硬错误按异常抛出（isError 落日志，不伪装成功）
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
      return { details: undefined, content: [{ type: "text", text: outcome.text }] };
    },
  };
}
