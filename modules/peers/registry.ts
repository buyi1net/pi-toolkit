import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Dirent,
  type Stats,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { peersSharedDir, type PeerActivity, type PeerLiveness, type PeersSettings } from "./api.ts";

const REGISTRATION_VERSION = 1;

export interface PeerRegistration {
  readonly sessionId: string;
  readonly instanceId: string;
  readonly name: string | null;
  readonly cwd: string | null;
  readonly pid: number;
  readonly activity: PeerActivity;

  readonly heartbeatAt: number;

  readonly endpoint: string | null;
}

const FILE_NAME_SAFE_PATTERN = /^[A-Za-z0-9._-]+$/;

export function peerRegistrationFileName(sessionId: string, instanceId: string): string {
  if (!FILE_NAME_SAFE_PATTERN.test(sessionId)) {
    throw new Error(`会话 id 含文件名不安全字符：${JSON.stringify(sessionId)}`);
  }
  if (!FILE_NAME_SAFE_PATTERN.test(instanceId)) {
    throw new Error(`实例 id 含文件名不安全字符：${JSON.stringify(instanceId)}`);
  }
  return `${sessionId}.${instanceId}.json`;
}

export function peerRegistrationFile(agentDir: string, sessionId: string, instanceId: string): string {
  return join(peersSharedDir(agentDir), peerRegistrationFileName(sessionId, instanceId));
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function validateRegistration(value: unknown): PeerRegistration | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (raw.version !== REGISTRATION_VERSION) return null;
  if (typeof raw.sessionId !== "string" || raw.sessionId === "") return null;
  if (typeof raw.instanceId !== "string" || raw.instanceId === "") return null;
  if (typeof raw.pid !== "number" || !Number.isInteger(raw.pid)) return null;
  if (raw.activity !== "working" && raw.activity !== "idle") return null;
  if (typeof raw.heartbeatAt !== "number" || !Number.isFinite(raw.heartbeatAt)) return null;
  return {
    sessionId: raw.sessionId,
    instanceId: raw.instanceId,
    name: optionalString(raw.name),
    cwd: optionalString(raw.cwd),
    pid: raw.pid,
    activity: raw.activity,
    heartbeatAt: raw.heartbeatAt,
    endpoint: optionalString(raw.endpoint),
  };
}

function errnoCode(error: unknown): string | undefined {
  return typeof (error as { code?: unknown } | null)?.code === "string"
    ? (error as { code: string }).code
    : undefined;
}

