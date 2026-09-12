// 运行态登记表：子代理内存运行态、保留名与磁盘运行记录的唯一持有者。
//
// 内存层（进程内运行态表 + 并行启动的保留名集合）是实时真源；磁盘层
// （<artifactDir>/subagent-runtime.json 运行记录）供宿主重载与会话恢复
// 重建。六类消费方（subagent / subagent_message / subagents_list /
// subagent_inspect / team_dispatch 与三个 watcher）只经这里的增删查接口
// 操作两层，不再各自直接读写 Map/Set 或运行记录文件。
//
// 三条不变量（与旧实现语义逐条对齐）：
//   - 内存优先于磁盘：恢复按内存 id 去重（recoverableRecords），inspect
//     同名时实时态覆盖磁盘记录（inspectableRecords）；
//   - 宿主重载移交：移除内存、保留磁盘记录（remove 的 keepRecord）；显式
//     stop 与正常终态：内存与磁盘记录一起删除（remove 默认）；
//   - 保留名在启动 finally 与各终态路径释放（reserveName/releaseName）。
//
// 进程管理不在这里：本模块只管登记与记录，watcher/startup 仍归 mod.ts。

import { resolve } from "node:path";
import { debugLog } from "./diagnostics.ts";
import { normalizeSubagentName } from "./names.ts";
import {
  createRuntimeRecord,
  markRuntimeWaitReleased,
  readRuntimeRecords,
  removeRuntimeRecord,
  runtimeRegistryPath,
  upsertRuntimeRecord,
  type RuntimeRecord,
} from "./runtime-registry.ts";
import type { RunningSubagent, SubagentWaitRelease } from "./types.ts";

export type { RuntimeRecord } from "./runtime-registry.ts";

/**
 * 登记表接口：内存运行态与保留名 + 磁盘运行记录的增删查。
 * 所有运行态读写都必须经这里；调用方拿到的是同一个登记表实例（mod.ts
 * 持有进程级单例，工具与 watcher 经依赖注入拿到同一个）。
 */
export interface RuntimeRegistry {
  // ── 内存运行态 ──

  /** 加入运行态：内存登记 + 落磁盘记录；磁盘失败只记调试日志，不撤销运行态。 */
  add(running: RunningSubagent): void;
  /** 仅内存接管（恢复/reload 重连：磁盘记录已存在，不重写）。 */
  track(running: RunningSubagent): void;
  /**
   * 移除运行态：默认连磁盘记录一起删；keepRecord 用于宿主重载/会话关闭的
   * 移交（内存删除、磁盘记录留给恢复路径）。recordPath 显式指定记录文件，
   * 缺省取内存实体的 runtimeFile。
   */
  remove(id: string, options?: { keepRecord?: boolean; recordPath?: string }): void;
  /** 只删磁盘记录（恢复路径清理尚未接管的记录；内存不动）。 */
  removeRecord(path: string, id: string): void;
  get(id: string): RunningSubagent | undefined;
  has(id: string): boolean;
  /** 进程内运行态快照（只读）。 */
  list(): RunningSubagent[];
  /** 按名精确查运行态（查询名按 spawn/resume 同一规则归一）。 */
  findByName(name: string): RunningSubagent | undefined;
  /** 按会话文件查运行态（resume 去重用路径比较）。 */
  findBySessionFile(sessionFile: string): RunningSubagent | undefined;
  /** 按名解析：唯一命中返回 running；未命中/歧义返回带提示的错误。 */
  resolveName(name: string): { running: RunningSubagent } | { error: string };
  /** 清空进程内运行态（会话关闭；保留名与磁盘记录不动）。 */
  clear(): void;

  // ── 名字保留 ──

  /** 并行 spawn 在启动前的同步占位（注册后由调用方释放）。 */
  reserveName(name: string): void;
  releaseName(name: string): void;
  isNameReserved(name: string): boolean;
  /** 名字是否已被运行态或保留名占用。 */
  isNameTaken(name: string): boolean;
  /** 取一个唯一名：避开运行态、保留名与额外的已占用集合。 */
  uniqueName(base: string, extraTaken?: Iterable<string>): string;

  // ── 磁盘运行记录 ──

