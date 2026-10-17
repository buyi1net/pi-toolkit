// Codex opaque checkpoint 核心（工单 04 从上游 pi-codex-compact 提取并转入本仓维护）。
//
// 上游对应：reference/Pi生态/pi-codex-compact/source/src/checkpoint.ts（MIT，
// 来源登记见 ../UPSTREAM.md）。提取与适配：
// - checkpoint details 的创建/解析/校验、消息指纹、marker 与 fallback 文案、
//   replacement history 构造、消息级投影（marker → replacement history 的前缀
//   校验）全部保留上游算法；kind 换成本仓自己的标识（pi-toolkit-codex-compaction，
//   version 1），上游三种历史版本（v1/v2/v3 + 上游 kind）不迁移——外部扩展的
//   存量 checkpoint 迁移归工单 14 的收口动作，不在本单。
// - 上游 parseCheckpointDetails 里的 context-management 历史校验由工单 07 接入：
//   新的 checkpoint-first history 走完整的 checkpoint / encrypted reasoning /
//   replacement history 校验；工单 04 已存在的非 checkpoint-first 对象数组继续
//   走兼容解析，避免旧日志失效。adapter 和 owner 在发布前都使用完整校验。
// - codexCheckpointIdentity 是新增：把规格要求的 provider / model / profile /
//   protocol 身份校验收敛成一个纯函数，owner 的 prepare 与 projection 阶段共用。
//
// Pi 契约（工单 03 核验本仓 runtime 的 pi-coding-agent，宿主 pi CLI 1.3.0 携带的
// npm 包实际为 0.85.1——dist/core/compaction/compaction.d.ts）：
// CompactionResult 至少含 summary / firstKeptEntryId / tokensBefore，可带 usage
// 与 details——checkpoint details 随 compaction entry 一起由宿主落盘，
// summary 即 checkpoint marker 的 fallback 文案（不是把 opaque 历史解码成明文）。

import { createHash, randomUUID } from "node:crypto";
import type { CompactionEntry, ContextEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { CodexProtocol } from "../api.ts";
import { validateContextManagementHistory } from "./context-management.ts";
import { profileMatchesApi, type ResponsesCompactionProfile } from "./profiles.ts";
import { type JsonObject, validateCompactionItem } from "./protocol.ts";

/**
 * 会话消息类型：从 Pi 的 context 事件形状推导（pi-agent-core / pi-ai 不是
 * 本包的直接依赖，不引内部包名——与 vision-types.ts 同款口径）。
 */
export type CodexAgentMessage = ContextEvent["messages"][number];

/** 本仓 checkpoint details 的 kind 标识（区别于上游 pi-codex-remote-compaction） */
export const CHECKPOINT_KIND = "pi-toolkit-codex-compaction";
export const CHECKPOINT_VERSION = 1;
export const REPLACEMENT_TOKEN_BUDGET = 64_000;
export const REPLACEMENT_BYTE_BUDGET = 8 * 1024 * 1024;
const MAX_MEDIA_ITEM_BYTES = 2 * 1024 * 1024;
const MAX_CHECKPOINT_DETAILS_BYTES = 10 * 1024 * 1024;
const MAX_CHECKPOINT_ID_LENGTH = 128;
const MAX_PROVIDER_ID_LENGTH = 256;
const MAX_API_ID_LENGTH = 256;
const MAX_MODEL_ID_LENGTH = 512;
const MAX_KEPT_FINGERPRINTS = 100_000;

/**
 * Codex checkpoint 的私有状态：作为 compaction entry 的 details 随会话日志
 * 原子落盘（无独立 sidecar 文件）。replacementHistory 是发给远端的
 * replacement 请求视图（保留的近期用户消息 + 恰好一个 opaque compaction
 * item）；keptMessageFingerprints 是压缩后保留消息的指纹序列，回放时用来
 * 验证当前上下文分支与压缩时刻一致。
 */
export interface CodexCheckpointDetails {
  readonly kind: typeof CHECKPOINT_KIND;
  readonly version: typeof CHECKPOINT_VERSION;
  readonly checkpointId: string;
  readonly provider: string;
  readonly api: string;
  readonly profile: ResponsesCompactionProfile;
  readonly modelId: string;
  readonly protocol: CodexProtocol;
  readonly replacementHistory: readonly JsonObject[];
  readonly keptMessageFingerprints: readonly string[];
  readonly createdAt: string;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]),
  );
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** 消息指纹（键序无关的稳定序列化后 sha256）：kept 区间与回放校验的最小单位 */
export function fingerprintMessage(message: CodexAgentMessage): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(message)))
    .digest("hex");
}

