import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { unregisterName } from "./session.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RunningSubagent } from "./types.ts";
import type { PublicAgentRecord } from "./registry.ts";
import {
  lifecycleQueue,
  resolveLifecycleTarget,
  type SendMessageToolDeps,
  type ToolContext,
} from "./send-message-tool.ts";

function collectPublicRecords(root: string): Array<{ record: PublicAgentRecord; path: string }> {
  const found: Array<{ record: PublicAgentRecord; path: string }> = [];
  const visit = (dir: string) => {
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }) as import("node:fs").Dirent[]; } catch { return; }
    for (const entry of entries) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) visit(path);
      else if (entry.name === "subagent-public.json") {
        try {
          const records = JSON.parse(readFileSync(path, "utf8")) as PublicAgentRecord[];
          if (Array.isArray(records)) for (const record of records) if (record && typeof record.agent_id === "string") found.push({ record, path });
        } catch { /* ignore malformed historical records */ }
      }
    }
  };
  visit(root);
  return found;
}
export interface CloseAgentToolDeps extends SendMessageToolDeps {
  interruptCurrentRound: (running: RunningSubagent) => void;
}

function errorResult(code: string, message: string, details: Record<string, unknown> = {}) {
  const error = { code, message, ...details };
  return { content: [{ type: "text" as const, text: JSON.stringify(error) }], details: error, isError: true };
}

export function registerCloseAgentTool(pi: ExtensionAPI, deps: CloseAgentToolDeps): void {
  pi.registerTool({
    name: "close_agent",
    label: "Close Agent",
    renderShell: "self",
    description: "Close a subagent, release its task name, and keep its session file for records. A running agent is interrupted first; target accepts agent_id, canonical_task_name, or a local task name.",
    promptSnippet: "Close a subagent and release its task name; a closed agent can no longer receive messages or follow-ups.",
    parameters: Type.Object({ target: Type.String({ minLength: 1 }) }),
    async execute(_toolCallId: string, params: { target: string }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ToolContext) {
      const resolved = resolveLifecycleTarget(deps, ctx, params.target);
      if ("error" in resolved) return resolved.error;
      const target = resolved.target;
      const artifactDir = deps.getArtifactDir(ctx.sessionManager.getSessionDir(), ctx.sessionManager.getSessionId());
      const publicPath = deps.registry.publicPathFor(artifactDir);
      const live = target.agentId ? deps.registry.get(target.agentId) : undefined;
      if (live?.member) return errorResult("team_member_not_supported", `Team member "${live.name}" is not supported by close_agent.`, { target: params.target, agent_id: live.id, task_name: live.name, status: live.publicStatus ?? "running" });
      if (target.status === "closed") {
        return { content: [{ type: "text" as const, text: JSON.stringify({ agent_id: target.agentId, task_name: target.name, status: "closed", already_closed: true }) }], details: { agent_id: target.agentId, task_name: target.name, status: "closed", already_closed: true } };
      }

      const queue = lifecycleQueue(deps, ctx);
      const closeOne = (record: PublicAgentRecord, recordPath: string, running?: RunningSubagent) => {
        if (running?.member) return;
        if (running && ["running", "starting"].includes(record.status)) {
          running.closed = true;
          deps.interruptCurrentRound(running);
        }
        deps.registry.updatePublicStatus(recordPath, record.agent_id, "closed", "Agent closed; spawn a new agent to continue.");
        deps.registry.remove(record.agent_id, { recordPath: running?.runtimeFile });
        unregisterName(recordPath.replace(/\/subagent-public\.json$/, ""), record.task_name);
        if (running && ["running", "starting"].includes(record.status)) {
          queue.surfaceClosed({ agent_id: record.agent_id, task_name: record.task_name, status: "closed", summary: "Agent closed.", update_id: `close:${record.agent_id}:${randomUUID()}` });
        }
      };

      const records = collectPublicRecords(artifactDir);
      const byParent = new Map<string, Array<{ record: PublicAgentRecord; path: string }>>();
      for (const entry of records) {
        if (entry.record.parent_agent_id) byParent.set(entry.record.parent_agent_id, [...(byParent.get(entry.record.parent_agent_id) ?? []), entry]);
      }
      const closeTree = (entry: { record: PublicAgentRecord; path: string }, running?: RunningSubagent) => {
        for (const child of byParent.get(entry.record.agent_id) ?? []) closeTree(child, deps.registry.get(child.record.agent_id));
        closeOne(entry.record, entry.path, running);
      };
      const found = records.find((entry) => entry.record.agent_id === target.agentId);
      const record = found?.record ?? {
        agent_id: target.agentId,
        task_name: target.name,
        canonical_task_name: target.canonicalTaskName,
        status: (target.status ?? "completed") as any,
        parent_agent_id: null,
        parent_canonical_task_name: null,
        summary: "",
        updated_at: Date.now(),
      };
      closeTree(found ?? { record, path: publicPath }, live);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ agent_id: record.agent_id, task_name: record.task_name, status: "closed", previous_status: record.status }) }],
        details: { agent_id: record.agent_id, task_name: record.task_name, status: "closed", previous_status: record.status },
      };
    },
  } as any);
}
