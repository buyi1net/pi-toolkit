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
      // Pi 1.3.0 把会话启动、before_agent_start 与 streaming 期间都视为 busy：
      // sendUserMessage 不带 deliverAs 会报 "Agent is already processing"，而
      // 扩展命令恰好在 streaming 中也立即执行，存在真实触发窗口。这里统一
      // 显式传 deliverAs: "steer"：idle 时照常触发一次新 run，busy 时进入明确
      // 的 steer 队列。错误传播：await 让宿主投递失败经命令分发上报，不留
      // 未处理的 rejection（命令分发自身会捕获并转宿主 error 事件）。
      await pi.sendUserMessage(toolCall, { deliverAs: "steer" });
    },
  });
}