/**
 * checkpoint marker：投影成功后出现在请求视图里的占位消息文本。文本本身
 * 指示模型「注入失败也不要自行补历史」——before_provider_request 把它替换成
 * replacement history 之前，模型看到的最后防线。
 */
export function checkpointMarker(checkpointId: string): string {
  return [
    `[PI_TOOLKIT_CODEX_CHECKPOINT:${checkpointId}]`,
    "Opaque checkpoint injection failed. Do not infer missing history; tell the user to re-enable",
    "pi-toolkit context compression for the same model through a compatible Responses provider.",
  ].join(" ");
}

/** compaction 结果的 summary（Pi 保存进 compaction entry 的明文文案） */
export function fallbackSummary(checkpointId: string): string {
  return [
    `Responses compaction checkpoint ${checkpointId} stores the older history opaquely.`,
    "Full replay requires pi-toolkit context compression with the same model through a compatible Responses provider.",
    "Without them, only Pi's retained recent messages remain available.",
  ].join(" ");
}

function markerMessage(checkpointId: string, timestamp: number): CodexAgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text: checkpointMarker(checkpointId) }],
    timestamp,
  };
}

/**
 * 解析并严格校验 checkpoint details（v1）：
 * 身份字段（provider / api / profile / modelId / protocol）与 API↔profile
 * 一致性、replacement history 形状与预算、指纹形状、总字节数全部通过才返回
 * 结构化结果；任何一项不符返回 undefined——调用方按「有 opaque 声明但不可
 * 解析」处理（hasActiveCheckpointClaim 仍为真，不得当普通明文 summary 二次压缩）。
 */
export function parseCheckpointDetails(value: unknown): CodexCheckpointDetails | undefined {
  if (!isObject(value)) return undefined;
  try {
    if (serializedBytes(value) > MAX_CHECKPOINT_DETAILS_BYTES) return undefined;
  } catch {
    return undefined;
  }
  const profile =
    value.profile === "codex-responses-v1" || value.profile === "openai-responses-v1"
      ? value.profile
      : undefined;
  const protocol: CodexProtocol | undefined =
    value.protocol === "remote-v2" || value.protocol === "responses-compact" || value.protocol === "context-management"
      ? value.protocol
      : undefined;
  if (
    value.kind !== CHECKPOINT_KIND ||
    value.version !== CHECKPOINT_VERSION ||
    profile === undefined ||
    protocol === undefined ||
    typeof value.checkpointId !== "string" ||
    value.checkpointId.length < 8 ||
    value.checkpointId.length > MAX_CHECKPOINT_ID_LENGTH ||
    typeof value.provider !== "string" ||
    value.provider.length === 0 ||
    value.provider.length > MAX_PROVIDER_ID_LENGTH ||
    typeof value.api !== "string" ||
    value.api.length === 0 ||
    value.api.length > MAX_API_ID_LENGTH ||
    !profileMatchesApi(value.api, profile) ||
    typeof value.modelId !== "string" ||
    value.modelId.length === 0 ||
    value.modelId.length > MAX_MODEL_ID_LENGTH ||
    !Array.isArray(value.replacementHistory) ||
    !Array.isArray(value.keptMessageFingerprints) ||
    value.keptMessageFingerprints.length > MAX_KEPT_FINGERPRINTS ||
    typeof value.createdAt !== "string" ||
    value.createdAt.length > 64
  ) {
    return undefined;
  }
  if (
    value.replacementHistory.length === 0 ||
    !value.replacementHistory.every(isObject) ||
    !value.keptMessageFingerprints.every(
      (fingerprint) => typeof fingerprint === "string" && /^[a-f0-9]{64}$/.test(fingerprint),
    ) ||
    serializedBytes(value.replacementHistory) > REPLACEMENT_BYTE_BUDGET
  ) {
    return undefined;
  }
  try {
    if (protocol === "context-management") {
      // 工单 04 的旧 details 可能以普通对象数组保存。只对新 checkpoint-first
      // 布局收紧完整校验，旧布局继续走兼容解析，避免历史日志无法读取。
      const first = value.replacementHistory[0];
      if (isObject(first) && first.type === "compaction") {
        validateContextManagementHistory(value.replacementHistory);
      }
    } else {
      validateCompactionItem(value.replacementHistory.at(-1));
    }
  } catch {
    return undefined;
  }
  return {
    kind: CHECKPOINT_KIND,
    version: CHECKPOINT_VERSION,
    checkpointId: value.checkpointId,
    provider: value.provider,
    api: value.api,
    profile,
    modelId: value.modelId,
    protocol,
    replacementHistory: structuredClone(value.replacementHistory),
    keptMessageFingerprints: [...value.keptMessageFingerprints],
    createdAt: value.createdAt,
  };
}

