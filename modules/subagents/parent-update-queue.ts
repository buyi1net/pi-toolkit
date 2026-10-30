import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/** 父会话更新的三种可观察类型。 */
export type ParentUpdateKind = "message" | "status" | "terminal";

/** 队列中持久化的单条更新；字段名与 wait_agent 的公开投影一致。 */
export interface ParentSessionUpdate {
  agent_id: string;
  task_name: string;
  kind: ParentUpdateKind;
  status: string;
  summary: string;
  update_id: string;
  update_seq: number;
  /** 终态摘要与最终正文回注共用的稳定传输幂等键。 */
  delivery_id: string;
  /** 终态完整正文的可选存储投影；不会改变摘要更新本身。 */
  final_text?: string;
}

export interface ParentUpdateInput {
  agent_id: string;
  task_name: string;
  kind: ParentUpdateKind;
  status: string;
  summary: string;
  /** 重试同一逻辑事件时必须复用；省略则生成新的逻辑事件。 */
  update_id?: string;
  /** 只有终态更新可以携带最终正文。 */
  final_text?: string;
}

export interface ParentUpdateQueueState {
  version: 1;
  next_update_seq: number;
  cursor: number;
  updates: ParentSessionUpdate[];
  deliveries: Record<string, string>;
  wait_owner: string | null;
  /** lease 到期后允许重载后的新 owner 接管，避免宿主崩溃永久锁死。 */
  wait_owner_expires_at: number | null;
}

export interface WaitInProgressError extends Error {
  code: "wait_in_progress";
  owner: string;
}

export interface ParentUpdateQueue {
  /** 追加一条逻辑事件；重复结构化键返回已有事件，不消耗新序号。 */
  publish(input: ParentUpdateInput): ParentSessionUpdate;
  /** 取出游标后的第一条更新；不会推进游标，适合取出/确认之间可重载的等待接缝。 */
  peek(): ParentSessionUpdate | null;
  /** 确认已经回报的更新并推进持久化游标；重复确认幂等。兼容旧的一参调用。 */
  acknowledge(agent_id: string, update_id?: string): boolean;
  /** 当前消费位置和序号均从磁盘重新读取。 */
  reload(): void;
  /** 当前队列的只读快照。 */
  snapshot(): ParentUpdateQueueState;
  /** 为同一代理的同一逻辑回注取稳定 delivery_id；重载和重试都复用。兼容旧的一参调用。 */
  deliveryId(agent_id: string, update_id?: string): string | null;
  /** 建立父会话唯一未完成等待接缝；过期 owner 可被新调用接管。 */
  beginWait(owner?: string, leaseMs?: number): string;
  /** 释放等待接缝；仅持有者可释放。 */
  endWait(token: string): boolean;
  /** 明确等待是否被占用。 */
  isWaiting(): boolean;
}

export interface ParentUpdateQueuePaths {
  stateFile: string;
}

const STATE_VERSION = 1 as const;
const DEFAULT_OWNER = "wait_agent";
const DEFAULT_WAIT_LEASE_MS = 5 * 60_000;

export function parentUpdateQueuePath(artifactDir: string): string {
  return join(artifactDir, "parent-updates.json");
}

function emptyState(): ParentUpdateQueueState {
  return { version: STATE_VERSION, next_update_seq: 1, cursor: 0, updates: [], deliveries: {}, wait_owner: null, wait_owner_expires_at: null };
}

function validKind(value: unknown): value is ParentUpdateKind {
  return value === "message" || value === "status" || value === "terminal";
}

function updateKey(agent_id: string, update_id: string): string {
  return `${agent_id}\u0000${update_id}`;
}