export function writePeerRegistration(file: string, registration: PeerRegistration): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tempFile = join(dir, `.${basename(file)}.${process.pid}.tmp`);
  try {
    writeFileSync(tempFile, `${JSON.stringify({ version: REGISTRATION_VERSION, ...registration })}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(tempFile, file);
  } catch (error) {
    try {
      unlinkSync(tempFile);
    } catch {
      // 临时文件清理尽力而为，保留原写入失败
    }
    throw error;
  }
}

function readRegistrationFile(file: string): PeerRegistration | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  return validateRegistration(parsed);
}

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function peerRegistrationLiveness(ageMs: number, settings: PeersSettings): PeerLiveness {
  if (ageMs <= settings.staleAfterMs) return "online";
  if (ageMs <= settings.cleanupAfterMs) return "stale";
  return "offline";
}

export interface PeerRegistrationRead {
  readonly file: string;
  readonly registration: PeerRegistration;
  readonly liveness: PeerLiveness;
}

export interface PeerRegistrationReadStats {
  readonly registrations: readonly PeerRegistrationRead[];

  readonly skipped: number;
}

export function readPeerRegistrations(
  agentDir: string,
  request: { readonly now: number; readonly settings: PeersSettings },
): PeerRegistrationReadStats {
  const dir = peersSharedDir(agentDir);
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {

      return { registrations: [], skipped: 0 };
    }
    throw error;
  }
  const registrations: PeerRegistrationRead[] = [];
  let skipped = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".json")) continue;
    const file = join(dir, entry.name);
    const registration = readRegistrationFile(file);
    if (!registration) {
      skipped += 1;
      continue;
    }
    registrations.push({
      file,
      registration,
      liveness: peerRegistrationLiveness(request.now - registration.heartbeatAt, request.settings),
    });
  }
  return { registrations, skipped };
}

export interface PeerRegistrationIdentityQuery {
  readonly sessionId: string;
  readonly instanceId: string;
  readonly now: number;
  readonly settings: PeersSettings;

  readonly onDiagnostic?: (detail: string) => void;
}

export function readPeerRegistrationByIdentity(
  agentDir: string,
  query: PeerRegistrationIdentityQuery,
): PeerRegistrationRead | null {
  let file: string;
  try {
    file = peerRegistrationFile(agentDir, query.sessionId, query.instanceId);
  } catch (error) {
    query.onDiagnostic?.(
      `peers 注册查询被文件名守卫拒绝（会话 ${JSON.stringify(query.sessionId)} 实例 ${JSON.stringify(query.instanceId)}）：${describeFailure(error)}；按来源未登记处理`,
    );
    return null;
  }
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    query.onDiagnostic?.(
      `peers 注册查询定位失败（会话 ${query.sessionId} 实例 ${query.instanceId}）：${describeFailure(error)}；按来源未登记处理`,
    );
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const registration = validateRegistration(parsed);

  if (
    registration === null ||
    registration.instanceId !== query.instanceId ||
    registration.sessionId !== query.sessionId
  ) {
    return null;
  }
  return {
    file,
    registration,
    liveness: peerRegistrationLiveness(query.now - registration.heartbeatAt, query.settings),
  };
}

export interface PeerHeartbeatTimer {
  clear(): void;
}

export type PeerHeartbeatScheduler = (callback: () => void, intervalMs: number) => PeerHeartbeatTimer;

export function defaultPeerHeartbeatScheduler(
  callback: () => void,
  intervalMs: number,
): PeerHeartbeatTimer {
  const timer = setInterval(callback, intervalMs);
  timer.unref();
  return {
    clear() {
      clearInterval(timer);
    },
  };
}

export interface PeerSessionIdentity {
  readonly sessionId: string;
  readonly name: string | null;
  readonly cwd: string | null;
}

export interface PeerInstanceIdentity extends PeerSessionIdentity {
  readonly instanceId: string;
}

export interface HeartbeatMaintainerOptions {
  readonly agentDir: string;

  readonly getSettings: () => PeersSettings;
  readonly now?: () => number;
  readonly schedule?: PeerHeartbeatScheduler;

  readonly generateInstanceId?: () => string;

  readonly onError?: (detail: string) => void;

  readonly onTick?: () => void;
}

export interface HeartbeatMaintainer {

  start(identity: PeerSessionIdentity): void;

  setActivity(activity: PeerActivity): void;

  setName(name: string | null): void;

  setEndpoint(endpoint: string | null): void;

  stop(): void;

  instanceId(): string | null;

  identity(): PeerInstanceIdentity | null;
}

export function createHeartbeatMaintainer(options: HeartbeatMaintainerOptions): HeartbeatMaintainer {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? defaultPeerHeartbeatScheduler;
  const generateInstanceId = options.generateInstanceId ?? randomUUID;

  let identity: PeerSessionIdentity | undefined;
  let instanceId: string | undefined;
  let name: string | null = null;
  let endpoint: string | null = null;
  let activity: PeerActivity = "idle";
  let ownFile: string | undefined;
  let timer: PeerHeartbeatTimer | undefined;
  let settings: PeersSettings | undefined;

  const cleanupCandidates = new Map<string, string>();
  let lastErrorDetail: string | undefined;

  const reportError = (error: unknown): void => {
    const detail = error instanceof Error ? error.message : String(error);
    if (detail === lastErrorDetail) return;
    lastErrorDetail = detail;
    options.onError?.(detail);
  };

  const writeHeartbeat = (): void => {
    if (!identity || !instanceId || !ownFile) return;
    writePeerRegistration(ownFile, {
      sessionId: identity.sessionId,
      instanceId,
      name,
      cwd: identity.cwd,
      pid: process.pid,
      activity,
      heartbeatAt: now(),
      endpoint,
    });
  };

  const safeHeartbeat = (): void => {
    try {
      writeHeartbeat();
    } catch (error) {
      reportError(error);
    }
  };

  const safeOnTick = (): void => {
    if (options.onTick === undefined) return;
    try {
      options.onTick();
    } catch (error) {
      reportError(error);
    }
  };

  const sweep = (): void => {
    if (!settings) return;
    const dir = peersSharedDir(options.agentDir);
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      const code = errnoCode(error);
      if (code === "ENOENT" || code === "ENOTDIR") {

        cleanupCandidates.clear();
        return;
      }
      reportError(error);
      return;
    }
    const nowMs = now();
    const seen = new Set<string>();
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".json")) continue;
      const file = join(dir, entry.name);
      seen.add(file);
      if (file === ownFile) continue;
      let fingerprintStat: Stats;
      try {
        fingerprintStat = statSync(file);
      } catch {
        continue;
      }
      const registration = readRegistrationFile(file);
      if (!registration) continue;
      if (nowMs - registration.heartbeatAt <= settings.cleanupAfterMs) {
        cleanupCandidates.delete(file);
        continue;
      }
      const fingerprint = `${fingerprintStat.mtimeMs}|${fingerprintStat.size}|${registration.heartbeatAt}`;
      if (cleanupCandidates.get(file) === fingerprint) {
        try {
          unlinkSync(file);
          cleanupCandidates.delete(file);
        } catch (error) {
          if (errnoCode(error) === "ENOENT") {
            cleanupCandidates.delete(file);
          } else {
            reportError(error);
          }
        }
      } else {

        cleanupCandidates.set(file, fingerprint);
      }
    }

    for (const file of cleanupCandidates.keys()) {
      if (!seen.has(file)) cleanupCandidates.delete(file);
    }
  };

  const stopInternally = (): void => {
    if (timer) {
      timer.clear();
      timer = undefined;
    }
    if (ownFile) {
      try {
        unlinkSync(ownFile);
      } catch (error) {

        if (errnoCode(error) !== "ENOENT") reportError(error);
      }
    }
    identity = undefined;
    instanceId = undefined;
    ownFile = undefined;
    settings = undefined;
    activity = "idle";
    endpoint = null;
    name = null;
    cleanupCandidates.clear();
  };

  return {
    start(nextIdentity: PeerSessionIdentity): void {
      stopInternally();
      try {
        identity = nextIdentity;
        name = nextIdentity.name;
        instanceId = generateInstanceId();
        ownFile = peerRegistrationFile(options.agentDir, nextIdentity.sessionId, instanceId);

        activity = "idle";
        endpoint = null;
        settings = options.getSettings();
        safeHeartbeat();
        timer = schedule(() => {
          safeHeartbeat();
          sweep();
          safeOnTick();
        }, settings.heartbeatIntervalMs);
      } catch (startError) {

        stopInternally();
        reportError(startError);
      }
    },

    setActivity(next: PeerActivity): void {
      if (!identity || activity === next) return;
      activity = next;

      safeHeartbeat();
    },

    setName(next: string | null): void {
      if (!identity || name === next) return;
      name = next;
      safeHeartbeat();
    },

    setEndpoint(next: string | null): void {
      if (!identity || endpoint === next) return;
      endpoint = next;
      safeHeartbeat();
    },

    stop(): void {
      stopInternally();
    },

    instanceId(): string | null {
      return instanceId ?? null;
    },

    identity(): PeerInstanceIdentity | null {
      if (!identity || !instanceId) return null;
      return { sessionId: identity.sessionId, name, cwd: identity.cwd, instanceId };
    },
  };
}