function newestCompaction(entries: readonly SessionEntry[]): CompactionEntry | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type === "compaction") return entry;
  }
  return undefined;
}

/**
 * 最新 compaction 是否声明了本仓 checkpoint（即使解析失败）：声明过的
 * opaque 历史不能被误当普通明文 summary 二次压缩（上游同款保护）。
 */
export function hasActiveCheckpointClaim(entries: readonly SessionEntry[]): boolean {
  const entry = newestCompaction(entries);
  return !!entry && isObject(entry.details) && entry.details.kind === CHECKPOINT_KIND;
}

/**
 * 上游外部压缩扩展 checkpoint details 的 kind 标识集合：
 * - `pi-codex-remote-compaction`：@narumitw/pi-codex-compact（本仓 Codex 实现的研究上游）；
 * - `pi-codex-compaction`：@criogaid/pi-codex-compaction（用户真实环境在用的外部压缩
 *   扩展，工单 14 排查确认其存量 checkpoint 以该 kind 落在真实会话日志里）。
 * 工单 12 的隔离验收口径：外部扩展的存量 checkpoint 不迁移、不回放也不覆盖
 * （真停用与迁移归工单 14），但必须在压缩边界被「检测与诊断」——否则内置模块
 * 会在外部扩展的 opaque 坐标上静默二次压缩，形成两套压缩系统并行生效。
 */
export const FOREIGN_CHECKPOINT_KINDS: readonly string[] = [
  "pi-codex-remote-compaction",
  "pi-codex-compaction",
];

/**
 * 最新 compaction 是否携带外部压缩扩展的 checkpoint 声明（上游 kind 集合）。
 * 与本仓声明互斥（一个 entry 只有一个 kind）；返回真只代表「外部扩展的
 * opaque 状态在场」，不尝试解释其内容。
 */
export function hasForeignCheckpointClaim(entries: readonly SessionEntry[]): boolean {
  const entry = newestCompaction(entries);
  return (
    !!entry &&
    isObject(entry.details) &&
    typeof entry.details.kind === "string" &&
    FOREIGN_CHECKPOINT_KINDS.includes(entry.details.kind)
  );
}

/**
 * 外部 checkpoint 声明的尽力身份描述（诊断用）：上游 details 的 provider /
 * modelId 字段是字符串时给出 `provider/model`，否则给出不可解析占位。
 * 不做严格校验——外部格式的解释权在它的写入方。
 */
export function foreignCheckpointIdentity(entries: readonly SessionEntry[]): string {
  const entry = newestCompaction(entries);
  if (!entry || !isObject(entry.details)) return "unknown";
  const details = entry.details as { provider?: unknown; modelId?: unknown };
  if (typeof details.provider === "string" && typeof details.modelId === "string") {
    return `${details.provider}/${details.modelId}`;
  }
  return "unknown";
}

