import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { debugLog } from "./diagnostics.ts";
import type { SubagentWaitMode, SubagentWaitRelease } from "./types.ts";

export interface RuntimeRecord {
  version: 1;
  id: string;
  name: string;
  task: string;
  /** 仅用于展示和结果聚合的并行分组标签。 */
  cohortId?: string;
  agent?: string;
  surface: string;
  startTime: number;
  sessionFile: string;
  activityFile?: string;
  sentinelToken: string;
  interactive: boolean;
  /**
   * 发起本次运行的宿主会话 id（工单 32）：/reload 或会话切换后恢复的运行时用它
   * 把终态统计归回发起会话；缺省（旧记录）按恢复时刻的当前会话处理。
   */
  hostSessionId?: string | null;
  /** 运行载体;缺省(旧记录)按 "pane" 处理。 */
  kind?: "pane" | "headless";
  /** headless 运行的子进程 PID,用于 /reload 后探测存活性。 */
  pid?: number;
  /** 直接父子代理 run id;顶层子代理为 null。 */
  parentId?: string | null;
  /** 本次硬屏障等待上限(毫秒)。 */
  timeoutMs?: number;
  /** 启动时的等待载体,供 /reload 后状态观测。 */
  waitMode?: SubagentWaitMode;
  /** 主工具等待已被 Escape/timeout 解除,子代理仍在运行。 */
  waitReleased?: SubagentWaitRelease;
  /** 持久团队成员(member: true):常驻 headless,恢复路径按 offline 处理。 */
  member?: boolean;
}

interface RuntimeRegistry {
  version: 1;
  records: RuntimeRecord[];
}

export type RuntimeSource = Omit<RuntimeRecord, "version">;

/**
 * 从运行中的 RunningSubagent 挑选可持久化字段构造记录。
 * 显式挑选而非展开:running 上挂着 statusState/headlessChild 等运行时对象
 * (ChildProcess 存在循环引用),整体展开会让 JSON.stringify 炸掉。
 */
export function createRuntimeRecord(source: RuntimeSource): RuntimeRecord {
  return {
    version: 1,
    id: source.id,
    name: source.name,
    task: source.task,
    ...(source.cohortId ? { cohortId: source.cohortId } : {}),
    ...(source.agent ? { agent: source.agent } : {}),
    surface: source.surface,
    startTime: source.startTime,
    sessionFile: source.sessionFile,
    ...(source.activityFile ? { activityFile: source.activityFile } : {}),
    sentinelToken: source.sentinelToken,
    interactive: source.interactive,
    ...(source.hostSessionId ? { hostSessionId: source.hostSessionId } : {}),
    // （hostSessionId 的空值统一按缺省落盘：它不需要「显式 null」这一档，缺省即表达未绑定；
    // parentId 则用 null 表达「顶层子代理」，两者语义不同。）
    ...(source.kind ? { kind: source.kind } : {}),
    ...(source.pid != null ? { pid: source.pid } : {}),
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

/** 更新仍在登记中的等待释放原因;记录已被 watcher 移除时不重新创建。 */
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
      // 运行态清理失败不能覆盖已经取得的子代理结果。
      debugLog(`Could not clear runtime registry ${path}`, error);
    }
    return;
  }
  try {
    writeRuntimeRecords(path, records);
  } catch (error) {
    // watcher 清理是尽力而为，失败不会改变主会话结果。
    debugLog(`Could not update runtime registry ${path}`, error);
  }
}
