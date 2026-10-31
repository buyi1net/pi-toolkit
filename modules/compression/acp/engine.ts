import {
  collectBlockContent,
  createCore,
  createInitialState,
  defaultCountTokens,
  markBlockRestoredInline,
  parseBlockIdArg,
  parseCompressArgs,
  rebuildCompressionState,
  renderNudgeText,
  type CompressionCore,
  type CompressionState,
  type CoreMessage,
} from "acp-kernel";
import type {
  ContextEvent,
  ExtensionContext,
  ProjectedSessionEntry,
  SessionEntry,
  SessionMessageEntry,
  SessionProjection,
} from "@earendil-works/pi-coding-agent";

type AgentMessage = SessionMessageEntry["message"];
import type { Translator } from "../../../i18n/index.ts";
import type { AcpAdvancedSettings } from "../api.ts";
import {
  resolveAcpRuntimeConfig,
  acpConfigFingerprint,
  judgeAcpConfigGeneration,
  type AcpResolvedRuntime,
} from "./config.ts";
import {
  acpCoreOutToAgentMessages,
  acpDropCompressReasoning,
  acpExtraEntriesToCoreMessages,
  acpOriginalsOf,
  acpProjectedEntriesToCoreMessages,
  acpStripHistoricalImages,
  ACP_DEFAULT_STRIP_KEEP_RECENT,
} from "./projection.ts";
import {
  ACP_DEFAULT_PROTECTION,
  resolveAcpKernelConfig,
  type AcpProtectionPolicy,
} from "./protection.ts";
import {
  acpAutoRestoreFilePath,
  acpCanonicalTarget,
  acpFetchMissingEntries,
  acpFindMessageByRef,
  acpFindVisibleInlineRestore,
  acpHeadPreview,
  acpMessageFitsInline,
  acpResolveRestoreFilePath,
  acpWriteRestoreFile,
} from "./restore.ts";
import { acpFormatSearchResults, acpRunSearch } from "./search.ts";
import { AcpSidecarStore, acpSidecarExists } from "./sidecar.ts";
import { isAcpToolUnavailableDetails } from "./tool-guard.ts";

export type AcpDiagnostics = (
  key: string,
  level: "info" | "warning" | "error",
  message: string,
  ctx: ExtensionContext,
) => void;

export type AcpRecoveryEvent =
  | { readonly kind: "recovering" }
  | { readonly kind: "recovered" }
  | { readonly kind: "failed"; readonly reason: "newer-schema" | "rebuild-failed" };

interface AcpSessionSlot {
  state?: CompressionState;
  failure?: { kind: "newer-schema" | "rebuild-failed"; detail?: string };
  nudgeTurnKey?: string;

  persistedSignature?: string;
}

export interface AcpCompressArgs {
  content: unknown;
  topic?: unknown;
  summaryMaxChars?: unknown;
}

export interface AcpCompressOutcome {
  readonly text: string;
  readonly blocksCreated: number;
  readonly tokensCompressed: number;

  readonly persisted: boolean;
}

export interface AcpDecompressArgs {
  blockId: unknown;
  full?: unknown;
  toFile?: unknown;
  inline?: unknown;
}

export interface AcpDecompressOutcome {
  readonly text: string;
  readonly mode: "block-inline" | "block-file" | "message-inline" | "message-file" | "notice";

  readonly blockId?: string;
}

export interface AcpSearchArgs {
  query: unknown;
  limit?: unknown;
}

export interface AcpSearchOutcome {
  readonly text: string;
  readonly matches: number;
  readonly blockCount: number;
  readonly messageCount: number;
}

type SessionEntrySource = {
  getEntries?: () => SessionEntry[];
};

function acpReadAllEntries(ctx: ExtensionContext): SessionEntry[] {
  const source = ctx.sessionManager as unknown as SessionEntrySource;
  if (typeof source.getEntries === "function") return source.getEntries();
  return [];
}

type HostProjectionSource = {
  buildSessionProjection?: () => SessionProjection;
};