/** 最新可解析的 checkpoint（entry + details 视图）；无声明或不可解析返回 undefined */
export function latestCheckpoint(entries: readonly SessionEntry[]): {
  readonly entry: CompactionEntry<CodexCheckpointDetails>;
  readonly details: CodexCheckpointDetails;
} | undefined {
  const entry = newestCompaction(entries);
  if (!entry) return undefined;
  const details = parseCheckpointDetails(entry.details);
  return details ? { entry: entry as CompactionEntry<CodexCheckpointDetails>, details } : undefined;
}

/**
 * checkpoint 身份校验（规格场景 18 / 工单验收「至少校验 provider、model、
 * profile、protocol」）：返回不一致的字段清单（空数组 = 兼容）。上下文分支
 * 的校验不在这里——指纹前缀校验（projectSessionCheckpointContext）承担。
 */
export function codexCheckpointIdentity(
  details: CodexCheckpointDetails,
  expected: {
    readonly provider: string;
    readonly modelId: string;
    readonly api: string;
    readonly profile: ResponsesCompactionProfile;
    readonly protocol: CodexProtocol;
  },
): readonly string[] {
  const mismatched: string[] = [];
  if (details.provider !== expected.provider) mismatched.push("provider");
  if (details.modelId !== expected.modelId) mismatched.push("model");
  if (details.profile !== expected.profile) mismatched.push("profile");
  if (details.protocol !== expected.protocol) mismatched.push("protocol");
  if (details.api !== expected.api) mismatched.push("api");
  return mismatched;
}

function isOlderCompactionSummary(message: CodexAgentMessage, timestamp: number): boolean {
  return (
    message.role === "compactionSummary" &&
    Number.isFinite(message.timestamp) &&
    Number.isFinite(timestamp) &&
    message.timestamp < timestamp
  );
}

/**
 * 消息级投影：在当前请求视图里找到 checkpoint 的 compactionSummary 消息，
 * 校验其后保留消息的指纹序列与 details 一致（更早的 compactionSummary 允许
 * 跳过——新 checkpoint 抑制旧摘要），然后把「summary + 保留区间」整体替换为
 * 一条 marker 消息。找不到 summary、指纹不符或区间越界都返回 undefined。
 */
export function projectCheckpointContext(
  messages: readonly CodexAgentMessage[],
  details: CodexCheckpointDetails,
  checkpointSummary: string,
): CodexAgentMessage[] | undefined {
  const summaryIndex = messages.findIndex(
    (message) => message.role === "compactionSummary" && message.summary === checkpointSummary,
  );
  if (summaryIndex < 0) return undefined;
  const timestamp = messages[summaryIndex].timestamp;
  let messageIndex = summaryIndex + 1;
  let fingerprintIndex = 0;
  while (fingerprintIndex < details.keptMessageFingerprints.length) {
    if (messageIndex >= messages.length) return undefined;
    const message = messages[messageIndex];
    if (fingerprintMessage(message) === details.keptMessageFingerprints[fingerprintIndex]) {
      messageIndex += 1;
      fingerprintIndex += 1;
      continue;
    }
    if (isOlderCompactionSummary(message, timestamp)) {
      messageIndex += 1;
      continue;
    }
    return undefined;
  }
  while (messageIndex < messages.length && isOlderCompactionSummary(messages[messageIndex], timestamp)) {
    messageIndex += 1;
  }
  return [
    ...messages.slice(0, summaryIndex),
    markerMessage(details.checkpointId, timestamp),
    ...messages.slice(messageIndex),
  ];
}

function rawText(item: JsonObject): string {
  if (!Array.isArray(item.content)) return "";
  return item.content
    .flatMap((part) =>
      isObject(part) && typeof part.text === "string" && part.type === "input_text" ? [part.text] : [],
    )
    .join("\n");
}

function hasMedia(item: JsonObject): boolean {
  return Array.isArray(item.content) && item.content.some((part) => isObject(part) && part.type === "input_image");
}

