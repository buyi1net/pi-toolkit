// ACP 压缩引擎（工单 08 最小闭环 + 工单 09 解压/搜索/恢复）：压缩块、引用、
// 上下文投影、sidecar 状态、解压与搜索执行。
//
// 移植自 billion-context-pi 的 src/runtime.ts + index.ts 的 context 变换 +
// src/compress-tool.ts / decompress-tool.ts / search-tool.ts 的执行核心
// （MIT，见模块 UPSTREAM.md），按工单边界裁剪：
// - 压缩执行：模型经 compress 工具提交范围+摘要 → 内核 applyCompression 建
//   压缩块（块保存 + 引用登记）→ sidecar 原子落盘；
// - 上下文投影：context 事件里对会话 entry 跑内核 processTurn（分配引用、打
//   标签、按活动块剪枝），重建 Pi AgentMessage 视图后交回宿主；重建后、nudge
//   注入前应用请求视图变换（评审修复 F1）：reasoning 处理丢弃已闭环 compress
//   调用里超限的历史 thinking、stripImages 剥离历史图片（只改请求视图，不动
//   会话日志；内核正文改写——紧急截断——由投影层按内核正文重建）；
// - 最小 nudge：内核判定需要压缩时，向请求视图追加一条一次性提醒（紧急档
//   每次请求都注入）；增长步长/频率调优归工单 10；
// - 解压/搜索（工单 09）：decompress 把块或单条消息的原文找回（内联进视图
//   或落文件，重复插入被拒绝；内联恢复经 markBlockRestoredInline 支持 K2
//   原地重折叠），search_context 按关键词定位块与被折叠消息；
// - 保护策略（工单 09）：内核 Config 的保护字段经 AcpProtectionPolicy 注入
//   （模块内默认值，工单 10 的配置级联接缝）；
// - sidecar 生命周期：beginSession 读盘（缺失/损坏/与日志不一致走会话日志
//   重建，见 ensureSessionState），endSession 先把内存槽原子落盘再释放运行态
//   （工单 06：会话结束时的状态不靠「每次变更都写过盘」的巧合，任何模式下都落盘）；
// - 失败语义：投影或落盘失败进 error 诊断，绝不静默回退 Pi 原生压缩（压缩
//   坐标系唯一性归 owner/scheduler 层保证）。
//
// 未移植（按需再议）：溢出自愈、k̂ 标定、压缩失败重试熔断、跨模型切换的身份校验、
// delegate/fleet、祖先会话日志回溯（parentSession 继承链）。prompt pack 的工具面
// 应用在 compress-tool.ts（注册期解析），提示词覆写经 resolvePrompts 进 nudge。

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
  SessionEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";

/** Pi 的 LLM 消息类型（经 SessionMessageEntry 取型；0.85.x 未直接导出 AgentMessage） */
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
  acpEntriesToCoreMessages,
  acpOriginalsOf,
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


/** 引擎向外发诊断的通道（mod.ts 注入：带事件现场的 ctx，直接 ui.notify + 按键去重） */
export type AcpDiagnostics = (
  key: string,
  level: "info" | "warning" | "error",
  message: string,
  ctx: ExtensionContext,
) => void;

/** 会话运行态槽：状态未加载时 state 缺席；加载失败时 failure 携带机读原因 */
interface AcpSessionSlot {
  state?: CompressionState;
  failure?: { kind: "newer-schema" | "rebuild-failed"; detail?: string };
  nudgeTurnKey?: string;
  /** 最近一次成功落盘的状态签名（工单 06 会话末补写用）：与当前状态相同即磁盘已是最新 */
  persistedSignature?: string;
}

/** 压缩工具参数（模型侧形状；工具 schema 在 compress-tool.ts） */
export interface AcpCompressArgs {
  content: unknown;
  topic?: unknown;
  summaryMaxChars?: unknown;
}