class AcpHostProjectionUnsupportedError extends Error {
  constructor() {
    super("host sessionManager has no buildSessionProjection() (Pi >= 1.3.0 required)");
    this.name = "AcpHostProjectionUnsupportedError";
  }
}

export function acpHostSupported(ctx: ExtensionContext): boolean {
  const source = ctx.sessionManager as unknown as HostProjectionSource;
  return typeof source.buildSessionProjection === "function";
}

function acpReadHostProjection(ctx: ExtensionContext): SessionProjection {
  const source = ctx.sessionManager as unknown as HostProjectionSource;
  const build = source.buildSessionProjection;
  if (typeof build !== "function") throw new AcpHostProjectionUnsupportedError();
  return build.call(source);
}

function acpSidecarLogMismatch(state: CompressionState, entries: readonly SessionEntry[]): number {
  if (state.blocks.length === 0) return 0;
  const known = new Set(entries.map((entry) => entry.id));
  let missing = 0;
  for (const block of state.blocks) {
    for (const id of block.directMessageIds) {
      const base = id.split("#")[0]!.replace(/@\d+$/, "");
      if (!known.has(base)) missing += 1;
    }
  }
  return missing;
}

export function acpHasCompressHistory(projected: readonly ProjectedSessionEntry[]): boolean {
  for (const slot of projected) {
    for (const message of slot.messages as {
      role?: string;
      toolName?: string;
      isError?: boolean;
      details?: unknown;
    }[]) {
      if (
        message?.role === "toolResult" &&
        message.toolName === "compress" &&
        message.isError !== true &&
        !isAcpToolUnavailableDetails(message.details)
      ) {
        return true;
      }
    }
  }
  return false;
}

function sessionRefOf(ctx: ExtensionContext): { sessionId: string; sessionFile?: string } {
  const sm = ctx.sessionManager;
  return { sessionId: sm.getSessionId(), sessionFile: sm.getSessionFile() ?? undefined };
}

function acpRuntimeFor(
  ctx: ExtensionContext,
  readAcpSettings: (() => AcpAdvancedSettings) | undefined,
  protection: AcpProtectionPolicy,
  report: AcpDiagnostics,
  escalationSeen: Set<string>,
  t: Translator,
): AcpResolvedRuntime {
  const model = ctx.model as { provider?: string; id?: string; contextWindow?: number } | undefined;
  const resolved = resolveAcpRuntimeConfig(
    {
      provider: model?.provider,
      modelId: model?.id,
      contextWindow: model?.contextWindow,
    },
    readAcpSettings?.() ?? { global: {}, providers: {} },
    protection,
  );
  if (resolved.escalation) {
    const { sessionFile, sessionId } = sessionRefOf(ctx);
    const key = sessionFile ?? `session:${sessionId}`;
    if (!escalationSeen.has(key)) {
      escalationSeen.add(key);
      report(
        "acp-config-escalation",
        "warning",
        t("module.compression.acpSettings.escalation", {
          max: formatPercent(resolved.escalation.max),
          emergency: formatPercent(resolved.escalation.emergency),
        }),
        ctx,
      );
    }
  }
  return resolved;
}

function formatPercent(ratio: number): string {
  return `${Number((ratio * 100).toPrecision(6))}%`;
}

function stateSignature(state: CompressionState): string {
  return JSON.stringify(state);
}

function estimateTokensOf(messages: readonly CoreMessage[]): number {
  let total = 0;
  for (const message of messages) total += defaultCountTokens(message.text ?? "");
  return total;
}