  /** 会话 artifact 目录下的登记文件路径。 */
  pathFor(artifactDir: string): string;
  /** 原始读取磁盘记录。 */
  readRecords(path: string): RuntimeRecord[];
  /** 运行态 → 可持久化记录（可持久化字段增删只在这一处同步）。 */
  createRecord(running: RunningSubagent): RuntimeRecord;
  /** 显式写入一条磁盘记录（add 之外的补写；格式非法记录由 readRecords 过滤）。 */
  upsertRecord(path: string, record: RuntimeRecord): void;
  /** 恢复视图：磁盘记录中内存没有的（按 id 去重，内存优先）。 */
  recoverableRecords(path: string): RuntimeRecord[];
  /** 观测视图：磁盘记录中名字未被实时运行态占用的（inspect 内存优先）。 */
  inspectableRecords(path: string): RuntimeRecord[];
  /** 更新仍在登记中的等待释放原因；记录已被移除时不重建。 */
  markWaitReleased(path: string, id: string, released: SubagentWaitRelease): void;
}

export function createRuntimeRegistry(): RuntimeRegistry {
  const running = new Map<string, RunningSubagent>();
  const reserved = new Set<string>();

  return {
    add(candidate) {
      running.set(candidate.id, candidate);
      try {
        upsertRuntimeRecord(candidate.runtimeFile, createRuntimeRecord(candidate));
      } catch (error) {
        // 运行态记录失败不撤销已启动的子代理；watcher 仍负责当前进程。
        debugLog(`Could not persist runtime record for ${candidate.name}`, error);
      }
    },
    track(candidate) {
      running.set(candidate.id, candidate);
    },
    remove(id, options) {
      const recordPath = options?.recordPath ?? running.get(id)?.runtimeFile;
      running.delete(id);
      if (options?.keepRecord || !recordPath) return;
      removeRuntimeRecord(recordPath, id);
    },
    removeRecord(path, id) {
      removeRuntimeRecord(path, id);
    },
    get(id) {
      return running.get(id);
    },
    has(id) {
      return running.has(id);
    },
    list() {
      return Array.from(running.values());
    },
    findByName(name) {
      const normalized = normalizeSubagentName(name, "");
      if (!normalized) return undefined;
      return Array.from(running.values()).find((candidate) => candidate.name === normalized);
    },
    findBySessionFile(sessionFile) {
      const target = resolve(sessionFile);
      return Array.from(running.values()).find((candidate) => resolve(candidate.sessionFile) === target);
    },
    resolveName(name) {
      // 与 spawn/resume 同一 normalize 规则,多余空白/大小写差异不导致寻址失败;
      // 空名仍报错(fallback 传空串,不默认成 "subagent")。
      const requestedName = normalizeSubagentName(name, "");
      if (!requestedName) {
        return { error: "Provide the exact display name of a running subagent." };
      }

      const matches = Array.from(running.values()).filter((candidate) => candidate.name === requestedName);
      if (matches.length === 1) return { running: matches[0] };
      if (matches.length === 0) {
        const names = Array.from(running.values()).map((candidate) => candidate.name);
        const hint = names.length
          ? ` Currently running: ${[...new Set(names)].join(", ")}.`
          : " No subagents are currently running.";
        return { error: `No running subagent named "${requestedName}".${hint}` };
      }

      const candidates = matches.map((candidate) => `${candidate.name} [${candidate.id}]`).join(", ");
      return { error: `Ambiguous subagent name "${requestedName}". Matches: ${candidates}` };
    },
    clear() {
      running.clear();
    },

    reserveName(name) {
      reserved.add(name);
    },
    releaseName(name) {
      reserved.delete(name);
    },
    isNameReserved(name) {
      return reserved.has(name);
    },
    isNameTaken(name) {
      if (reserved.has(name)) return true;
      return Array.from(running.values()).some((candidate) => candidate.name === name);
    },
    uniqueName(base, extraTaken) {
      const taken = new Set(Array.from(running.values()).map((candidate) => candidate.name));
      for (const reservedName of reserved) taken.add(reservedName);
      if (extraTaken) for (const name of extraTaken) taken.add(name);
      if (!taken.has(base)) return base;
      let n = 2;
      while (taken.has(`${base}-${n}`)) n++;
      return `${base}-${n}`;
    },

    pathFor(artifactDir) {
      return runtimeRegistryPath(artifactDir);
    },
    readRecords(path) {
      return readRuntimeRecords(path);
    },
    createRecord(source) {
      return createRuntimeRecord(source);
    },
    upsertRecord(path, record) {
      upsertRuntimeRecord(path, record);
    },
    recoverableRecords(path) {
      return readRuntimeRecords(path).filter((record) => !running.has(record.id));
    },
    inspectableRecords(path) {
      const liveNames = new Set(Array.from(running.values()).map((candidate) => candidate.name));
      return readRuntimeRecords(path).filter((record) => !liveNames.has(record.name));
    },
    markWaitReleased(path, id, released) {
      markRuntimeWaitReleased(path, id, released);
    },
  };
}