/** compress 执行结果：文本面板 + 是否创建了块（诊断/测试观察） */
export interface AcpCompressOutcome {
  readonly text: string;
  readonly blocksCreated: number;
  readonly tokensCompressed: number;
  /** 是否真的建了块并完成 sidecar 原子落盘（工单 06 的成功接缝：只有它为 true
   *  才算一次「ACP 压缩真正成功」，工具据它清除降级标记） */
  readonly persisted: boolean;
}

/** decompress 工具参数（模型侧形状；工具 schema 在 decompress-tool.ts） */
export interface AcpDecompressArgs {
  blockId: unknown;
  full?: unknown;
  toFile?: unknown;
  inline?: unknown;
}

/** decompress 执行结果：文本 + 实际走向（诊断/测试观察） */
export interface AcpDecompressOutcome {
  readonly text: string;
  readonly mode: "block-inline" | "block-file" | "message-inline" | "message-file" | "notice";
  /** 命中的块 id（消息模式为归属块；通知模式可能缺席） */
  readonly blockId?: string;
}

/** search_context 工具参数（模型侧形状；工具 schema 在 search-tool.ts） */
export interface AcpSearchArgs {
  query: unknown;
  limit?: unknown;
}

/** search_context 执行结果：文本 + 命中数（诊断/测试观察） */
export interface AcpSearchOutcome {
  readonly text: string;
  readonly matches: number;
  readonly blockCount: number;
  readonly messageCount: number;
}

/** 全量日志读取（分支校验用）：优先 getEntries（含非当前分支），宿主无该接缝时
 *  退化为当前分支视图。避免树导航后把合法 sidecar 误判为不一致。 */
export function acpReadAllEntries(ctx: ExtensionContext): SessionEntry[] {
  const source = ctx.sessionManager as unknown as {
    getEntries?: () => SessionEntry[];
    buildContextEntries?: () => SessionEntry[];
  };
  if (typeof source.getEntries === "function") return source.getEntries();
  if (typeof source.buildContextEntries === "function") return source.buildContextEntries();
  return [];
}

/**
 * sidecar 与会话日志的分支一致性校验（fork/拷贝/回退场景，工单 09）：统计块的
 * 直接覆盖 id 里在日志中找不到基 id 的数量（拆分 id `entryId#callId` 按基 id
 * 归一）。0 = 一致；>0 = sidecar 属于另一份会话内容，按日志重建。
 */
export function acpSidecarLogMismatch(state: CompressionState, entries: readonly SessionEntry[]): number {
  if (state.blocks.length === 0) return 0;
  const known = new Set(entries.map((entry) => entry.id));
  let missing = 0;
  for (const block of state.blocks) {
    for (const id of block.directMessageIds) {
      const base = id.split("#")[0]!;
      if (!known.has(base)) missing += 1;
    }
  }
  return missing;
}

type SessionEntrySource = {
  buildContextEntries?: () => SessionEntry[];
};

/** 读当前会话 entry 列表（Pi 宿主的稳定 entry id 是压缩坐标系原点） */
export function acpReadContextEntries(ctx: ExtensionContext): SessionEntry[] {
  const source = ctx.sessionManager as unknown as SessionEntrySource;
  if (typeof source.buildContextEntries === "function") return source.buildContextEntries();
  return [];
}

/** 宿主是否具备 ACP 所需的 entry 接缝（preflight：不具备时 ACP 无法投影） */
export function acpHostSupported(ctx: ExtensionContext): boolean {
  const source = ctx.sessionManager as unknown as SessionEntrySource;
  return typeof source.buildContextEntries === "function";
}

/**
 * 会话日志里是否留有成功的 compress 调用（sidecar 重建的前置判断）。
 * 工单 06：宿主 0.85.x 不读 AgentToolResult.isError，被拒的预注册工具调用会以
 * 成功的工具结果落进日志；那类条目带的 details.toolUnavailable 才是拒绝标记，
 * 不能当成压缩历史。
 */
export function acpHasCompressHistory(entries: readonly SessionEntry[]): boolean {
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = (entry as {
      message?: { role?: string; toolName?: string; isError?: boolean; details?: unknown };
    }).message;
    if (
      message?.role === "toolResult" &&
      message.toolName === "compress" &&
      message.isError !== true &&
      !isAcpToolUnavailableDetails(message.details)
    ) {
      return true;
    }
  }
  return false;
}

