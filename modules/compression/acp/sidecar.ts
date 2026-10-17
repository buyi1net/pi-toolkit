// ACP sidecar 存取（工单 08）：<sessionFile>.acp.json 的原子写入、同会话并发
// 保护与读取分类。
//
// 移植自 billion-context-pi 的 src/state.ts / contract.ts（MIT），按本仓口径裁剪：
// - 原子写入：先写 `<file>.acp.tmp-<pid>-<seq>` 临时文件再 rename，读取方要么
//   看到上一个完整文件要么看到下一个完整文件，永不读到撕裂写；
// - 同会话并发保护：同一 sidecar 路径的写入经 promise 链串行化（后写的等
//   先写的落盘完成），内存槽（缓存）与磁盘一致；
// - 会话身份绑定：sidecar 顶层登记写入时的 session.id；运行态槽按
//   「会话文件（无文件时退化为 session id）」键控，session_shutdown 释放；
// - 版本策略：缺省版本号按 v1 解释（兼容上游 billion-context-pi 的 v1
//   sidecar，可互相读取）；高于 ACP_SIDECAR_SCHEMA_VERSION 的文件按
//   newer-schema 分类，读取侧明确失败，本实现不解释也不重写它；
// - 损坏（不可解析/形状不对）按 corrupt 分类：由调用方（engine）走会话日志
//   重建或明确失败，本层不静默给默认状态。

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createInitialState, type CompressionState } from "acp-kernel";
import {
  ACP_SIDECAR_PRODUCER,
  ACP_SIDECAR_SCHEMA_VERSION,
  ACP_SIDECAR_SUFFIX,
  type AcpSidecarFile,
  type AcpSidecarLoadResult,
} from "./types.ts";

/** 运行态槽：一个会话一份状态（含旁路诊断），键见 slotKeyOf */
interface SidecarSlot {
  state: CompressionState;
  /** sidecar 登记的写入会话 id（诊断；未落盘时缺席） */
  sessionId?: string;
  /** 写入时的配置代际指纹（未携带时缺席） */
  configFingerprint?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** sidecar 路径：<sessionFile>.acp.json；无会话文件（内存会话）返回 null */
export function acpSidecarPathFor(sessionFile: string | undefined): string | null {
  return sessionFile ? sessionFile + ACP_SIDECAR_SUFFIX : null;
}

/** 运行态槽键：优先会话文件（跨进程稳定），无文件时退化为会话 id */
function slotKeyOf(sessionFile: string | undefined, sessionId: string): string {
  return sessionFile ? `file:${sessionFile}` : `session:${sessionId}`;
}

/** 读取的 state 形状校验：blocks 是数组、messageRefs 是对象才可用 */
function looksLikeState(value: unknown): value is CompressionState {
  return isRecord(value) && Array.isArray((value as { blocks?: unknown }).blocks) && isRecord((value as { messageRefs?: unknown }).messageRefs);
}

/** 旧状态补齐新字段（内核新增字段缺席时用初始值填，不丢用户数据） */
function mergeAcpState(parsed: CompressionState): CompressionState {
  const fresh = createInitialState();
  return {
    blocks: parsed.blocks ?? fresh.blocks,
    messageRefs: parsed.messageRefs ?? fresh.messageRefs,
    tokenSnapshot: parsed.tokenSnapshot ?? fresh.tokenSnapshot,
    nudge: { ...fresh.nudge, ...(parsed.nudge ?? {}) },
    stats: { ...fresh.stats, ...(parsed.stats ?? {}) },
    absorbed: parsed.absorbed ?? fresh.absorbed,
    rules: parsed.rules ?? fresh.rules,
    nextRuleId: parsed.nextRuleId ?? fresh.nextRuleId,
    ...(parsed.terminalStreak !== undefined ? { terminalStreak: parsed.terminalStreak } : {}),
    nextBlockId: parsed.nextBlockId ?? fresh.nextBlockId,
    nextRunId: parsed.nextRunId ?? fresh.nextRunId,
  };
}

/** 解析 sidecar JSON：分类出 ok / corrupt / newer-schema（不抛出）；状态体在顶层 `state` 字段下 */
function parseSidecar(raw: string): AcpSidecarLoadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      status: "corrupt",
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const stateField = isRecord(parsed) ? (parsed as { state?: unknown }).state : undefined;
  if (!isRecord(parsed) || !looksLikeState(stateField)) {
    return { status: "corrupt", error: "sidecar has no CompressionState-shaped state field" };
  }
  const schemaVersion = typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : undefined;
  if (schemaVersion !== undefined && schemaVersion > ACP_SIDECAR_SCHEMA_VERSION) {
    return { status: "newer-schema", schemaVersion };
  }
  const session = isRecord(parsed.session) ? parsed.session : undefined;
  const sessionId = session && typeof session.id === "string" ? session.id : undefined;
  const config = isRecord(parsed.config) ? parsed.config : undefined;
  const configFingerprint =
    config && typeof config.fingerprint === "string" ? config.fingerprint : undefined;
  return {
    status: "ok",
    state: mergeAcpState(stateField as CompressionState),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(configFingerprint === undefined ? {} : { configFingerprint }),
    ...(schemaVersion === undefined ? {} : { schemaVersion }),
  };
}

