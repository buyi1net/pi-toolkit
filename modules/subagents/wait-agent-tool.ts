import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createParentUpdateQueue, type ParentSessionUpdate } from "./parent-update-queue.ts";
import type { RuntimeRegistry } from "./registry.ts";
import type { SubagentsTranslate } from "./messages/index.ts";
import { compactRenderText, renderToolCardCall, renderToolCardResult } from "../../kit/tool-card.ts";

export const WAIT_AGENT_DEFAULT_TIMEOUT_MS = 30_000;
export const WAIT_AGENT_MIN_TIMEOUT_MS = 1_000;
export const WAIT_AGENT_MAX_TIMEOUT_MS = 120_000;

export interface WaitAgentToolDeps {
  readonly getArtifactDir: (sessionDir: string, sessionId: string) => string;
  readonly registry: RuntimeRegistry;

  readonly pollIntervalMs?: number;
  readonly t?: SubagentsTranslate;
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
  const isError = typeof details.code === "string";
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details: { ...value, ...details },
    ...(isError ? { isError: true } : {}),
  };
}

function projectUpdate(update: ParentSessionUpdate): NonNullable<WaitAgentResult["update"]> {

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

function collapsedRenderText(value: unknown, maxWidth: number): string {
  return truncateToWidth(compactRenderText(value), maxWidth, "…");
}

function waitStatusText(status: string, t?: SubagentsTranslate): string {
  switch (status) {
    case "starting": return t?.("module.subagents.widget.status.starting") ?? "starting";
    case "running": return t?.("module.subagents.widget.status.running") ?? "running";
    case "waiting": return t?.("module.subagents.widget.status.waiting") ?? "waiting";
    case "completed": return t?.("module.subagents.widget.result.completed") ?? "completed";
    case "failed": return t?.("module.subagents.widget.result.failed") ?? "failed";
    case "interrupted": return t?.("module.subagents.widget.result.cancelled") ?? "cancelled";
    case "handed_off": return t?.("module.subagents.tool.wait_agent.result.status.handedOff") ?? "handed off";
    default: return status;
  }
}

function waitNoUpdateMessage(
  details: Partial<WaitAgentResult> & { code?: unknown },
  t?: SubagentsTranslate,
): string {
  if (details.timed_out === true) return t?.("module.subagents.tool.wait_agent.result.timeout") ?? "Timed out waiting for a subagent update";
  switch (details.code) {
    case "cancelled": return t?.("module.subagents.tool.wait_agent.result.cancelled") ?? "Wait cancelled";
    case "no_running_agents": return t?.("module.subagents.tool.wait_agent.result.noRunningAgents") ?? "No subagents are currently running";
    case "wait_in_progress": return t?.("module.subagents.tool.wait_agent.result.waitInProgress") ?? "Another wait is already in progress";
    case "invalid_params": return t?.("module.subagents.tool.wait_agent.result.invalidParams") ?? "Invalid wait parameters";
    case "context_unavailable": return t?.("module.subagents.tool.wait_agent.result.contextUnavailable") ?? "Parent session is unavailable";
    default: return t?.("module.subagents.tool.wait_agent.result.noUpdate") ?? "No subagent update received";
  }
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

export function registerWaitAgentTool(pi: ExtensionAPI, deps: WaitAgentToolDeps): void {
  pi.registerTool({
    name: "wait_agent",
    label: "Wait Agent",
    renderShell: "self",
    description:
      "Wait for the next update in the current parent session queue. " +
      "This does not take a target list and a timeout never cancels a sub-agent. " +
      "Read the returned update to identify its agent and event kind. " +
      "This cannot wait for peers_send replies; those messages arrive automatically, so do not use wait_agent or repeatedly poll peers_list.",
    promptSnippet: "Wait for one new parent-session agent update without cancelling agents on timeout.",
    parameters: Type.Object({
      timeout_ms: Type.Optional(Type.Integer({
        default: WAIT_AGENT_DEFAULT_TIMEOUT_MS,
        minimum: WAIT_AGENT_MIN_TIMEOUT_MS,
        maximum: WAIT_AGENT_MAX_TIMEOUT_MS,
      })),
    }),
    renderCall(_args, theme, context) {
      return renderToolCardCall(
        { title: deps.t?.("module.subagents.tool.wait_agent.display") ?? "Wait for subagent" },
        theme,
        context,
      );
    },
    renderResult(result, options, theme, context) {
      const details = result.details as Partial<WaitAgentResult> & {
        code?: unknown;
      } | undefined;
      const update = details?.update;
      if (!update) {
        const message = waitNoUpdateMessage(details ?? {}, deps.t);
        return renderToolCardResult(
          { title: deps.t?.("module.subagents.tool.wait_agent.display") ?? "Wait for subagent", status: options.expanded ? message : collapsedRenderText(message, 48) },
          theme,
          options,
          context,
        );
      }
      const fullTaskName = compactRenderText(update.task_name) || "subagent";
      const taskName = options.expanded ? fullTaskName : collapsedRenderText(fullTaskName, 20);
      const statusCode = compactRenderText(update.status) || "unknown";
      const status = waitStatusText(statusCode, deps.t);
      const summary = options.expanded ? compactRenderText(update.summary) : collapsedRenderText(update.summary, 28);
      const metadata = [
        `kind: ${compactRenderText(update.kind)}`,
        `agent: ${compactRenderText(update.agent_id)}`,
        `update: ${compactRenderText(update.update_id)}`,
      ];
      return renderToolCardResult(
        {
          title: deps.t?.("module.subagents.tool.wait_agent.display") ?? "Wait for subagent",
          object: taskName,
          status: `${status}${summary ? `: ${summary}` : ""}`,
          details: metadata,
        },
        theme,
        options,
        context,
      );
    },
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
      const hasNoRunningAgents = deps.registry.list().length === 0;
      if (hasNoRunningAgents && queue.peek() === null) {
        return result(
          {
            message: "wait_agent only waits for subagents dispatched by this session; peers messages arrive automatically, so end this turn instead of waiting.",
            timed_out: false,
            update: null,
          },
          { code: "no_running_agents" },
        );
      }
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
