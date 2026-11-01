import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { debugLog } from "./diagnostics.ts";
import { normalizeSubagentName } from "./names.ts";
import {
  createRuntimeRecord,
  markRuntimeWaitReleased,
  markRuntimeInterrupted,
  readRuntimeRecords,
  removeRuntimeRecord,
  removeRuntimeRecordsForSession,
  runtimeRegistryPath,
  upsertRuntimeRecord,
  type RuntimeRecord,
} from "./runtime-registry.ts";
import type { RunningSubagent, SubagentWaitRelease } from "./types.ts";

export type { RuntimeRecord } from "./runtime-registry.ts";

export type PublicAgentStatus =
  | "starting" | "running" | "waiting" | "completed" | "failed" | "interrupted" | "handed_off" | "closed";

export interface PublicAgentRecord {
  agent_id: string;
  task_name: string;
  canonical_task_name: string;
  status: PublicAgentStatus;
  parent_agent_id: string | null;
  parent_canonical_task_name: string | null;
  summary: string;
  updated_at: number;
}

export interface RuntimeRegistry {

  publicPathFor(artifactDir: string): string;
  listPublic(path: string): PublicAgentRecord[];
  updatePublic(path: string, record: PublicAgentRecord): void;
  updatePublicStatus(path: string, id: string, status: PublicAgentStatus, summary?: string): void;

  add(running: RunningSubagent): void;

  track(running: RunningSubagent): void;

  remove(id: string, options?: { keepRecord?: boolean; recordPath?: string }): void;

  removeRecord(path: string, id: string): void;
  removeRecordsForSession(path: string, sessionFile: string): void;
  get(id: string): RunningSubagent | undefined;
  has(id: string): boolean;

  list(): RunningSubagent[];

  findByName(name: string): RunningSubagent | undefined;

  findBySessionFile(sessionFile: string): RunningSubagent | undefined;

  resolveName(name: string): { running: RunningSubagent } | { error: string };

  clear(): void;

  reserveName(name: string): void;
  releaseName(name: string): void;
  isNameReserved(name: string): boolean;

  isNameTaken(name: string): boolean;

  uniqueName(base: string, extraTaken?: Iterable<string>): string;

  pathFor(artifactDir: string): string;

  readRecords(path: string): RuntimeRecord[];

  createRecord(running: RunningSubagent): RuntimeRecord;

  upsertRecord(path: string, record: RuntimeRecord): void;

  recoverableRecords(path: string): RuntimeRecord[];

  inspectableRecords(path: string): RuntimeRecord[];

  markWaitReleased(path: string, id: string, released: SubagentWaitRelease): void;

  markInterrupted(path: string, id: string): void;
}

export function createRuntimeRegistry(): RuntimeRegistry {
  const running = new Map<string, RunningSubagent>();
  const reserved = new Set<string>();
  const publicPathFor = (artifactDir: string): string => resolve(artifactDir, "subagent-public.json");
  const readPublic = (path: string): PublicAgentRecord[] => {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((record): record is PublicAgentRecord => {
        const value = record as any;
        return value && typeof value.agent_id === "string" && typeof value.task_name === "string" &&
          typeof value.canonical_task_name === "string" &&
          ["starting", "running", "waiting", "completed", "failed", "interrupted", "handed_off", "closed"].includes(value.status) &&
          (value.parent_agent_id == null || typeof value.parent_agent_id === "string") &&
          (value.parent_canonical_task_name == null || typeof value.parent_canonical_task_name === "string") &&
          typeof value.summary === "string" && typeof value.updated_at === "number";
      });
    } catch { return []; }
  };
  const writePublic = (path: string, records: PublicAgentRecord[]): void => {
    mkdirSync(resolve(path, ".."), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(records), { encoding: "utf8", mode: 0o600 });
    renameSync(temp, path);
  };
  const persistPublic = (path: string, record: PublicAgentRecord): void => {
    try {
      writePublic(path, [...readPublic(path).filter((item) => item.agent_id !== record.agent_id), record]);
    } catch (error) {
      debugLog(`Could not persist public agent record for ${record.task_name}`, error);
    }
  };

  return {
    publicPathFor,
    listPublic(path) {
      return readPublic(path).map((record) => ({ ...record }));
    },
    updatePublic(path, record) {
      persistPublic(path, { ...record });
    },
    updatePublicStatus(path, id, status, summary) {
      const records = readPublic(path);
      const index = records.findIndex((record) => record.agent_id === id);
      if (index < 0) return;
      const current = records[index]!;
      persistPublic(path, {
        ...current,
        status,
        ...(summary !== undefined ? { summary } : {}),
        updated_at: Date.now(),
      });
    },
    add(candidate) {
      running.set(candidate.id, candidate);
      try {
        upsertRuntimeRecord(candidate.runtimeFile, createRuntimeRecord(candidate));
      } catch (error) {
        debugLog(`Could not persist runtime record for ${candidate.name}`, error);
      }
      if (typeof candidate.runtimeFile !== "string") return;
      const publicPath = publicPathFor(resolve(candidate.runtimeFile, ".."));
      const canonical = candidate.canonicalTaskName ?? `${process.env.PI_SUBAGENT_TASK_PATH?.trim() || "/root"}/${candidate.name}`;
      persistPublic(publicPath, {
        agent_id: candidate.id,
        task_name: candidate.name,
        canonical_task_name: canonical,
        status: "running",
        parent_agent_id: candidate.parentId ?? null,
        parent_canonical_task_name: candidate.parentCanonicalTaskName ?? null,
        summary: candidate.task.replace(/\s+/g, " ").trim().slice(0, 120),
        updated_at: Date.now(),
      });
    },
    track(candidate) {
      running.set(candidate.id, candidate);
      if (typeof candidate.runtimeFile !== "string") return;
      const path = publicPathFor(resolve(candidate.runtimeFile, ".."));
      const records = readPublic(path);
      const current = records.find((record) => record.agent_id === candidate.id);
      if (current) persistPublic(path, { ...current, status: "running", updated_at: Date.now() });
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
    removeRecordsForSession(path, sessionFile) {
      removeRuntimeRecordsForSession(path, sessionFile);
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
    markInterrupted(path, id) {
      markRuntimeInterrupted(path, id);
    },
  };
}