function readState(path: string): ParentUpdateQueueState {
  try {
    if (!existsSync(path)) return emptyState();
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ParentUpdateQueueState>;
    if (parsed.version !== STATE_VERSION || !Array.isArray(parsed.updates)) return emptyState();
    const updates = parsed.updates.filter((item): item is ParentSessionUpdate =>
      !!item && typeof item.agent_id === "string" && typeof item.task_name === "string" &&
      validKind(item.kind) && typeof item.status === "string" && typeof item.summary === "string" &&
      typeof item.update_id === "string" && item.update_id.length > 0 &&
      typeof item.update_seq === "number" && Number.isSafeInteger(item.update_seq) && item.update_seq > 0 &&
      typeof item.delivery_id === "string" && item.delivery_id.length > 0 &&
      (item.final_text == null || typeof item.final_text === "string"),
    );
    const next = typeof parsed.next_update_seq === "number" && Number.isSafeInteger(parsed.next_update_seq) && parsed.next_update_seq > 0
      ? parsed.next_update_seq : (updates.reduce((max, item) => Math.max(max, item.update_seq), 0) + 1);
    const maxCursor = updates.length ? Math.max(...updates.map((item) => item.update_seq)) : 0;
    const cursor = typeof parsed.cursor === "number" && Number.isSafeInteger(parsed.cursor)
      ? Math.min(Math.max(0, parsed.cursor), maxCursor) : 0;
    const parsedDeliveries = parsed.deliveries && typeof parsed.deliveries === "object" ? parsed.deliveries : {};
    const deliveries: Record<string, string> = {};
    const usedDeliveryIds = new Set<string>();
    for (const item of updates) {
      const key = updateKey(item.agent_id, item.update_id);
      const legacy = (parsedDeliveries as Record<string, unknown>)[item.update_id];
      const candidate = (parsedDeliveries as Record<string, unknown>)[key];
      const delivery = typeof candidate === "string" ? candidate : typeof legacy === "string" && !usedDeliveryIds.has(legacy) ? legacy : `delivery-${item.agent_id}-${item.update_id}`;
      deliveries[key] = delivery;
      usedDeliveryIds.add(delivery);
    }
    for (const [key, value] of Object.entries(parsedDeliveries)) {
      if (key.includes("\u0000") && typeof value === "string") deliveries[key] = value;
    }
    return {
      version: STATE_VERSION,
      next_update_seq: next,
      cursor,
      updates: updates.sort((a, b) => a.update_seq - b.update_seq),
      deliveries,
      wait_owner: typeof parsed.wait_owner === "string" ? parsed.wait_owner : null,
      wait_owner_expires_at: typeof parsed.wait_owner_expires_at === "number" && Number.isFinite(parsed.wait_owner_expires_at) ? parsed.wait_owner_expires_at : null,
    };
  } catch {
    return emptyState();
  }
}

function writeState(path: string, state: ParentUpdateQueueState): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
  renameSync(temp, path);
}

function waitError(owner: string): WaitInProgressError {
  const error = new Error("A wait_agent call is already in progress for this parent session.") as WaitInProgressError;
  error.code = "wait_in_progress";
  error.owner = owner;
  return error;
}

