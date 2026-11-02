import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Box, Text, stripTerminalSequences, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { compactRenderText, renderToolCardCall, renderToolCardResult, formatToolCardLine, cardBackground } from "../../kit/tool-card.ts";
import type { PublicAgentRecord, RuntimeRegistry } from "./registry.ts";
import {
  AGENT_SUMMARY_LIMIT,
  agentTreeRootDir,
  canonicallyWithin,
  readAgentTreeRecords,
  type AgentTreeRecord,
} from "./agent-tree.ts";
import { subagentTaskDepth } from "./launch-config.ts";
import { subagentStatusWord, summaryDisplayText, type SubagentsTranslate } from "./messages/index.ts";

export interface ListAgentsToolDeps {
  registry: RuntimeRegistry;
  getArtifactDir: (sessionDir: string, sessionId: string) => string;
  readonly t?: SubagentsTranslate;
}

const TERMINAL_STATUSES = new Set<PublicAgentRecord["status"]>([
  "completed",
  "failed",
  "interrupted",
  "handed_off",
  "closed",
]);

function mergeAgentStatus(
  record: PublicAgentRecord,
  tree: AgentTreeRecord | undefined,
  live: ReturnType<RuntimeRegistry["get"]>,
): PublicAgentRecord {
  if (tree && TERMINAL_STATUSES.has(tree.status)) {
    return { ...record, status: tree.status, summary: tree.summary, updated_at: tree.updated_at };
  }
  if (live) {
    const status = live.waitReleased || live.waitMode === "recovered" ? "waiting" : live.publicStatus;
    if (status) return { ...record, status };
  }
  if (tree) return { ...record, status: tree.status };
  return record;
}

const listAgentsOutputSchema = Type.Union([
  Type.Object({
    agents: Type.Array(Type.Object({
      agent_id: Type.String(),
      task_name: Type.String(),
      canonical_task_name: Type.String(),
      status: Type.Union([
        Type.Literal("starting"), Type.Literal("running"), Type.Literal("waiting"),
        Type.Literal("completed"), Type.Literal("failed"), Type.Literal("interrupted"), Type.Literal("handed_off"),
      ]),
      parent_agent_id: Type.Union([Type.String(), Type.Null()]),
      parent_canonical_task_name: Type.Union([Type.String(), Type.Null()]),
      summary: Type.String(),
      updated_at: Type.Number(),
      depth: Type.Optional(Type.Number()),
    })),
  }),
  Type.Object({
    code: Type.String(),
    message: Type.String(),
  }),
]);

function agentSummary(
  agents: readonly PublicAgentRecord[],
  theme: { fg(color: string, text: string): string },
  t?: SubagentsTranslate,
): string {
  const counts = new Map<string, number>();
  for (const agent of agents) counts.set(agent.status, (counts.get(agent.status) ?? 0) + 1);
  const order = ["starting", "running", "waiting", "completed", "failed", "interrupted", "handed_off"] as const;
  const parts = order
    .filter((status) => (counts.get(status) ?? 0) > 0)
    .map((status) => {
      const count = counts.get(status)!;
      switch (status) {
        case "starting": return t?.("module.subagents.tool.list_agents.result.status.starting", { count }) ?? `${count} starting`;
        case "running": return t?.("module.subagents.tool.list_agents.result.status.running", { count }) ?? `${count} running`;
        case "waiting": return t?.("module.subagents.tool.list_agents.result.status.waiting", { count }) ?? `${count} waiting`;
        case "completed": return t?.("module.subagents.tool.list_agents.result.status.completed", { count }) ?? `${count} completed`;
        case "failed": return t?.("module.subagents.tool.list_agents.result.status.failed", { count }) ?? `${count} failed`;
        case "interrupted": return t?.("module.subagents.tool.list_agents.result.status.interrupted", { count }) ?? `${count} interrupted`;
        case "handed_off": return t?.("module.subagents.tool.list_agents.result.status.handedOff", { count }) ?? `${count} handed off`;
      }
    });
  return theme.fg("toolOutput", parts.length > 0
    ? parts.join(" · ")
    : t?.("module.subagents.tool.list_agents.result.empty") ?? "No agents are registered in this session");
}

function renderAgentTreeLines(
  agents: readonly PublicAgentRecord[],
  theme: { fg(color: string, text: string): string },
  t: SubagentsTranslate | undefined,
  lineWidth: number,
): string[] {
  if (agents.length === 0) return [];
  const byId = new Map(agents.filter((agent) => compactRenderText(agent.agent_id)).map((agent) => [agent.agent_id, agent]));
  const roots: PublicAgentRecord[] = [];
  const childrenOf = new Map<string, PublicAgentRecord[]>();
  for (const agent of agents) {
    const parentAgentId = compactRenderText(agent.parent_agent_id);
    const parent = parentAgentId ? byId.get(parentAgentId) : undefined;
    if (!parent) roots.push(agent);
    else childrenOf.set(parent.agent_id, [...(childrenOf.get(parent.agent_id) ?? []), agent]);
  }
  const lines: string[] = [];
  const visit = (agent: PublicAgentRecord, depth: number, isLast: boolean) => {
    const prefix = depth === 0 ? "" : `${"  ".repeat(depth)}${isLast ? "└ " : "├ "}`;
    const status = subagentStatusWord(agent.status, t);
    lines.push(theme.fg("toolOutput", `${prefix}${agent.task_name}`) + theme.fg("muted", ` · ${status}`));
    const indent = "  ".repeat(depth + 1);
    const summary = stripTerminalSequences(summaryDisplayText(typeof agent.summary === "string" ? agent.summary : "", t)).trim();
    if (summary) {
      const wrapWidth = Math.max(1, lineWidth - indent.length);
      for (const line of wrapTextWithAnsi(summary, wrapWidth)) lines.push(theme.fg("muted", `${indent}${line}`));
    }
    const children = childrenOf.get(agent.agent_id) ?? [];
    children.forEach((child, index) => visit(child, depth + 1, index === children.length - 1));
  };
  roots.forEach((root, index) => visit(root, 0, index === roots.length - 1));
  return lines;
}

