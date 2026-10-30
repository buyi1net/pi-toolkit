import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createParentUpdateQueue, type ParentSessionUpdate } from "./parent-update-queue.ts";

/** wait_agent 的公开时限边界；工具 schema 与运行时校验共用这组值。 */
export const WAIT_AGENT_DEFAULT_TIMEOUT_MS = 30_000;
export const WAIT_AGENT_MIN_TIMEOUT_MS = 1_000;
export const WAIT_AGENT_MAX_TIMEOUT_MS = 120_000;

export interface WaitAgentToolDeps {
  readonly getArtifactDir: (sessionDir: string, sessionId: string) => string;
  /** 测试接缝；生产默认短轮询以观察 watcher 写入的持久化队列。 */
  readonly pollIntervalMs?: number;
}

interface WaitAgentResult {
  message: string;
  timed_out: boolean;
  update: {
    update_id: string;
    update_seq: number;
    agent_id: string;
    task_name: string;
    kind: ParentSessionUpdate["kind"];
    status: string;
    summary: string;
  } | null;
}

function result(value: WaitAgentResult, details: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details: { ...value, ...details },
  };
}

function projectUpdate(update: ParentSessionUpdate): NonNullable<WaitAgentResult["update"]> {
  // final_text 属于独立宿主回注投影，不能随 terminal 摘要经 wait_agent 返回。
  return {
    update_id: update.update_id,
    update_seq: update.update_seq,
    agent_id: update.agent_id,
    task_name: update.task_name,
    kind: update.kind,
    status: update.status,
    summary: update.summary,
  };
}

function waitForUpdate(
  queue: ReturnType<typeof createParentUpdateQueue>,
  timeoutMs: number,
  pollIntervalMs: number,
  signal?: AbortSignal,
): Promise<ParentSessionUpdate | null> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let poller: ReturnType<typeof setTimeout> | undefined;
    const finish = (update: ParentSessionUpdate | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (poller) clearTimeout(poller);
      signal?.removeEventListener("abort", onAbort);
      resolve(update);
    };
    const onAbort = () => finish(null);
    const poll = () => {
      const update = queue.peek();
      if (update) {
        finish(update);
        return;
      }
      const remaining = timeoutMs - (Date.now() - startedAt);
      if (remaining <= 0) {
        finish(null);
        return;
      }
      poller = setTimeout(poll, Math.min(pollIntervalMs, remaining));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => finish(null), timeoutMs);
    poll();
  });
}

/** 注册只等待当前父会话更新队列的 Codex v2 wait_agent 工具。 */
export function registerWaitAgentTool(pi: ExtensionAPI, deps: WaitAgentToolDeps): void {
  pi.registerTool({
    name: "wait_agent",
    label: "Wait Agent",
    description:
      "Wait for the next update in the current parent session queue. " +
      "This does not take a target list and a timeout never cancels a sub-agent. " +
      "Read the returned update to identify its agent and event kind.",
    promptSnippet: "Wait for one new parent-session agent update without cancelling agents on timeout.",
    parameters: Type.Object({
      timeout_ms: Type.Optional(Type.Integer({
        default: WAIT_AGENT_DEFAULT_TIMEOUT_MS,
        minimum: WAIT_AGENT_MIN_TIMEOUT_MS,
        maximum: WAIT_AGENT_MAX_TIMEOUT_MS,
      })),
    }),
    async execute(_toolCallId, raw, signal, _onUpdate, ctx: ExtensionContext) {
      const requested = (raw as { timeout_ms?: unknown } | undefined)?.timeout_ms;
      const timeoutMs = requested === undefined ? WAIT_AGENT_DEFAULT_TIMEOUT_MS : requested;
      if (
        typeof timeoutMs !== "number" ||
        !Number.isInteger(timeoutMs) ||
        timeoutMs < WAIT_AGENT_MIN_TIMEOUT_MS ||
        timeoutMs > WAIT_AGENT_MAX_TIMEOUT_MS
      ) {
        return result(
          { message: "Invalid timeout_ms.", timed_out: false, update: null },
          {
            code: "invalid_params",
            details: { timeout_ms: `must be an integer from ${WAIT_AGENT_MIN_TIMEOUT_MS} to ${WAIT_AGENT_MAX_TIMEOUT_MS}` },
          },
        );
      }

      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        return result(
          { message: "A persistent parent session is required.", timed_out: false, update: null },
          { code: "context_unavailable" },
        );
      }
      const artifactDir = deps.getArtifactDir(ctx.sessionManager.getSessionDir(), ctx.sessionManager.getSessionId());
      const queue = createParentUpdateQueue(artifactDir);
      let waitToken: string;
      try {
        waitToken = queue.beginWait();
      } catch (error) {
        if ((error as { code?: string }).code === "wait_in_progress") {
          return result(
            { message: "Another wait_agent call is already in progress.", timed_out: false, update: null },
            { code: "wait_in_progress" },
          );
        }
        throw error;
      }

      try {
        const update = await waitForUpdate(
          queue,
          timeoutMs,
          Math.max(1, deps.pollIntervalMs ?? 25),
          signal,
        );
        if (!update) {
          if (signal?.aborted) {
            return result({ message: "wait_agent was cancelled by the host.", timed_out: false, update: null }, { code: "cancelled", status: "aborted" });
          }
          return result({ message: "No parent-session update arrived before the timeout.", timed_out: true, update: null });
        }
        queue.acknowledge(update.agent_id, update.update_id);
        return result({
          message: `Received ${update.kind} update from ${update.task_name}.`,
          timed_out: false,
          update: projectUpdate(update),
        });
      } finally {
        queue.endWait(waitToken);
      }
    },
  });
}
