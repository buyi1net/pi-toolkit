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

interface SidecarSlot {
  state: CompressionState;

  sessionId?: string;

  configFingerprint?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function acpSidecarPathFor(sessionFile: string | undefined): string | null {
  return sessionFile ? sessionFile + ACP_SIDECAR_SUFFIX : null;
}

function slotKeyOf(sessionFile: string | undefined, sessionId: string): string {
  return sessionFile ? `file:${sessionFile}` : `session:${sessionId}`;
}

function looksLikeState(value: unknown): value is CompressionState {
  return isRecord(value) && Array.isArray((value as { blocks?: unknown }).blocks) && isRecord((value as { messageRefs?: unknown }).messageRefs);
}

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

  private writeChains = new Map<string, Promise<void>>();
  private tmpSequence = 0;

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

  bindInMemory(state: CompressionState, sessionId: string): void {
    this.slots.set(slotKeyOf(undefined, sessionId), { state });
  }

  peek(sessionFile: string | undefined, sessionId: string): CompressionState | undefined {
    return this.slots.get(slotKeyOf(sessionFile, sessionId))?.state;
  }

  release(sessionFile: string | undefined, sessionId: string): void {
    this.slots.delete(slotKeyOf(sessionFile, sessionId));
  }
}

export async function acpSidecarExists(sessionFile: string | undefined): Promise<boolean> {
  const file = acpSidecarPathFor(sessionFile);
  if (!file) return false;
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

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
