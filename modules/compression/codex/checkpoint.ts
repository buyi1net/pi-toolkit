import { createHash, randomUUID } from "node:crypto";
import type { CompactionEntry, ContextEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { CodexProtocol } from "../api.ts";
import { validateContextManagementHistory } from "./context-management.ts";
import { profileMatchesApi, type ResponsesCompactionProfile } from "./profiles.ts";
import { type JsonObject, validateCompactionItem } from "./protocol.ts";

export type CodexAgentMessage = ContextEvent["messages"][number];

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

export function fingerprintMessage(message: CodexAgentMessage): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(message)))
    .digest("hex");
}

export function checkpointMarker(checkpointId: string): string {
  return [
    `[PI_TOOLKIT_CODEX_CHECKPOINT:${checkpointId}]`,
    "Opaque checkpoint injection failed. Do not infer missing history; tell the user to re-enable",
    "pi-toolkit context compression for the same model through a compatible Responses provider.",
  ].join(" ");
}

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

export function hasActiveCheckpointClaim(entries: readonly SessionEntry[]): boolean {
  const entry = newestCompaction(entries);
  return !!entry && isObject(entry.details) && entry.details.kind === CHECKPOINT_KIND;
}

export const FOREIGN_CHECKPOINT_KINDS: readonly string[] = [
  "pi-codex-remote-compaction",
  "pi-codex-compaction",
];

export function hasForeignCheckpointClaim(entries: readonly SessionEntry[]): boolean {
  const entry = newestCompaction(entries);
  return (
    !!entry &&
    isObject(entry.details) &&
    typeof entry.details.kind === "string" &&
    FOREIGN_CHECKPOINT_KINDS.includes(entry.details.kind)
  );
}

export function foreignCheckpointIdentity(entries: readonly SessionEntry[]): string {
  const entry = newestCompaction(entries);
  if (!entry || !isObject(entry.details)) return "unknown";
  const details = entry.details as { provider?: unknown; modelId?: unknown };
  if (typeof details.provider === "string" && typeof details.modelId === "string") {
    return `${details.provider}/${details.modelId}`;
  }
  return "unknown";
}

export function latestCheckpoint(entries: readonly SessionEntry[]): {
  readonly entry: CompactionEntry<CodexCheckpointDetails>;
  readonly details: CodexCheckpointDetails;
} | undefined {
  const entry = newestCompaction(entries);
  if (!entry) return undefined;
  const details = parseCheckpointDetails(entry.details);
  return details ? { entry: entry as CompactionEntry<CodexCheckpointDetails>, details } : undefined;
}

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