function sessionRefOf(ctx: ExtensionContext): { sessionId: string; sessionFile?: string } {
  const sm = ctx.sessionManager;
  return { sessionId: sm.getSessionId(), sessionFile: sm.getSessionFile() ?? undefined };
}

/**
 * 引擎读配置的入口（工单 10 配置消费接缝）：当前会话模型身份 × ACP 高级配置
 * → 级联合并 + 内核映射。未注入 readAcpSettings（如既有测试夹具）时等价全默认。
 * 升档校验失败在会话内提示一次（去重），两项阈值已由接缝回退内核默认。
 */
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

/** 状态内容签名（工单 06 的「磁盘是否已是最新」判定）：与落盘载荷同源，块内容变化即变 */
function stateSignature(state: CompressionState): string {
  return JSON.stringify(state);
}

/** 会话消息的粗略 token 估计（与内核同源的 CJK 感知计数器） */
function estimateTokensOf(messages: readonly CoreMessage[]): number {
  let total = 0;
  for (const message of messages) total += defaultCountTokens(message.text ?? "");
  return total;
}

function lastUserEntryId(entries: readonly SessionEntry[]): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    const role = (entry as { message?: { role?: string } }).message?.role;
    if (role === "user") return entry.id;
  }
  return "none";
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface AcpEngineOptions {
  readonly t: Translator;
  readonly diagnostics: AcpDiagnostics;
  /** 保护策略（工单 09 接缝）：缺省用模块内默认值；级联未覆盖的字段以它为基座 */
  readonly protection?: AcpProtectionPolicy;
  /** ACP 高级配置读取口（工单 10）：每次投影/压缩/重建前实时读取（缺省 = 全默认） */
  readonly readAcpSettings?: () => AcpAdvancedSettings;
}

export interface AcpCompressionEngine {
  /** 会话开始：绑定/加载 sidecar（缺失或损坏时按会话日志重建，见实现） */
  beginSession(ctx: ExtensionContext): Promise<void>;
  /** 会话结束：先把内存态原子落盘，再释放运行态（磁盘 sidecar 保留） */
  endSession(ctx: ExtensionContext): Promise<void>;
  /** context 事件：ACP 拥有当前会话时生成请求视图；否则原样放行 */
  handleContext(event: ContextEvent, ctx: ExtensionContext, active: boolean): Promise<{ messages: AgentMessage[] } | undefined>;
  /** compress 工具执行：范围+摘要 → 压缩块 + 引用登记 + sidecar 落盘 */
  executeCompress(args: AcpCompressArgs, ctx: ExtensionContext, toolCallId?: string): Promise<AcpCompressOutcome>;
  /** decompress 工具执行：块或单条消息的原文找回（内联进视图 / 落文件 / 提示） */
  executeDecompress(args: AcpDecompressArgs, ctx: ExtensionContext, toolCallId?: string): Promise<AcpDecompressOutcome>;
  /** search_context 工具执行：按关键词定位压缩块与被折叠消息 */
  executeSearch(args: AcpSearchArgs, ctx: ExtensionContext): Promise<AcpSearchOutcome>;
  /** 当前会话状态视图（测试与诊断；未加载/失败时 undefined） */
  currentState(ctx: ExtensionContext): CompressionState | undefined;
  /** sidecar 存取（测试与工单 09/10 观察） */
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