function lastUserEntryId(projected: readonly ProjectedSessionEntry[]): string {
  for (let i = projected.length - 1; i >= 0; i--) {
    const slot = projected[i]!;
    if ((slot.messages as readonly { role?: string }[]).some((m) => m?.role === "user")) {
      return slot.sourceEntry.id;
    }
  }
  return "none";
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface AcpEngineOptions {
  readonly t: Translator;
  readonly diagnostics: AcpDiagnostics;

  readonly protection?: AcpProtectionPolicy;

  readonly readAcpSettings?: () => AcpAdvancedSettings;

  readonly recoveryEvents?: (event: AcpRecoveryEvent, ctx: ExtensionContext) => void;
}

export interface AcpCompressionEngine {

  beginSession(ctx: ExtensionContext): Promise<void>;

  endSession(ctx: ExtensionContext): Promise<void>;

  handleContext(event: ContextEvent, ctx: ExtensionContext, active: boolean): Promise<{ messages: AgentMessage[] } | undefined>;

  executeCompress(args: AcpCompressArgs, ctx: ExtensionContext, toolCallId?: string): Promise<AcpCompressOutcome>;

  executeDecompress(args: AcpDecompressArgs, ctx: ExtensionContext, toolCallId?: string): Promise<AcpDecompressOutcome>;

  executeSearch(args: AcpSearchArgs, ctx: ExtensionContext): Promise<AcpSearchOutcome>;

  currentState(ctx: ExtensionContext): CompressionState | undefined;

  readonly store: AcpSidecarStore;
}

export function createAcpEngine(options: AcpEngineOptions): AcpCompressionEngine {
  const core: CompressionCore = createCore({ countTokens: defaultCountTokens });
  const store = new AcpSidecarStore();
  const slots = new Map<string, AcpSessionSlot>();
  const locks = new Map<string, Promise<void>>();
  const t = options.t;
  const diagnostics = options.diagnostics;
  const protection = options.protection ?? ACP_DEFAULT_PROTECTION;
  const escalationSeen = new Set<string>();
  const runtimeFor = (ctx: ExtensionContext): AcpResolvedRuntime =>
    acpRuntimeFor(ctx, options.readAcpSettings, protection, diagnostics, escalationSeen, t);

  function emitRecovery(event: AcpRecoveryEvent, ctx: ExtensionContext): void {
    try {
      options.recoveryEvents?.(event, ctx);
    } catch {
      // 展示接缝异常不击穿状态装载 / 重建
    }
  }

  function keyOf(ctx: ExtensionContext): string {
    const { sessionId, sessionFile } = sessionRefOf(ctx);
    return sessionFile ? `file:${sessionFile}` : `session:${sessionId}`;
  }

  async function acquireLock(key: string): Promise<() => void> {
    const prev = locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = () => {
        locks.delete(key);
        resolve();
      };
    });
    locks.set(key, prev.then(() => next));
    await prev;
    return release;
  }

  async function ensureSessionState(
    ctx: ExtensionContext,
    projectedSource: readonly ProjectedSessionEntry[] | (() => readonly ProjectedSessionEntry[]),
  ): Promise<AcpSessionSlot> {
    const key = keyOf(ctx);
    const { sessionId, sessionFile } = sessionRefOf(ctx);
    const existing = slots.get(key);
    if (existing) return existing;
    const slot: AcpSessionSlot = {};
    slots.set(key, slot);

    const loaded = await store.load(sessionFile, sessionId);
    if (loaded.status === "ok" && loaded.state) {

      let mismatch = 0;
      try {
        mismatch = acpSidecarLogMismatch(loaded.state, acpReadAllEntries(ctx));
      } catch {
        mismatch = 0;
      }
      if (mismatch === 0) {

        const generation = judgeAcpConfigGeneration(
          loaded.configFingerprint,
          acpConfigFingerprint(runtimeFor(ctx)),
        );
        if (generation.reason === "config-changed") {
          diagnostics(
            "sidecar-config-generation",
            "info",
            t("module.compression.acp.sidecarConfigGeneration"),
            ctx,
          );
        }
        slot.state = loaded.state;

        slot.persistedSignature = stateSignature(loaded.state);
        return slot;
      }

      diagnostics(
        "sidecar-mismatch",
        "warning",
        t("module.compression.acp.sidecarMismatch", { missing: String(mismatch) }),
        ctx,
      );
    } else if (loaded.status === "newer-schema") {
      slot.failure = { kind: "newer-schema", detail: `schema v${loaded.schemaVersion ?? "?"}` };

      emitRecovery({ kind: "recovering" }, ctx);
      emitRecovery({ kind: "failed", reason: "newer-schema" }, ctx);
      diagnostics(
        "sidecar-newer",
        "error",
        t("module.compression.acp.sidecarNewer", { version: String(loaded.schemaVersion) }),
        ctx,
      );
      return slot;
    }
    if (loaded.status === "corrupt") {
      diagnostics(
        "sidecar-corrupt",
        "warning",
        t("module.compression.acp.sidecarCorrupt", { error: loaded.error ?? "" }),
        ctx,
      );
    }

    let projected: readonly ProjectedSessionEntry[];
    try {
      projected = typeof projectedSource === "function" ? projectedSource() : projectedSource;
    } catch (error) {
      slots.delete(key);
      throw error;
    }
    if (acpHasCompressHistory(projected)) {

      emitRecovery({ kind: "recovering" }, ctx);
      try {
        const rebuilt = rebuildCompressionState(
          createInitialState(),
          acpProjectedEntriesToCoreMessages(projected),
          runtimeFor(ctx).kernel,
        );
        if (rebuilt.blocksRebuilt > 0) {
          slot.state = rebuilt.state;
          try {
            await store.save(rebuilt.state, sessionFile, sessionId, acpConfigFingerprint(runtimeFor(ctx)));
            slot.persistedSignature = stateSignature(rebuilt.state);
          } catch (error) {
            diagnostics(
              "sidecar-rebuild-save-failed",
              "error",
              t("module.compression.acp.saveFailed", { error: describeError(error) }),
              ctx,
            );
          }
          diagnostics(
            "sidecar-rebuilt",
            "info",
            t("module.compression.acp.sidecarRebuilt", { blocks: String(rebuilt.blocksRebuilt) }),
            ctx,
          );

          emitRecovery({ kind: "recovered" }, ctx);
          return slot;
        }
        if (loaded.status === "corrupt") {

          slot.failure = { kind: "rebuild-failed", detail: "history present but nothing replayable" };
          diagnostics(
            "sidecar-rebuild-failed",
            "error",
            t("module.compression.acp.sidecarRebuildFailed"),
            ctx,
          );
          emitRecovery({ kind: "failed", reason: "rebuild-failed" }, ctx);
          return slot;
        }
      } catch (error) {
        slot.failure = { kind: "rebuild-failed", detail: describeError(error) };
        diagnostics(
          "sidecar-rebuild-failed",
          "error",
          t("module.compression.acp.sidecarRebuildFailedWith", { error: describeError(error) }),
          ctx,
        );
        emitRecovery({ kind: "failed", reason: "rebuild-failed" }, ctx);
        return slot;
      }

      emitRecovery({ kind: "recovered" }, ctx);
    }

    slot.state = createInitialState();
    if (!sessionFile) store.bindInMemory(slot.state, sessionId);
    return slot;
  }

  async function persistState(state: CompressionState, ctx: ExtensionContext): Promise<boolean> {
    const { sessionId, sessionFile } = sessionRefOf(ctx);
    try {
      await store.save(state, sessionFile, sessionId, acpConfigFingerprint(runtimeFor(ctx)));
      const slot = slots.get(keyOf(ctx));
      if (slot) slot.persistedSignature = stateSignature(state);
      return true;
    } catch (error) {

      diagnostics(
        "sidecar-save-failed",
        "error",
        t("module.compression.acp.saveFailed", { error: describeError(error) }),
        ctx,
      );
      return false;
    }
  }

  function reportHostUnsupported(ctx: ExtensionContext): void {
    diagnostics(
      "host-projection-unsupported",
      "error",
      t("module.compression.acp.hostProjectionUnsupported"),
      ctx,
    );
  }

  function requireHostProjection(ctx: ExtensionContext): SessionProjection {
    try {
      return acpReadHostProjection(ctx);
    } catch (error) {
      if (error instanceof AcpHostProjectionUnsupportedError) {
        reportHostUnsupported(ctx);
        throw new Error(t("module.compression.acp.hostProjectionUnsupported"));
      }
      throw error;
    }
  }

  async function handleContext(
    event: ContextEvent,
    ctx: ExtensionContext,
    active: boolean,
  ): Promise<{ messages: AgentMessage[] } | undefined> {
    if (!active) return undefined;
    const key = keyOf(ctx);
    const release = await acquireLock(key);
    try {

      let projection: SessionProjection;
      try {
        projection = acpReadHostProjection(ctx);
      } catch (error) {
        if (error instanceof AcpHostProjectionUnsupportedError) {
          reportHostUnsupported(ctx);
          return undefined;
        }
        throw error;
      }
      const slot = await ensureSessionState(ctx, projection.entries);
      if (!slot.state) {

        diagnostics(
          "projection-unavailable",
          "error",
          t("module.compression.acp.projectionUnavailable"),
          ctx,
        );
        return undefined;
      }
      const coreMessages = acpProjectedEntriesToCoreMessages(projection.entries);
      const runtime = runtimeFor(ctx);
      const tokenCount = estimateTokensOf(coreMessages);
      const turn = core.processTurn({ messages: coreMessages, state: slot.state, config: runtime.kernel, tokenCount });
      slot.state = turn.state;
      await persistState(turn.state, ctx);

      let rebuilt = acpCoreOutToAgentMessages(turn.messages, acpOriginalsOf(projection.entries));

      rebuilt = acpDropCompressReasoning(rebuilt, runtime.merged.reasoning);
      if (runtime.merged.stripImages === true) {
        const keepRecent = runtime.merged.stripImagesKeepRecent;
        rebuilt = acpStripHistoricalImages(rebuilt, {
          enabled: true,
          keepRecent:
            typeof keepRecent === "number" && Number.isFinite(keepRecent) && keepRecent >= 0
              ? Math.floor(keepRecent)
              : ACP_DEFAULT_STRIP_KEEP_RECENT,
        }).messages;
      }

      if (turn.nudge?.shouldInject) {
        const turnKey = lastUserEntryId(projection.entries);
        const emergency = turn.nudge.breakdown?.emergencyOverride === 1;
        if (emergency || slot.nudgeTurnKey !== turnKey) {
          slot.nudgeTurnKey = turnKey;
          const rendered = renderNudgeText(turn.nudge, runtime.prompts);
          const top = [...turn.nudge.compressibleRanges].sort((a, b) => b.tokens - a.tokens)[0];
          const example = top
            ? `\n\nExample: compress({ content: [{ startId: "${top.startRef}", endId: "${top.endRef}", summary: "..." }] })`
            : "";
          rebuilt = [
            ...rebuilt,
            {
              role: "user",
              content: [{ type: "text", text: `${rendered.text}${example}` }],
              timestamp: Date.now(),
            } as AgentMessage,
          ];
        }
      }
      return { messages: rebuilt };
    } catch (error) {

      diagnostics(
        "projection-failed",
        "error",
        t("module.compression.acp.projectionFailed", { error: describeError(error) }),
        ctx,
      );
      return undefined;
    } finally {
      release();
    }
  }

  async function executeCompress(
    args: AcpCompressArgs,
    ctx: ExtensionContext,
    toolCallId?: string,
  ): Promise<AcpCompressOutcome> {
    const key = keyOf(ctx);
    const release = await acquireLock(key);
    try {

      const parsed = parseCompressArgs({
        content: args.content,
        ...(args.topic === undefined ? {} : { topic: args.topic }),
        ...(args.summaryMaxChars === undefined ? {} : { summaryMaxChars: args.summaryMaxChars }),
      });
      if (parsed.ranges.length === 0) {
        const detail =
          (parsed.diagnostics.invalidReasons?.length ?? 0) > 0
            ? parsed.diagnostics.invalidReasons!.join("; ")
            : parsed.diagnostics.kind;
        throw new Error(`compress arguments invalid: ${detail}`);
      }
      const topLevelTopic = typeof args.topic === "string" ? args.topic : undefined;
      const summaryMaxChars =
        typeof args.summaryMaxChars === "number" && Number.isFinite(args.summaryMaxChars) && args.summaryMaxChars > 0
          ? args.summaryMaxChars
          : undefined;

      const projection = requireHostProjection(ctx);
      const slot = await ensureSessionState(ctx, projection.entries);
      if (!slot.state) {
        throw new Error(t("module.compression.acp.stateUnavailable"));
      }
      const coreMessages = acpProjectedEntriesToCoreMessages(projection.entries);
      const config = runtimeFor(ctx).kernel;
      const tokenCount = estimateTokensOf(coreMessages);

      const turn = core.processTurn({ messages: coreMessages, state: slot.state, config, tokenCount });
      const beforeRunIds = new Map(turn.state.blocks.map((b) => [b.blockId, b.runId]));
      const applied = core.applyCompression({
        ranges: parsed.ranges.map((range) => ({
          startRef: range.startRef,
          endRef: range.endRef,
          summary: range.summary,
          ...(range.topic !== undefined || topLevelTopic !== undefined
            ? { topic: range.topic ?? topLevelTopic }
            : {}),
          ...(summaryMaxChars !== undefined ? { summaryMaxChars } : {}),
          ...(toolCallId !== undefined ? { compressCallId: toolCallId } : {}),
        })),
        messages: turn.messages,
        state: turn.state,
        config,
      });
      let persisted = false;
      if (applied.result.blocksCreated > 0) {
        slot.state = applied.state;
        persisted = await persistState(applied.state, ctx);
      }
      const changed = applied.state.blocks.filter((b) => beforeRunIds.get(b.blockId) !== b.runId);
      const text = formatCompressPanel(applied.result, changed, applied.state);
      return {
        text,
        blocksCreated: applied.result.blocksCreated,
        tokensCompressed: applied.result.tokensCompressed,

        persisted,
      };
    } finally {
      release();
    }
  }

  function refoldHint(blockId: string, restored: { restoredStartRef?: string; restoredEndRef?: string } | null): string {
    if (restored?.restoredStartRef && restored.restoredEndRef) {
      return `Re-fold: call compress({ content: [{ startId: "${restored.restoredStartRef}", endId: "${restored.restoredEndRef}", summary: "..." }] }) → updates block ${blockId} in place (same id, new summary).`;
    }
    return `Re-fold: call compress over the restored messages with a fresh summary → updates block ${blockId} in place (same id, new summary).`;
  }

  async function executeDecompress(
    args: AcpDecompressArgs,
    ctx: ExtensionContext,
    _toolCallId?: string,
  ): Promise<AcpDecompressOutcome> {
    const key = keyOf(ctx);
    const release = await acquireLock(key);
    try {
      const projection = requireHostProjection(ctx);
      const slot = await ensureSessionState(ctx, projection.entries);
      if (!slot.state) {
        throw new Error(t("module.compression.acp.stateUnavailable"));
      }
      const state = slot.state;
      const projected = projection.entries;
      const projectedCores = acpProjectedEntriesToCoreMessages(projected);
      const arg = typeof args.blockId === "string" ? args.blockId.trim() : "";
      const full = args.full === true;
      const wantInline = args.inline === true;
      const toFile = typeof args.toFile === "string" && args.toFile.trim().length > 0 ? args.toFile.trim() : undefined;

      const rawId = /^m\d+$/.test(arg) ? state.messageRefs.byRef[arg] : arg;
      const ownerBlock = rawId ? state.blocks.find((b) => b.effectiveMessageIds.includes(rawId)) : undefined;
      if (ownerBlock && rawId) {
        const found = acpFindMessageByRef(arg, state, projectedCores);
        if (!found || !found.text) {
          return {
            text: `Message ${arg} (in block ${ownerBlock.blockId}) has no restorable text content in the session log.`,
            mode: "notice",
            blockId: ownerBlock.blockId,
          };
        }
        const wantFile = toFile !== undefined || args.inline === false || !acpMessageFitsInline(found.text);
        if (!wantFile) {

          const visible = acpFindVisibleInlineRestore(arg, state, projected);
          if (visible) {
            return {
              text: `Message ${arg} (block ${ownerBlock.blockId}) was already restored inline earlier in this conversation (see the decompress result at entry ${visible.resultEntryId}); re-inserting would duplicate context. Use compress to re-fold it when done, or pass toFile to write a copy to disk.`,
              mode: "notice",
              blockId: ownerBlock.blockId,
            };
          }
          return {
            text: `Message ${arg} (${found.role}, block ${ownerBlock.blockId}, ${found.text.length} chars) restored inline:\n\n${found.text}`,
            mode: "message-inline",
            blockId: ownerBlock.blockId,
          };
        }
        const targetPath = toFile ? acpResolveRestoreFilePath(toFile) : acpAutoRestoreFilePath(`msg-${rawId}`);
        if (typeof targetPath === "object") return { text: targetPath.error, mode: "notice" };
        await acpWriteRestoreFile(targetPath, found.text);
        return {
          text: [
            `Message ${arg} (${found.role}, block ${ownerBlock.blockId}, ${found.text.length} chars) written to ${targetPath}.`,
            "Block stays compressed — context unchanged. Use the read tool to access the content.",
            "",
            "Preview:",
            acpHeadPreview(found.text),
          ].join("\n"),
          mode: "message-file",
          blockId: ownerBlock.blockId,
        };
      }

      const blockId = parseBlockIdArg(arg);
      if (!blockId) {
        return {
          text: `Invalid blockId: ${JSON.stringify(args.blockId)}. Expected a block id like "b5"/"5", or a message ref (e.g. "m00012") from search_context results.`,
          mode: "notice",
        };
      }
      const block = state.blocks.find((b) => b.blockId === blockId);
      if (!block) {
        const active = state.blocks.filter((b) => b.active).map((b) => b.blockId).join(", ");
        return {
          text: `Block ${blockId} not found. Active blocks: ${active || "(none)"}.`,
          mode: "notice",
        };
      }

      const baseIds = new Set(projected.map((slot) => slot.sourceEntry.id));
      const missing = [
        ...new Set(
          block.effectiveMessageIds.map((id) => id.split("#")[0]!.replace(/@\d+$/, "")),
        ),
      ].filter((id) => !baseIds.has(id));
      const extraEntries = missing.length > 0 ? acpFetchMissingEntries(missing, ctx) : [];
      const resolvedCoreMessages = [
        ...projectedCores,
        ...acpExtraEntriesToCoreMessages(extraEntries),
      ];
      const collected = collectBlockContent(state, block, resolvedCoreMessages, { full });
      if (collected.count === 0) {
        return {
          text: `Block ${blockId} has no restorable message content.`,
          mode: "notice",
          blockId,
        };
      }

      if (wantInline && toFile === undefined) {
        const visible = acpFindVisibleInlineRestore(blockId, state, projected);
        if (visible) {
          return {
            text: `Block ${blockId} was already restored inline earlier in this conversation (see the decompress result at entry ${visible.resultEntryId}); re-inserting would duplicate context. It stays compressed — re-fold it with compress and a fresh summary, or pass toFile to write a copy to disk.`,
            mode: "notice",
            blockId,
          };
        }
        const marked = markBlockRestoredInline(state, blockId);
        slot.state = marked.state;
        await persistState(marked.state, ctx);
        return {
          text: `Restored block ${blockId} (${collected.count} item${collected.count === 1 ? "" : "s"}, ${block.startRef ?? "?"}–${block.endRef ?? "?"}) inline:\n\n${collected.text}\n\n${refoldHint(blockId, marked.result)}`,
          mode: "block-inline",
          blockId,
        };
      }

      const targetPath = toFile ? acpResolveRestoreFilePath(toFile) : acpAutoRestoreFilePath(blockId);
      if (typeof targetPath === "object") return { text: targetPath.error, mode: "notice", blockId };
      await acpWriteRestoreFile(targetPath, collected.text);
      const itemWord = collected.count === 1 ? "item" : "items";
      return {
        text: [
          `Block ${blockId} (${collected.count} ${itemWord}, ${collected.text.length} chars) written to ${targetPath}.`,
          "Block stays compressed — context unchanged. Use the read tool to access the content.",
          "",
          "Preview:",
          acpHeadPreview(collected.text),
        ].join("\n"),
        mode: "block-file",
        blockId,
      };
    } finally {
      release();
    }
  }

  async function executeSearch(args: AcpSearchArgs, ctx: ExtensionContext): Promise<AcpSearchOutcome> {
    const key = keyOf(ctx);
    const release = await acquireLock(key);
    try {
      let projection: SessionProjection;
      try {
        projection = acpReadHostProjection(ctx);
      } catch (error) {
        if (error instanceof AcpHostProjectionUnsupportedError) {

          reportHostUnsupported(ctx);
          return {
            text: "search_context is unavailable: this host does not provide buildSessionProjection() (Pi 1.3.0+ required).",
            matches: 0,
            blockCount: 0,
            messageCount: 0,
          };
        }
        throw error;
      }
      const slot = await ensureSessionState(ctx, projection.entries);
      const query = typeof args.query === "string" ? args.query : "";
      const limit =
        typeof args.limit === "number" && Number.isFinite(args.limit) && args.limit > 0
          ? Math.floor(args.limit)
          : undefined;
      if (!slot.state) {

        return {
          text: `search_context is unavailable: ACP state could not be loaded for this session (see the compression diagnosis).`,
          matches: 0,
          blockCount: 0,
          messageCount: 0,
        };
      }
      const report = acpRunSearch(slot.state, projection.entries, query, limit);
      return {
        text: acpFormatSearchResults(report, query, slot.state),
        matches: report.results.length,
        blockCount: report.blockCount,
        messageCount: report.messageCount,
      };
    } finally {
      release();
    }
  }

  function formatCompressPanel(
    result: { blocksCreated: number; tokensCompressed: number; errors: string[]; warnings: string[] },
    changedBlocks: CompressionState["blocks"],
    state: CompressionState,
  ): string {
    const lines: string[] = [
      `▣ ACP | ${result.tokensCompressed} tokens compressed, ${result.blocksCreated} block(s) created`,
    ];
    for (const block of changedBlocks) {
      const refOf = (id: string) => state.messageRefs.byRaw[id];
      const direct = block.directMessageIds.map(refOf).filter(Boolean);
      const start = block.startRef ?? direct[0] ?? "?";
      const end = block.endRef ?? direct[direct.length - 1] ?? "?";
      const tier = block.tier >= 2 ? ` (T${block.tier})` : "";
      const topic = block.topic ? ` [${block.topic}]` : "";
      lines.push(`· ${block.blockId}${tier}${topic} = ${start}–${end} · ${block.summary.length} chars summary`);
    }
    for (const warning of result.warnings) lines.push(`⚠️ ${warning}`);
    if (result.blocksCreated === 0 && result.errors.length > 0) {
      lines.push("Nothing compressed:");
      for (const error of result.errors) lines.push(`- ${error}`);
    }
    return lines.join("\n");
  }

  return {
    beginSession: async (ctx: ExtensionContext) => {
      const release = await acquireLock(keyOf(ctx));
      try {

        try {
          await ensureSessionState(ctx, () => acpReadHostProjection(ctx).entries);
        } catch (error) {
          if (error instanceof AcpHostProjectionUnsupportedError) {
            reportHostUnsupported(ctx);
            return;
          }
          diagnostics(
            "projection-failed",
            "error",
            t("module.compression.acp.projectionFailed", { error: describeError(error) }),
            ctx,
          );
          return;
        }
      } finally {
        release();
      }
    },
    async endSession(ctx: ExtensionContext): Promise<void> {
      const { sessionId, sessionFile } = sessionRefOf(ctx);
      const key = keyOf(ctx);
      const slot = slots.get(key);
      const state = slot?.state;
      try {

        if (state && slot && state.blocks.length > 0) {
          const onDisk =
            slot.persistedSignature === stateSignature(state) && (await acpSidecarExists(sessionFile));
          if (!onDisk) await persistState(state, ctx);
        }
      } finally {
        slots.delete(key);
        store.release(sessionFile, sessionId);
      }
    },
    handleContext,
    executeCompress,
    executeDecompress,
    executeSearch,
    currentState(ctx: ExtensionContext): CompressionState | undefined {
      return slots.get(keyOf(ctx))?.state;
    },
    store,
  };
}
