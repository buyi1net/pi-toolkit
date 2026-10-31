import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { debugLog } from "./diagnostics.ts";
import type { SubagentLaunchPlanMetadata, SubagentProtocol } from "./protocol.ts";
import type { SubagentWaitMode, SubagentWaitRelease } from "./types.ts";

export interface RuntimeRecord {
  version: 1;
  id: string;
  name: string;
  task: string;
  cohortId?: string;

  protocol?: SubagentProtocol;
  launchPlan?: SubagentLaunchPlanMetadata;
  agent?: string;
  modelIdentity?: { provider: string; id: string; api: string; baseUrl: string } | null;
  surface: string;

  surfaceKind?: "herdr" | "tmux";
  startTime: number;
  sessionFile: string;
  activityFile?: string;
  sentinelToken: string;
  interactive: boolean;

  hostSessionId?: string | null;

  kind?: "pane" | "headless";

  pid?: number;

  canonicalTaskName?: string;
  parentCanonicalTaskName?: string | null;
  parentId?: string | null;

  timeoutMs?: number;

  waitMode?: SubagentWaitMode;

  waitReleased?: SubagentWaitRelease;

  member?: boolean;
}

interface RuntimeRegistry {
  version: 1;
  records: RuntimeRecord[];
}

export type RuntimeSource = Omit<RuntimeRecord, "version">;

export function createRuntimeRecord(source: RuntimeSource): RuntimeRecord {
  return {
    version: 1,
    id: source.id,
    name: source.name,
    task: source.task,
    ...(source.cohortId ? { cohortId: source.cohortId } : {}),
    ...(source.protocol ? { protocol: source.protocol } : {}),
    ...(source.launchPlan ? { launchPlan: source.launchPlan } : {}),
    ...(source.agent ? { agent: source.agent } : {}),
    ...(source.modelIdentity ? { modelIdentity: source.modelIdentity } : {}),
    surface: source.surface,
    ...(source.surfaceKind ? { surfaceKind: source.surfaceKind } : {}),
    startTime: source.startTime,
    sessionFile: source.sessionFile,
    ...(source.activityFile ? { activityFile: source.activityFile } : {}),
    sentinelToken: source.sentinelToken,
    interactive: source.interactive,
    ...(source.hostSessionId ? { hostSessionId: source.hostSessionId } : {}),

    ...(source.kind ? { kind: source.kind } : {}),
    ...(source.pid != null ? { pid: source.pid } : {}),
    ...(source.canonicalTaskName ? { canonicalTaskName: source.canonicalTaskName } : {}),
    ...(source.parentCanonicalTaskName !== undefined ? { parentCanonicalTaskName: source.parentCanonicalTaskName } : {}),
    ...(source.parentId !== undefined ? { parentId: source.parentId } : {}),
    ...(source.timeoutMs != null ? { timeoutMs: source.timeoutMs } : {}),
    ...(source.waitMode ? { waitMode: source.waitMode } : {}),
    ...(source.waitReleased ? { waitReleased: source.waitReleased } : {}),
    ...(source.member ? { member: true } : {}),
  };
}

export function runtimeRegistryPath(artifactDir: string): string {
  return join(artifactDir, "subagent-runtime.json");
}

export function readRuntimeRecords(path: string): RuntimeRecord[] {
  try {
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(readFileSync(path, "utf8")) as RuntimeRegistry;
    if (parsed?.version !== 1 || !Array.isArray(parsed.records)) return [];
    return parsed.records.filter((record) =>
      record &&
      record.version === 1 &&
      typeof record.id === "string" &&
      typeof record.name === "string" &&
      typeof record.task === "string" &&
      (record.cohortId == null || typeof record.cohortId === "string") &&
      ((record.protocol as string | null | undefined) == null ||
        (record.protocol as string) === "legacy-v1" ||
        (record.protocol as string) === "codex-v2") &&
      (record.launchPlan == null || typeof record.launchPlan === "object") &&
      typeof record.surface === "string" &&
      typeof record.sessionFile === "string" &&
      typeof record.sentinelToken === "string" &&
      typeof record.startTime === "number" &&
      Number.isFinite(record.startTime) &&
      typeof record.interactive === "boolean" &&
      (record.agent == null || typeof record.agent === "string") &&
      (record.hostSessionId == null || typeof record.hostSessionId === "string") &&
      (record.activityFile == null || typeof record.activityFile === "string") &&
      (record.member == null || typeof record.member === "boolean") &&
      (record.pid == null || (typeof record.pid === "number" && Number.isInteger(record.pid) && record.pid > 0)) &&
      (record.canonicalTaskName == null || typeof record.canonicalTaskName === "string") &&
      (record.parentCanonicalTaskName == null || typeof record.parentCanonicalTaskName === "string") &&
      (record.parentId == null || typeof record.parentId === "string") &&
      (record.timeoutMs == null || (typeof record.timeoutMs === "number" && Number.isFinite(record.timeoutMs) && record.timeoutMs >= 1000)) &&
      (record.waitMode == null ||
        record.waitMode === "hard-barrier" ||
        record.waitMode === "interactive" ||
        record.waitMode === "member-round" ||
        record.waitMode === "recovered") &&
      (record.waitReleased == null || record.waitReleased === "escape" || record.waitReleased === "timeout"),
    );
  } catch {
    return [];
  }
}

function writeRuntimeRecords(path: string, records: RuntimeRecord[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ version: 1, records }), "utf8");
  renameSync(temp, path);
}

export function upsertRuntimeRecord(path: string, record: RuntimeRecord): void {
  const records = readRuntimeRecords(path).filter((item) => item.id !== record.id);
  writeRuntimeRecords(path, [...records, record]);
}

export function markRuntimeWaitReleased(
  path: string,
  id: string,
  waitReleased: SubagentWaitRelease,
): void {
  const records = readRuntimeRecords(path);
  if (!records.some((record) => record.id === id)) return;
  try {
    writeRuntimeRecords(
      path,
      records.map((record) => record.id === id ? { ...record, waitReleased } : record),
    );
  } catch (error) {
    debugLog(`Could not persist wait release for runtime record ${id}`, error);
  }
}

export function removeRuntimeRecord(path: string, id: string): void {
  const records = readRuntimeRecords(path).filter((item) => item.id !== id);
  if (records.length === 0) {
    try {
      writeRuntimeRecords(path, []);
    } catch (error) {

      debugLog(`Could not clear runtime registry ${path}`, error);
    }
    return;
  }
  try {
    writeRuntimeRecords(path, records);
  } catch (error) {

    debugLog(`Could not update runtime registry ${path}`, error);
  }
}
