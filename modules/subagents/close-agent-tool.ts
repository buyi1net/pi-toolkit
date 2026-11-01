import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { unregisterName } from "./session.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RunningSubagent } from "./types.ts";
import type { PublicAgentRecord } from "./registry.ts";
import {
  agentTreeRootDir,
  appendAgentTreeRecord,
  appendBubbledUpdate,
  readAgentTreeRecords,
  type AgentTreeRecord,
} from "./agent-tree.ts";
import { subagentTaskDepth } from "./launch-config.ts";
import { terminateHeadlessProcess } from "./headless.ts";
import { adoptSurfaceFor, closeSurfaceFor } from "./surface.ts";
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
  terminateProcess?: (pid: number) => void;
  closeRemoteSurface?: (kind: "herdr" | "tmux", surface: string) => void;
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
      const rootDir = agentTreeRootDir(artifactDir);
      const localSessionId = ctx.sessionManager.getSessionId();
      const terminateProcess = deps.terminateProcess ?? terminateHeadlessProcess;
      const closeRemoteSurface = deps.closeRemoteSurface ?? ((kind, surface) => {
        adoptSurfaceFor(kind, surface);
        closeSurfaceFor(kind, surface);
      });
      const closedDescendants: Array<{ agent_id: string; task_name: string; canonical_task_name: string; previous_status: string }> = [];
      const processControl: Array<{ agent_id: string; action: string; attempted: boolean; ok: boolean | null }> = [];

      const closeOne = (record: PublicAgentRecord, recordPath: string, running?: RunningSubagent) => {
        if (running?.member) return;
        if (running && ["running", "starting"].includes(record.status)) {
          running.closed = true;
          deps.interruptCurrentRound(running);
        }
        deps.registry.updatePublicStatus(recordPath, record.agent_id, "closed", "Agent closed; spawn a new agent to continue.");
        deps.registry.remove(record.agent_id, { recordPath: running?.runtimeFile });
        unregisterName(recordPath.replace(/\/subagent-public\.json$/, ""), record.task_name);
        queue.markAgentClosed(record.agent_id);
        if (running && ["running", "starting"].includes(record.status)) {
          queue.surfaceClosed({ agent_id: record.agent_id, task_name: record.task_name, status: "closed", summary: "Agent closed.", update_id: `close:${record.agent_id}:${randomUUID()}` });
        }
        appendAgentTreeRecord(rootDir, {
          agent_id: record.agent_id,
          task_name: record.task_name,
          canonical_task_name: record.canonical_task_name,
          parent_agent_id: record.parent_agent_id,
          parent_canonical_task_name: record.parent_canonical_task_name,
          status: "closed",
          summary: "Agent closed; spawn a new agent to continue.",
          artifact_dir: artifactDir,
          session_file: running?.sessionFile ?? null,
          pid: running?.pid ?? null,
          surface: running?.surface ?? null,
          surface_kind: running?.kind === "headless" ? "headless" : running?.surfaceKind ?? null,
          owner_pid: process.pid,
          owner_session_id: localSessionId,
        });
        if (subagentTaskDepth(record.canonical_task_name) >= 2) {
          appendBubbledUpdate(rootDir, {
            agent_id: record.agent_id,
            task_name: record.task_name,
            kind: "terminal",
            status: "closed",
            summary: "Agent closed; spawn a new agent to continue.",
            update_id: `close:${record.agent_id}:terminal`,
            update_seq: 0,
            delivery_id: `delivery-close:${record.agent_id}:terminal`,
          });
        }
      };

      const closeRemote = (record: AgentTreeRecord) => {
        appendAgentTreeRecord(rootDir, { ...record, status: "closed", summary: "Agent closed; spawn a new agent to continue." });
        queue.markAgentClosed(record.agent_id);
        if (record.surface_kind === "headless" || record.pid !== null) {
          const pid = record.pid;
          if (pid === null) {
            processControl.push({ agent_id: record.agent_id, action: "terminate", attempted: false, ok: null });
          } else {
            terminateProcess(pid);
            processControl.push({ agent_id: record.agent_id, action: "terminate", attempted: true, ok: true });
          }
          return;
        }
        if (record.surface && (record.surface_kind === "herdr" || record.surface_kind === "tmux")) {
          try {
            closeRemoteSurface(record.surface_kind, record.surface);
            processControl.push({ agent_id: record.agent_id, action: "close_pane", attempted: true, ok: true });
          } catch {
            processControl.push({ agent_id: record.agent_id, action: "close_pane", attempted: true, ok: false });
          }
          return;
        }
        processControl.push({ agent_id: record.agent_id, action: "none", attempted: false, ok: null });
      };

      const records = collectPublicRecords(artifactDir);
      const tree = readAgentTreeRecords(rootDir);
      const localById = new Map(records.map((entry) => [entry.record.agent_id, entry]));
      const remoteById = new Map(tree.filter((record) => !localById.has(record.agent_id)).map((record) => [record.agent_id, record]));
      const childrenOf = (agentId: string): Array<{ local?: { record: PublicAgentRecord; path: string }; remote?: AgentTreeRecord }> => {
        const localChildren = records
          .filter((entry) => entry.record.parent_agent_id === agentId)
          .map((entry) => ({ local: entry }));
        const localIds = new Set(localChildren.map((child) => child.local!.record.agent_id));
        const remoteChildren = [...remoteById.values()]
          .filter((record) => record.parent_agent_id === agentId && !localIds.has(record.agent_id))
          .map((record) => ({ remote: record }));
        return [...localChildren, ...remoteChildren];
      };

      const closeTree = (
        node: { local?: { record: PublicAgentRecord; path: string }; remote?: AgentTreeRecord },
        isTarget: boolean,
      ) => {
        const agentId = node.local?.record.agent_id ?? node.remote!.agent_id;
        for (const child of childrenOf(agentId)) closeTree(child, false);
        if (node.local?.record.status === "closed" || node.remote?.status === "closed") return;
        if (node.local) {
          const running = deps.registry.get(node.local.record.agent_id);
          if (!isTarget) {
            closedDescendants.push({
              agent_id: node.local.record.agent_id,
              task_name: node.local.record.task_name,
              canonical_task_name: node.local.record.canonical_task_name,
              previous_status: node.local.record.status,
            });
          }
          closeOne(node.local.record, node.local.path, running);
          return;
        }
        const remote = node.remote!;
        if (!isTarget) {
          closedDescendants.push({
            agent_id: remote.agent_id,
            task_name: remote.task_name,
            canonical_task_name: remote.canonical_task_name,
            previous_status: remote.status,
          });
        }
        closeRemote(remote);
      };

      const foundLocal = records.find((entry) => entry.record.agent_id === target.agentId);
      const foundRemote = remoteById.get(target.agentId);
      const record = foundLocal?.record ?? foundRemote ?? {
        agent_id: target.agentId,
        task_name: target.name,
        canonical_task_name: target.canonicalTaskName,
        status: (target.status ?? "completed") as any,
        parent_agent_id: null,
        parent_canonical_task_name: null,
        summary: "",
        updated_at: Date.now(),
      };
      closeTree(
        foundLocal
          ? { local: foundLocal }
          : foundRemote
            ? { remote: foundRemote }
            : { local: { record: record as PublicAgentRecord, path: publicPath } },
        true,
      );
      const details = {
        agent_id: record.agent_id,
        task_name: record.task_name,
        canonical_task_name: record.canonical_task_name,
        status: "closed",
        previous_status: record.status,
        closed_descendants: closedDescendants,
        ...(processControl.length > 0 ? { process_control: processControl } : {}),
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(details) }],
        details,
      };
    },
  } as any);
}
