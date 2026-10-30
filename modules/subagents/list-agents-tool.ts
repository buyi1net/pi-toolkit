import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { PublicAgentRecord, RuntimeRegistry } from "./registry.ts";

export interface ListAgentsToolDeps {
  registry: RuntimeRegistry;
  getArtifactDir: (sessionDir: string, sessionId: string) => string;
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

export function registerListAgentsTool(pi: ExtensionAPI, deps: ListAgentsToolDeps): void {
  pi.registerTool({
    name: "list_agents",
    label: "List Agents",
    description: "List the visible agents in the current parent session as a public status tree. This tool takes no parameters.",
    promptSnippet: "List visible agents, their status, task summary, and parent paths.",
    parameters: Type.Object({}),
    outputSchema: listAgentsOutputSchema,
    renderResult(result, _opts, theme) {
      const details = result.details as { agents?: PublicAgentRecord[] } | undefined;
      const agents = details?.agents ?? [];
      if (agents.length === 0) return new Text(theme.fg("dim", "No agents are registered in this session."), 0, 0);
      return new Text(agents.map((agent) =>
        `${theme.fg("toolTitle", theme.bold(agent.task_name))} ${theme.fg("dim", `— ${agent.status}`)}`,
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
