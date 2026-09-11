import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentDefaults } from "./agents.ts";

export function registerSubagentCommand(
  pi: ExtensionAPI,
  loadAgentDefaults: (agentName: string) => AgentDefaults | null,
): void {
  pi.registerCommand("subagent", {
    description: "Spawn a subagent: /subagent <agent> <task>",
    handler: async (args: string, ctx: ExtensionContext) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify("Usage: /subagent <agent> [task]", "warning");
        return;
      }

      const spaceIndex = trimmed.indexOf(" ");
      const agentName = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
      const task = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1).trim();

      const defaults = loadAgentDefaults(agentName);
      if (!defaults) {
        ctx.ui.notify(
          `Agent "${agentName}" not found in ~/.pi/agent/agents/ or .pi/agents/`,
          "error",
        );
        return;
      }

      const taskText = task || `You are the ${agentName} agent. Wait for instructions.`;
      const displayName = agentName[0].toUpperCase() + agentName.slice(1);
      const toolCall =
        `Use subagent with agent: "${agentName}", name: "${displayName}", task: ${JSON.stringify(taskText)}`;
      pi.sendUserMessage(toolCall);
    },
  });
}