export class AcpSidecarStore {
  private slots = new Map<string, SidecarSlot>();
  /** 同 sidecar 路径的写入串行链（并发保护：后写的等先写的完成） */
  private writeChains = new Map<string, Promise<void>>();
  private tmpSequence = 0;

  /**
   * 读 sidecar 并落运行态槽。纯读取：missing/corrupt/newer-schema 不建槽、
   * 不给默认状态（重建或失败由 engine 决定），已有槽时直接返回槽内状态
   * （会话内热路径不重复读盘）。
   */
  async load(sessionFile: string | undefined, sessionId: string): Promise<AcpSidecarLoadResult> {
    const key = slotKeyOf(sessionFile, sessionId);
    const cached = this.slots.get(key);
    if (cached) {
      return {
        status: "ok",
        state: cached.state,
        ...(cached.sessionId === undefined ? {} : { sessionId: cached.sessionId }),
        ...(cached.configFingerprint === undefined ? {} : { configFingerprint: cached.configFingerprint }),
      };
    }
    const file = acpSidecarPathFor(sessionFile);
    if (!file) return { status: "missing" };
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { status: "missing" };
      return { status: "corrupt", error: error instanceof Error ? error.message : String(error) };
    }
    return parseSidecar(raw);
  }

  /**
   * 原子写 sidecar：tmp + rename，同路径写入串行化；内存槽同步更新。
   * 无会话文件（内存会话）只更新内存槽——状态在进程内跨轮存活，但无落盘。
   * configFingerprint（工单 11 配置代际）随载荷写入；缺省不写 config 字段。
   * 写失败向上抛（commit 阶段失败由调用方报告持久化错误，不伪装成功）。
   */
  async save(
    state: CompressionState,
    sessionFile: string | undefined,
    sessionId: string,
    configFingerprint?: string,
  ): Promise<void> {
    const key = slotKeyOf(sessionFile, sessionId);
    const file = acpSidecarPathFor(sessionFile);
    const payload: AcpSidecarFile = {
      schemaVersion: ACP_SIDECAR_SCHEMA_VERSION,
      producer: ACP_SIDECAR_PRODUCER,
      session: {
        id: sessionId,
        ...(sessionFile === undefined ? {} : { file: sessionFile }),
      },
      ...(configFingerprint === undefined ? {} : { config: { fingerprint: configFingerprint } }),
      state,
    };
    if (!file) {
      this.slots.set(key, { state, ...(configFingerprint === undefined ? {} : { configFingerprint }) });
      return;
    }
    const write = (async () => {
      const dir = path.dirname(file);
      await fs.mkdir(dir, { recursive: true });
      const tmp = path.join(dir, `.acp-tmp-${process.pid}-${(this.tmpSequence += 1)}-${path.basename(file)}`);
      try {
        await fs.writeFile(tmp, JSON.stringify(payload), "utf8");
        await fs.rename(tmp, file);
      } catch (error) {
        await fs.rm(tmp, { force: true }).catch(() => undefined);
        throw error;
      }
      this.slots.set(key, { state, sessionId, ...(configFingerprint === undefined ? {} : { configFingerprint }) });
    })();
    const prev = this.writeChains.get(file) ?? Promise.resolve();
    const chained = prev.then(() => write);
    this.writeChains.set(file, chained.catch(() => undefined));
    await chained;
  }

  /** 内存会话（无文件）也要能登记槽：stateFor 热路径与 save 共用 */
  bindInMemory(state: CompressionState, sessionId: string): void {
    this.slots.set(slotKeyOf(undefined, sessionId), { state });
  }

  /** 当前槽内状态（未加载时 undefined；engine 的加载流程负责先 load） */
  peek(sessionFile: string | undefined, sessionId: string): CompressionState | undefined {
    return this.slots.get(slotKeyOf(sessionFile, sessionId))?.state;
  }

  /** 会话结束：释放运行态槽（磁盘 sidecar 不动） */
  release(sessionFile: string | undefined, sessionId: string): void {
    this.slots.delete(slotKeyOf(sessionFile, sessionId));
  }
}

/**
 * 只读探测 sidecar 的压缩块数（工单 11 跨模式切换保护用）：文件缺失、损坏、
 * 版本不可解释或无会话文件时返回 undefined（不构成「活动私有状态」——损坏的
 * sidecar 由 ACP 自己的重建/失败路径处理，不阻断其它模式的压缩决策）。
 * 不建槽、不写盘，纯读取。
 */
export async function readAcpSidecarBlockCount(sessionFile: string | undefined): Promise<number | undefined> {
  const file = acpSidecarPathFor(sessionFile);
  if (!file) return undefined;
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
  const parsed = parseSidecar(raw);
  if (parsed.status !== "ok" || !parsed.state) return undefined;
  return parsed.state.blocks.length;
}
