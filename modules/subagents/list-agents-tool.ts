import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { PublicAgentRecord, RuntimeRegistry } from "./registry.ts";
import type { SubagentsTranslate } from "./messages/index.ts";

export interface ListAgentsToolDeps {
  registry: RuntimeRegistry;
  getArtifactDir: (sessionDir: string, sessionId: string) => string;
  readonly t?: SubagentsTranslate;
}

function publicStatus(record: PublicAgentRecord, live: ReturnType<RuntimeRegistry["get"]>): PublicAgentRecord["status"] {
  if (!live) return record.status;
  if (live.waitReleased || live.waitMode === "recovered") return "waiting";
  return live.publicStatus ?? record.status;
}

// 与 content 的两种 JSON 载荷镜像：公开代理树与软错误；软错误不走 isError，
// 让 codemode 脚本拿到结构化 code 而不是 reject。
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
    })),
  }),
  Type.Object({
    code: Type.String(),
    message: Type.String(),
  }),
]);

function compactRenderText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

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

function agentStatusLabel(status: PublicAgentRecord["status"], t?: SubagentsTranslate): string {
  switch (status) {
    case "starting": return t?.("module.subagents.tool.list_agents.result.status.starting", { count: 1 }) ?? "starting";
    case "running": return t?.("module.subagents.tool.list_agents.result.status.running", { count: 1 }) ?? "running";
    case "waiting": return t?.("module.subagents.tool.list_agents.result.status.waiting", { count: 1 }) ?? "waiting";
    case "completed": return t?.("module.subagents.tool.list_agents.result.status.completed", { count: 1 }) ?? "completed";
    case "failed": return t?.("module.subagents.tool.list_agents.result.status.failed", { count: 1 }) ?? "failed";
    case "interrupted": return t?.("module.subagents.tool.list_agents.result.status.interrupted", { count: 1 }) ?? "interrupted";
    case "handed_off": return t?.("module.subagents.tool.list_agents.result.status.handedOff", { count: 1 }) ?? "handed off";
  }
}

export function registerListAgentsTool(pi: ExtensionAPI, deps: ListAgentsToolDeps): void {
  pi.registerTool({
    name: "list_agents",
    label: "List Agents",
    description: "List the visible agents in the current parent session as a public status tree. This tool takes no parameters.",
    promptSnippet: "List visible agents, their status, task summary, and parent paths.",
    parameters: Type.Object({}),
    outputSchema: listAgentsOutputSchema,
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold(deps.t?.("module.subagents.tool.list_agents.display") ?? "List subagents")), 0, 0);
    },
    renderResult(result, options, theme) {
      const details = result.details as { agents?: PublicAgentRecord[]; code?: unknown; message?: unknown } | undefined;
      if (!Array.isArray(details?.agents)) {
        const reason = compactRenderText(details?.code) || "unknown error";
        const text = deps.t?.("module.subagents.tool.list_agents.result.failed", { reason }) ?? `List agents failed: ${reason}`;
        if (!options.expanded) return new Text(theme.fg("error", text), 0, 0);
        const contentText = result.content.find((part) => part.type === "text")?.text;
        return new Text([theme.fg("error", text), contentText ? theme.fg("muted", contentText) : ""].filter(Boolean).join("\n"), 0, 0);
      }
      const agents = details.agents;
      if (!options.expanded) return new Text(agentSummary(agents, theme, deps.t), 0, 0);
      if (agents.length === 0) return new Text(theme.fg("toolOutput", deps.t?.("module.subagents.tool.list_agents.result.empty") ?? "No agents are registered in this session"), 0, 0);
      return new Text(agents.map((agent) =>
        `${theme.fg("toolOutput", agent.task_name)} ${theme.fg("muted", agentStatusLabel(agent.status, deps.t))}`,
      ).join("\n"), 0, 0);
    },
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const sessionFile = ctx?.sessionManager?.getSessionFile?.();
      if (!sessionFile) {
        const error = { code: "session_unavailable", message: "list_agents requires a persistent parent session." };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(error) }],
          details: error,
          structuredContent: error as unknown as AgentToolResult["structuredContent"],
        };
      }
      const artifactDir = deps.getArtifactDir(ctx.sessionManager.getSessionDir(), ctx.sessionManager.getSessionId());
      const path = deps.registry.publicPathFor(artifactDir);
      const live = new Map(deps.registry.list().map((entry) => [entry.id, entry]));
      const agents = deps.registry.listPublic(path)
        .map((record) => ({ ...record, status: publicStatus(record, live.get(record.agent_id)) }))
        .sort((a, b) => a.canonical_task_name.localeCompare(b.canonical_task_name));
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ agents }) }],
        details: { agents },
        structuredContent: { agents } as unknown as AgentToolResult["structuredContent"],
      };
    },
  });
}