  /**
   * 会话状态装载（beginSession 与工具路径共用）：
   * - ok 且与日志一致：直接用；
   * - ok 但块引用的 id 不在本会话日志里（fork 拷贝了 sidecar、会话文件回退
   *   到旧版本等）：报告后走重建（日志是事实源，不盲信磁盘状态）；
   * - missing：新会话正常态。若日志里有成功 compress 调用（resume 丢了
   *   sidecar），用内核 rebuildCompressionState 按日志重放重建并回写
   *   sidecar；没有历史则从初始状态开始；
   * - corrupt：报告后走同一重建路径（会话日志是事实源）；重建不出块时从
   *   初始状态开始并提示；
   * - newer-schema：明确失败（不解释不重写），状态缺席，压缩运行降级。
   */
  async function ensureSessionState(ctx: ExtensionContext): Promise<AcpSessionSlot> {
    const key = keyOf(ctx);
    const { sessionId, sessionFile } = sessionRefOf(ctx);
    const existing = slots.get(key);
    if (existing) return existing;
    const slot: AcpSessionSlot = {};
    slots.set(key, slot);

    const loaded = await store.load(sessionFile, sessionId);
    if (loaded.status === "ok" && loaded.state) {
      // 分支状态校验（日志读取失败时跳过校验，维持磁盘状态——不因接缝异常
      // 误伤合法 sidecar）
      let mismatch = 0;
      try {
        mismatch = acpSidecarLogMismatch(loaded.state, acpReadAllEntries(ctx));
      } catch {
        mismatch = 0;
      }
      if (mismatch === 0) {
        // 配置代际校验（工单 11）：sidecar 写入后 ACP 配置变更——状态与配置
        // 解耦（见 judgeAcpConfigGeneration），兼容判定为可用；变更时诊断一
        // 次，绝不因配置变化重建或丢弃已落盘块
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
        // 从盘装载的状态与磁盘一致：会话末不必再写一遍（也不会盖掉后续的损坏现场）
        slot.persistedSignature = stateSignature(loaded.state);
        return slot;
      }
      // 分支状态校验未过：sidecar 的块不属于这份日志（拷贝/回退），重建
      diagnostics(
        "sidecar-mismatch",
        "warning",
        t("module.compression.acp.sidecarMismatch", { missing: String(mismatch) }),
        ctx,
      );
    } else if (loaded.status === "newer-schema") {
      slot.failure = { kind: "newer-schema", detail: `schema v${loaded.schemaVersion ?? "?"}` };
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

    // 缺失 / 损坏 / 与日志不一致：按会话日志重建（日志是事实源——compress
    // 调用参数原样留在 assistant 消息里，成功的 toolResult 标记了可重放）
    const entries = acpReadContextEntries(ctx);
    if (acpHasCompressHistory(entries)) {
      try {
        const rebuilt = rebuildCompressionState(
          createInitialState(),
          acpEntriesToCoreMessages(entries),
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
          return slot;
        }
        if (loaded.status === "corrupt") {
          // 日志里有历史但一块都重放不出来：sidecar 的状态无据可依，按明确
          // 失败处理（不伪装成“从零开始”）
          slot.failure = { kind: "rebuild-failed", detail: "history present but nothing replayable" };
          diagnostics(
            "sidecar-rebuild-failed",
            "error",
            t("module.compression.acp.sidecarRebuildFailed"),
            ctx,
          );
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
        return slot;
      }
    }
    // 无历史（或缺失且无历史）：初始状态；无会话文件时只驻内存
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
      // commit 阶段失败：报告持久化错误；不回滚内存状态（下一次请求继续用，
      // sidecar 落盘失败会在下一次保存重试），也绝不再启动另一种压缩
      diagnostics(
        "sidecar-save-failed",
        "error",
        t("module.compression.acp.saveFailed", { error: describeError(error) }),
        ctx,
      );
      return false;
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
      const slot = await ensureSessionState(ctx);
      if (!slot.state) {
        // sidecar 明确失败（newer-schema / 重建失败）：投影无法进行。报告后
        // 原样放行本次请求（不伪造投影）；before_compact 已取消原生压缩，
        // 不会产生第二套压缩坐标
        diagnostics(
          "projection-unavailable",
          "error",
          t("module.compression.acp.projectionUnavailable"),
          ctx,
        );
        return undefined;
      }
      const entries = acpReadContextEntries(ctx);
      const coreMessages = acpEntriesToCoreMessages(entries);
      const runtime = runtimeFor(ctx);
      const tokenCount = estimateTokensOf(coreMessages);
      const turn = core.processTurn({ messages: coreMessages, state: slot.state, config: runtime.kernel, tokenCount });
      slot.state = turn.state;
      await persistState(turn.state, ctx);

      let rebuilt = acpCoreOutToAgentMessages(turn.messages, acpOriginalsOf(entries));

      // 请求视图变换（评审修复 F1）：消费 runtime.merged 的宿主侧策略字段。
      // 顺序与上游一致（reasoning drop 在 nudge 注入前，合成 nudge 不能追溯
      // 闭环一轮在途的 compress 调用）；图片剥离只改请求视图，不动会话日志。
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

      // nudge 注入（工单 10 起带高级配置）：内核判定应注入时，普通档每用户轮至多
      // 一次；紧急档（用量 ≥ 紧急阈值）每次请求都注入；文本用解析后的提示词
      // （含覆写）。增长步长/阈值由级联覆盖进内核 Config。
      if (turn.nudge?.shouldInject) {
        const turnKey = lastUserEntryId(entries);
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
      // 投影失败：保留 ACP 状态，报告恢复动作（重试本轮请求或查看诊断）；
      // 不静默产生其它压缩结果
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
      // 参数解析走内核的宽容解析器（fenced/尾逗号/字符串化数组都救得回来）；
      // 解析不出任何范围按错误抛出（工具结果 isError，重建时会被跳过）
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

      const slot = await ensureSessionState(ctx);
      if (!slot.state) {
        throw new Error(t("module.compression.acp.stateUnavailable"));
      }
      const entries = acpReadContextEntries(ctx);
      const coreMessages = acpEntriesToCoreMessages(entries);
      const config = runtimeFor(ctx).kernel;
      const tokenCount = estimateTokensOf(coreMessages);
      // 先跑一次投影让引用就位（applyCompression 按 byRef 解析范围端点）
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
        // 工单 06：只有「建了块 + sidecar 原子落盘完成」才算 ACP 压缩真正成功
        persisted,
      };
    } finally {
      release();
    }
  }

  /** 内联重折叠提示（K2）：解压结果重新压缩时原地更新同一块而非新建 */
  function refoldHint(blockId: string, restored: { restoredStartRef?: string; restoredEndRef?: string } | null): string {
    if (restored?.restoredStartRef && restored.restoredEndRef) {
      return `Re-fold: call compress({ content: [{ startId: "${restored.restoredStartRef}", endId: "${restored.restoredEndRef}", summary: "..." }] }) → updates block ${blockId} in place (same id, new summary).`;
    }
    return `Re-fold: call compress over the restored messages with a fresh summary → updates block ${blockId} in place (same id, new summary).`;
  }

  /**
   * decompress 执行（工单 09）：把压缩块或单条消息的原文找回。
   *
   * 目标解析顺序（与上游一致）：先按消息引用找归属块（search 结果的 m 引用
   * 或原始 id），再按块 id（bN / N）；单消息默认内联（小），块默认落文件
   * （大）——inline: true 强制内联，toFile 指定落点（仅允许临时/缓存目录）。
   * 块内容经内核 collectBlockContent 只读收集，摘要与缓存前缀不动；内联
   * 恢复经 markBlockRestoredInline 登记（支持后续原地重折叠）并落盘。
   * 同一目标的内联结果仍留在视图时拒绝重复插入（提示而非再次插入）。
   */
  async function executeDecompress(
    args: AcpDecompressArgs,
    ctx: ExtensionContext,
    _toolCallId?: string,
  ): Promise<AcpDecompressOutcome> {
    const key = keyOf(ctx);
    const release = await acquireLock(key);
    try {
      const slot = await ensureSessionState(ctx);
      if (!slot.state) {
        throw new Error(t("module.compression.acp.stateUnavailable"));
      }
      const state = slot.state;
      const entries = acpReadContextEntries(ctx);
      const arg = typeof args.blockId === "string" ? args.blockId.trim() : "";
      const full = args.full === true;
      const wantInline = args.inline === true;
      const toFile = typeof args.toFile === "string" && args.toFile.trim().length > 0 ? args.toFile.trim() : undefined;

      // 1) 消息引用优先：命中某块的覆盖范围 → 单消息模式
      const rawId = /^m\d+$/.test(arg) ? state.messageRefs.byRef[arg] : arg;
      const ownerBlock = rawId ? state.blocks.find((b) => b.effectiveMessageIds.includes(rawId)) : undefined;
      if (ownerBlock && rawId) {
        const found = acpFindMessageByRef(arg, state, entries);
        if (!found || !found.text) {
          return {
            text: `Message ${arg} (in block ${ownerBlock.blockId}) has no restorable text content in the session log.`,
            mode: "notice",
            blockId: ownerBlock.blockId,
          };
        }
        const wantFile = toFile !== undefined || args.inline === false || !acpMessageFitsInline(found.text);
        if (!wantFile) {
          // 单消息重复插入防护：上次结果仍在视图时不重复插入
          const visible = acpFindVisibleInlineRestore(arg, state, entries);
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

      // 2) 块 id 模式
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

      // 块覆盖区的原始消息：当前分支视图 + 缺席时经 getEntry 补齐（树导航后
      // 分支视图可能不含旧分支消息；日志里都有）
      const baseIds = new Set(entries.map((entry) => entry.id));
      const missing = [...new Set(block.effectiveMessageIds.map((id) => id.split("#")[0]!))].filter(
        (id) => !baseIds.has(id),
      );
      const extraEntries = missing.length > 0 ? acpFetchMissingEntries(missing, ctx) : [];
      const resolvedCoreMessages = acpEntriesToCoreMessages([...entries, ...extraEntries]);
      const collected = collectBlockContent(state, block, resolvedCoreMessages, { full });
      if (collected.count === 0) {
        return {
          text: `Block ${blockId} has no restorable message content.`,
          mode: "notice",
          blockId,
        };
      }

      // 3) 内联模式：内容直接回到当前请求视图（作为 decompress 工具结果）
      if (wantInline && toFile === undefined) {
        const visible = acpFindVisibleInlineRestore(blockId, state, entries);
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

      // 4) 文件模式（默认）：内容落盘，块保持压缩，附头预览
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

  /**
   * search_context 执行（工单 09）：按关键词定位压缩块与被折叠的原始消息。
   * 只读（不攺状态）：索引 = 全部块摘要 + 被块覆盖的原始消息（仍可见的消息
   * 模型本来就能看到，不进索引）；空结果返回可理解反馈。
   */
  async function executeSearch(args: AcpSearchArgs, ctx: ExtensionContext): Promise<AcpSearchOutcome> {
    const key = keyOf(ctx);
    const release = await acquireLock(key);
    try {
      const slot = await ensureSessionState(ctx);
      const query = typeof args.query === "string" ? args.query : "";
      const limit =
        typeof args.limit === "number" && Number.isFinite(args.limit) && args.limit > 0
          ? Math.floor(args.limit)
          : undefined;
      if (!slot.state) {
        // 只读工具不抛错：以文本告知状态不可用（与上游 refused 口径一致）
        return {
          text: `search_context is unavailable: ACP state could not be loaded for this session (see the compression diagnosis).`,
          matches: 0,
          blockCount: 0,
          messageCount: 0,
        };
      }
      const entries = acpReadContextEntries(ctx);
      const report = acpRunSearch(slot.state, entries, query, limit);
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
        // 会话开始重新绑定（上一会话的槽在 shutdown 已释放；resume/fork 换了
        // 会话文件则键不同，天然隔离）
        await ensureSessionState(ctx);
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
        // 工单 06：会话结束把「内存里有、磁盘上没有」的私态补写回来，再释放运行态；
        // 与当前处在哪种模式无关（中途关闭模块、切到 codex、覆盖切走都一样）。
        // 三种情形不写：没有状态（加载失败：不去覆盖那份不可解释的文件）、
        // 没有块（从未真正压缩，不凭空造一个空 sidecar）、
        // 磁盘上已经是最新（重复写同样内容会把一次 sidecar 损坏的现场覆盖掉，
        // 而那份现场正是日志重建路径要用的入口）。
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