function resolvePathPrefix(raw: unknown, callerCanonical: string): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const value = raw.trim();
  if (value.startsWith("/")) return value.replace(/\/+$/, "") || "/root";
  return `${callerCanonical.replace(/\/+$/, "")}/${value}`.replace(/\/+/g, "/");
}

function treeRecordToPublic(record: AgentTreeRecord): PublicAgentRecord {
  return {
    agent_id: record.agent_id,
    task_name: record.task_name,
    canonical_task_name: record.canonical_task_name,
    status: record.status,
    parent_agent_id: record.parent_agent_id,
    parent_canonical_task_name: record.parent_canonical_task_name,
    summary: record.summary,
    updated_at: record.updated_at,
  };
}

export function registerListAgentsTool(pi: ExtensionAPI, deps: ListAgentsToolDeps): void {
  pi.registerTool({
    name: "list_agents",
    label: "List Agents",
    renderShell: "self",
    description:
      "List the whole agent tree for the current root session, including descendants spawned by sub-agents and agents that already reached a terminal state. " +
      "path_prefix optionally filters by canonical task path: an absolute path such as /root/research, or a path relative to the caller. " +
      `summary is truncated to ${AGENT_SUMMARY_LIMIT} characters, the same limit the agent tree log keeps; read the full answer from the FINAL_ANSWER envelope delivered to this session or from the sub-agent session file. ` +
      "status prefers the terminal state recorded in the agent tree; only while the tree still reports a non-terminal state is the live status used.",
    promptSnippet: "List the whole agent tree with parent paths, optionally filtered by path_prefix.",
    parameters: Type.Object({
      path_prefix: Type.Optional(Type.String({ minLength: 1 })),
    }),
    outputSchema: listAgentsOutputSchema,
    renderCall(_args, theme, context) {
      return renderToolCardCall({ title: deps.t?.("module.subagents.tool.list_agents.display") ?? "List subagents" }, theme, context);
    },
    renderResult(result, options, theme, context) {
      const details = result.details as { agents?: PublicAgentRecord[]; code?: unknown; message?: unknown } | undefined;
      if (!Array.isArray(details?.agents)) {
        const reason = compactRenderText(details?.code) || "unknown error";
        const text = deps.t?.("module.subagents.tool.list_agents.result.failed", { reason }) ?? `List agents failed: ${reason}`;
        return renderToolCardResult({ title: deps.t?.("module.subagents.tool.list_agents.display") ?? "List subagents", status: text }, theme, options, context);
      }
      const agents = details.agents;
      const summary = agentSummary(agents, theme, deps.t);
      const title = deps.t?.("module.subagents.tool.list_agents.display") ?? "List subagents";
      const component = {
        invalidate() {},
        render(width: number): string[] {
          const lineWidth = Math.max(1, width - 2);
          const lines = [formatToolCardLine({ title, status: summary }, theme, false)];
          if (options.expanded) lines.push(...renderAgentTreeLines(agents, theme, deps.t, lineWidth));
          const box = new Box(context?.outputPad ?? 1, 1, cardBackground(theme, "toolSuccessBg"));
          box.addChild(new Text(lines.join("\n"), 0, 0));
          return ["", ...box.render(width)];
        },
      };
      return component;
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionFile = ctx?.sessionManager?.getSessionFile?.();
      if (!sessionFile) {
        const error = { code: "session_unavailable", message: "list_agents requires a persistent parent session." };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(error) }],
          details: error,
          isError: true,
          structuredContent: error as unknown as AgentToolResult["structuredContent"],
        };
      }
      const artifactDir = deps.getArtifactDir(ctx.sessionManager.getSessionDir(), ctx.sessionManager.getSessionId());
      const path = deps.registry.publicPathFor(artifactDir);
      const live = new Map(deps.registry.list().map((entry) => [entry.id, entry]));
      const tree = new Map(readAgentTreeRecords(agentTreeRootDir(artifactDir)).map((record) => [record.agent_id, record]));
      const local = deps.registry.listPublic(path)
        .map((record) => mergeAgentStatus(record, tree.get(record.agent_id), live.get(record.agent_id)));
      const localIds = new Set(local.map((record) => record.agent_id));
      const remote = [...tree.values()]
        .filter((record) => !localIds.has(record.agent_id))
        .map((record) => treeRecordToPublic(record));
      const prefix = resolvePathPrefix(params?.path_prefix, process.env.PI_SUBAGENT_TASK_PATH?.trim() || "/root");
      const agents = [...local, ...remote]
        .filter((record) => record.status !== "closed")
        .filter((record) => !prefix || canonicallyWithin(record.canonical_task_name, prefix))
        .map((record) => ({
          ...record,
          summary: (record.summary ?? "").slice(0, AGENT_SUMMARY_LIMIT),
          depth: subagentTaskDepth(record.canonical_task_name),
        }))
        .sort((a, b) => a.canonical_task_name.localeCompare(b.canonical_task_name));
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ agents }) }],
        details: { agents },
        structuredContent: { agents } as unknown as AgentToolResult["structuredContent"],
      };
    },
  });
}