function truncateTextItem(item: JsonObject, maxChars: number): JsonObject | undefined {
  if (!Array.isArray(item.content) || maxChars <= 32) return undefined;
  let remaining = maxChars - 16;
  const content = [...item.content].reverse().flatMap((part) => {
    if (!isObject(part) || part.type !== "input_text" || typeof part.text !== "string" || remaining <= 0) {
      return [];
    }
    const text = part.text.slice(-remaining);
    remaining -= text.length;
    return [{ ...part, text: `[truncated]\n${text}` }];
  });
  if (content.length === 0) return undefined;
  return { ...item, content: content.reverse() };
}

/**
 * 构造 replacement history：opaque compaction item 之前保留尽可能新的用户
 * 消息（token / 字节预算内，超预算的纯文本截断、超预算的媒体丢弃），末端
 * 必须是恰好一个 opaque item。上游同款算法（含预算扣减次序）。
 */
export function buildReplacementHistory(
  input: readonly unknown[],
  compactionItem: JsonObject,
  options: { tokenBudget?: number; byteBudget?: number } = {},
): JsonObject[] {
  const tokenBudget = options.tokenBudget ?? REPLACEMENT_TOKEN_BUDGET;
  const byteBudget = options.byteBudget ?? REPLACEMENT_BYTE_BUDGET;
  const opaque = validateCompactionItem(compactionItem);
  let remainingBytes = byteBudget - serializedBytes(opaque);
  let remainingChars = tokenBudget * 4;
  if (remainingBytes <= 0) throw new Error("Opaque compaction item exceeds replacement history budget");
  const retainedNewestFirst: JsonObject[] = [];
  const candidates = input.filter(
    (item): item is JsonObject => isObject(item) && item.role === "user" && item.type !== "compaction_trigger",
  );
  for (let index = candidates.length - 1; index >= 0; index--) {
    const candidate = candidates[index];
    const bytes = serializedBytes(candidate);
    if (hasMedia(candidate) && bytes > MAX_MEDIA_ITEM_BYTES) continue;
    const text = rawText(candidate);
    let retained = candidate;
    if (text.length > remainingChars) {
      if (hasMedia(candidate)) continue;
      const truncated = truncateTextItem(candidate, remainingChars);
      if (!truncated) continue;
      retained = truncated;
    }
    if (serializedBytes(retained) > remainingBytes) {
      if (hasMedia(retained)) continue;
      const maxCharsByBytes = Math.max(0, remainingBytes - 128);
      const truncated = truncateTextItem(retained, Math.min(remainingChars, maxCharsByBytes));
      if (!truncated || serializedBytes(truncated) > remainingBytes) continue;
      retained = truncated;
    }
    retainedNewestFirst.push(structuredClone(retained));
    remainingBytes -= serializedBytes(retained);
    remainingChars -= Math.min(remainingChars, rawText(retained).length);
    if (remainingBytes <= 128 || remainingChars <= 32) break;
  }
  return [...retainedNewestFirst.reverse(), opaque];
}

/**
 * 创建 checkpoint details（创建即校验：round-trip parseCheckpointDetails 不
 * 通过直接抛错——身份字段 / profile 一致性 / 历史形状由同一份校验兜底）。
 */
export function createCheckpointDetails(input: {
  provider: string;
  api: string;
  profile: ResponsesCompactionProfile;
  modelId: string;
  protocol: CodexProtocol;
  replacementHistory: readonly JsonObject[];
  keptMessages: readonly CodexAgentMessage[];
  checkpointId?: string;
  createdAt?: string;
}): CodexCheckpointDetails {
  const details: CodexCheckpointDetails = {
    kind: CHECKPOINT_KIND,
    version: CHECKPOINT_VERSION,
    checkpointId: input.checkpointId ?? randomUUID(),
    provider: input.provider,
    api: input.api,
    profile: input.profile,
    modelId: input.modelId,
    protocol: input.protocol,
    replacementHistory: structuredClone(input.replacementHistory),
    keptMessageFingerprints: input.keptMessages.map(fingerprintMessage),
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  const parsed = parseCheckpointDetails(details);
  if (!parsed) throw new Error("Created an invalid Codex checkpoint");
  return parsed;
}
