import type { Tool } from "@earendil-works/pi-ai";
import type {
  CompactionResult,
  ExtensionContext,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import type { CodexProtocol } from "../api.ts";
import type { ResponsesCompactionProfile } from "./profiles.ts";
import type { JsonObject } from "./protocol.ts";

export type CodexRemoteModel = NonNullable<ExtensionContext["model"]>;

export type CodexRemoteProvider = NonNullable<ReturnType<ModelRegistry["getProvider"]>>;

export type CodexRemoteProviderHeaders = Extract<
  Awaited<ReturnType<ModelRegistry["getApiKeyAndHeaders"]>>,
  { ok: true }
>["headers"];

export type CodexRemoteUsage = NonNullable<CompactionResult["usage"]>;

export type CodexRemoteLlmMessage = ReturnType<typeof import("@earendil-works/pi-coding-agent").convertToLlm>[number];

export interface CodexRemoteTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Tool["parameters"];
}

export interface CodexRemoteContext {
  readonly systemPrompt?: string;
  readonly messages: readonly CodexRemoteLlmMessage[];
  readonly tools?: readonly CodexRemoteTool[];
}

export interface PriorCheckpointPayload {
  readonly marker: string;
  readonly replacementHistory: readonly unknown[];
}

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

export interface CodexRemoteCompactionResponse {
  readonly item: JsonObject;
  readonly promptInput: readonly JsonObject[];
  readonly compactedOutput?: readonly JsonObject[];
  readonly replacementHistory?: readonly JsonObject[];
  readonly usage: CodexRemoteUsage;
}

export type CodexRemoteCompactionAdapter = (
  request: CodexRemoteCompactionRequest,
) => Promise<CodexRemoteCompactionResponse>;

export type CodexProtocolAdapterMap = Readonly<Partial<Record<CodexProtocol, CodexRemoteCompactionAdapter>>>;