export function createParentUpdateQueue(paths: ParentUpdateQueuePaths | string): ParentUpdateQueue {
  const stateFile = typeof paths === "string"
    ? (paths.endsWith("parent-updates.json") ? paths : parentUpdateQueuePath(paths))
    : paths.stateFile;
  let state = readState(stateFile);
  const persist = () => writeState(stateFile, state);
  const refresh = () => { state = readState(stateFile); };

  return {
    publish(input) {
      refresh();
      const existing = input.update_id
        ? state.updates.find((item) => item.agent_id === input.agent_id && item.update_id === input.update_id)
        : undefined;
      if (existing) {
        if (input.kind !== "terminal" || input.final_text == null || existing.final_text === input.final_text) return { ...existing };
        // 同一个终态逻辑事件允许迟到补齐正文，但不得改动序号或 delivery_id。
        existing.final_text = input.final_text;
        persist();
        return { ...existing };
      }
      if (input.kind === "terminal" && input.final_text == null) {
        // 摘要可以先入队；正文由后续同 update_id 的 publish 补齐。
      }
      const updateId = input.update_id ?? randomUUID();
      const key = updateKey(input.agent_id, updateId);
      const conflicting = state.updates.some((item) => item.update_id === updateId && item.agent_id !== input.agent_id);
      const deliveryId = state.deliveries[key] ?? (conflicting ? `delivery-${input.agent_id}-${updateId}` : `delivery-${updateId}`);
      const update: ParentSessionUpdate = {
        agent_id: input.agent_id,
        task_name: input.task_name,
        kind: input.kind,
        status: input.status,
        summary: input.summary,
        update_id: updateId,
        update_seq: state.next_update_seq++,
        delivery_id: deliveryId,
        ...(input.final_text != null ? { final_text: input.final_text } : {}),
      };
      state.deliveries[key] = deliveryId;
      state.updates.push(update);
      persist();
      return { ...update };
    },
    peek() {
      refresh();
      return state.updates.find((item) => item.update_seq > state.cursor) ?? null;
    },
    acknowledge(agent_id, requestedUpdateId) {
      refresh();
      const legacyCall = requestedUpdateId === undefined;
      const update_id = requestedUpdateId ?? agent_id;
      const update = state.updates.find((item) => legacyCall ? item.update_id === update_id : item.agent_id === agent_id && item.update_id === update_id);
      if (!update || update.update_seq <= state.cursor) return !!update;
      // 只允许按序确认，避免跳过尚未返回的更新。
      const next = state.updates.find((item) => item.update_seq > state.cursor);
      if (!next || next.update_seq !== update.update_seq) return false;
      state.cursor = update.update_seq;
      persist();
      return true;
    },
    reload() { refresh(); },
    snapshot() { refresh(); return JSON.parse(JSON.stringify(state)) as ParentUpdateQueueState; },
    deliveryId(agent_id, requestedUpdateId) {
      refresh();
      const legacyCall = requestedUpdateId === undefined;
      const update_id = requestedUpdateId ?? agent_id;
      const update = state.updates.find((item) => legacyCall ? item.update_id === update_id : item.agent_id === agent_id && item.update_id === update_id);
      return update ? state.deliveries[updateKey(update.agent_id, update.update_id)] ?? update.delivery_id : null;
    },
    beginWait(owner = DEFAULT_OWNER, leaseMs = DEFAULT_WAIT_LEASE_MS) {
      refresh();
      const now = Date.now();
      if (state.wait_owner && state.wait_owner_expires_at != null && state.wait_owner_expires_at > now) throw waitError(state.wait_owner);
      const token = `${owner}:${randomUUID()}`;
      state.wait_owner = token;
      state.wait_owner_expires_at = now + Math.max(1, leaseMs);
      persist();
      return token;
    },
    endWait(token) {
      refresh();
      if (state.wait_owner !== token) return false;
      state.wait_owner = null;
      state.wait_owner_expires_at = null;
      persist();
      return true;
    },
    isWaiting() { refresh(); return state.wait_owner !== null && (state.wait_owner_expires_at == null || state.wait_owner_expires_at > Date.now()); },
  };
}

/** 事件生产接缝：生命周期实现只需调用对应方法，不重复编排序号和幂等。 */
export interface ParentUpdateProducers {
  spawnStatus(input: Omit<ParentUpdateInput, "kind">): ParentSessionUpdate;
  message(input: Omit<ParentUpdateInput, "kind">): ParentSessionUpdate;
  followupStatus(input: Omit<ParentUpdateInput, "kind">): ParentSessionUpdate;
  interruptStatus(input: Omit<ParentUpdateInput, "kind">): ParentSessionUpdate;
  watcherTerminal(input: Omit<ParentUpdateInput, "kind">): ParentSessionUpdate;
  surfaceClosed(input: Omit<ParentUpdateInput, "kind">): ParentSessionUpdate;
}

export function createParentUpdateProducers(queue: ParentUpdateQueue): ParentUpdateProducers {
  const status = (input: Omit<ParentUpdateInput, "kind">) => queue.publish({ ...input, kind: "status" });
  return {
    spawnStatus: status,
    followupStatus: status,
    interruptStatus: status,
    watcherTerminal: (input) => queue.publish({ ...input, kind: "terminal" }),
    surfaceClosed: (input) => queue.publish({ ...input, kind: "terminal" }),
    message: (input) => queue.publish({ ...input, kind: "message" }),
  };
}

export const PARENT_UPDATE_PRODUCER_EVENTS = {
  spawnStatus: "spawn_agent.starting",
  watcherTerminal: "watcher.terminal",
  followupStatus: "followup_task.status",
  interruptStatus: "interrupt_agent.status",
  surfaceClosed: "surface.closed",
  message: "send_message.message",
} as const;
