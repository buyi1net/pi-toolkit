// Codex 远程压缩协议接缝（工单 04 只定义共享契约，不实现协议细节）。
//
// 上游对应：reference/Pi生态/pi-codex-compact/source/src/remote.ts 与
// remote-types.ts（MIT，来源登记见 ../UPSTREAM.md）。适配点：
// - 上游 remote.ts 在三条协议间 switch 分发；本仓把每条协议做成可注入的
//   adapter（工单 05 = Remote V2，工单 06 = responses/compact，工单 07 =
//   Context Management），owner 只依赖本接口——本工单的 fake transport 与
//   后续真实协议共用同一条核心链路（创建 → 保存 → 校验 → 回放）。
// - 协议枚举用本仓 api.ts 的 CodexProtocol（与策略解析 / 规则配置同源），
//   不引入上游的 "auto" 设置值（协议选择已由策略解析完成）。
// - 类型不从 pi-ai 直接导入（pi-ai 不是本包直接依赖、package.json 不动）：
//   Model / Provider / headers / usage 全部从 pi-coding-agent 的公开导出
//   结构推导，请求上下文用自有结构形状（convertToLlm 的返回消息）。
//
// adapter 的契约（工单 05/06/07 实现，owner 侧前置校验）：
// - 请求带全量上下文（已按 priorCheckpoint 投影）、profile、鉴权与信号；
// - 响应必须包含「恰好一个」可回放 compaction item（item）与实际发出的
//   prompt input；context-management 协议直接给出 replacementHistory；
// - adapter 内部负责远端响应的收集、校验与重试，失败以异常上抛（owner
//   按 prepare 阶段失败处理，遵守规格回退规则）。

import type {
  CompactionResult,
  ExtensionContext,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import type { CodexProtocol } from "../api.ts";
import type { ResponsesCompactionProfile } from "./profiles.ts";
import type { JsonObject } from "./protocol.ts";

/** 会话模型（ExtensionContext["model"] 的非空形：provider/id/api/baseUrl/contextWindow…） */
export type CodexRemoteModel = NonNullable<ExtensionContext["model"]>;

/** provider 运行时（模型目录解析出的 provider 对象） */
export type CodexRemoteProvider = NonNullable<ReturnType<ModelRegistry["getProvider"]>>;

/** provider 鉴权 headers（ResolvedRequestAuth 成功分支的 headers 形状） */
export type CodexRemoteProviderHeaders = Extract<
  Awaited<ReturnType<ModelRegistry["getApiKeyAndHeaders"]>>,
  { ok: true }
>["headers"];

/** 压缩请求的 usage（与 CompactionResult.usage 同形） */
export type CodexRemoteUsage = NonNullable<CompactionResult["usage"]>;

/** LLM 消息（convertToLlm 的返回元素形状） */
export type CodexRemoteLlmMessage = ReturnType<typeof import("@earendil-works/pi-coding-agent").convertToLlm>[number];

/** 压缩请求的工具描述 */
export interface CodexRemoteTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
}

/** 远程压缩请求的上下文（pi-ai Context 的结构形状） */
export interface CodexRemoteContext {
  readonly systemPrompt?: string;
  readonly messages: readonly CodexRemoteLlmMessage[];
  readonly tools?: readonly CodexRemoteTool[];
}

/** 已提交 checkpoint 的回放载荷：marker 消息 + replacement history */
export interface PriorCheckpointPayload {
  readonly marker: string;
  readonly replacementHistory: readonly unknown[];
}

/** 远程压缩请求（owner 组装，adapter 消费；形状与上游 RemoteCompactionRequest 对齐） */
export interface CodexRemoteCompactionRequest {
  readonly provider: CodexRemoteProvider;
  readonly model: CodexRemoteModel;
  readonly profile: ResponsesCompactionProfile;
  readonly context: CodexRemoteContext;
  readonly protocol: CodexProtocol;
  readonly apiKey?: string;
  readonly headers?: CodexRemoteProviderHeaders;
  readonly env?: Record<string, string>;
  readonly signal: AbortSignal;
  readonly priorCheckpoint?: PriorCheckpointPayload;
  readonly requestTimeoutMs?: number;
  readonly maxRetries?: number;
  readonly fetch?: typeof globalThis.fetch;
}

/** 远程压缩响应：恰好一个 opaque compaction item + 实际请求视图 */
export interface CodexRemoteCompactionResponse {
  readonly item: JsonObject;
  readonly promptInput: readonly JsonObject[];
  readonly compactedOutput?: readonly JsonObject[];
  readonly replacementHistory?: readonly JsonObject[];
  readonly usage: CodexRemoteUsage;
}

/** 单条协议的适配器（工单 05/06/07 各自注册；owner 经 options 注入） */
export type CodexRemoteCompactionAdapter = (
  request: CodexRemoteCompactionRequest,
) => Promise<CodexRemoteCompactionResponse>;

/** 已接入的协议适配器表：key 缺席 = 该协议在本构建里不可用（preflight 拦截） */
export type CodexProtocolAdapterMap = Readonly<Partial<Record<CodexProtocol, CodexRemoteCompactionAdapter>>>;
