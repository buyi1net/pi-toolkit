import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { RuntimeRegistry } from "./registry.ts";
import type { RunningSubagent } from "./types.ts";
import {
  lifecycleQueue,
  lifecycleUpdateDetails,
  resolveLifecycleTarget,
  type SendMessageToolDeps,
  type ToolContext,
} from "./send-message-tool.ts";

export interface InterruptAgentToolDeps extends SendMessageToolDeps {
  /** 只结束当前 provider/子进程轮次；不得关闭表面或删除上下文。 */
  interruptCurrentRound: (running: RunningSubagent) => void;
}

function errorResult(code: string, message: string, details: Record<string, unknown> = {}) {
  const error = { code, message, ...details };
  return { content: [{ type: "text" as const, text: JSON.stringify(error) }], details: error };
}

function historicalStatus(deps: SendMessageToolDeps, ctx: ToolContext, agentId: string): string | null {
  const artifactDir = deps.getArtifactDir(ctx.sessionManager.getSessionDir(), ctx.sessionManager.getSessionId());
  return deps.registry.listPublic(deps.registry.publicPathFor(artifactDir)).find((record) => record.agent_id === agentId)?.status ?? null;
}

export function registerInterruptAgentTool(pi: ExtensionAPI, deps: InterruptAgentToolDeps): void {
  pi.registerTool({
    name: "interrupt_agent",
    label: "Interrupt Agent",
    description: "Interrupt the current round of a subagent and leave its session available for followup_task. target accepts agent_id, canonical_task_name, or a local task name.",
    promptSnippet: "Interrupt a subagent using its agent_id, canonical path, or task name while preserving its context for a follow-up task.",
    parameters: Type.Object({ target: Type.String({ minLength: 1 }) }),
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold(deps.t?.("module.subagents.tool.interrupt_agent.display") ?? "Interrupt subagent")) +
          " " + theme.fg("accent", args.target ?? "(target)"),
        0,
        0,
      );
    },
    renderResult(result, options, theme) {
      const details = result.details as any;
      const success = details?.status === "waiting";
      if (success && !options.expanded) return new Text("", 0, 0);
      if (success) {
        const text = result.content[0]?.type === "text" ? result.content[0].text : "";
        return new Text(
          [theme.fg("toolOutput", deps.t?.("module.subagents.tool.interrupt_agent.result.interrupted") ?? "Interrupted"), text ? theme.fg("muted", text) : ""].filter(Boolean).join("\n"),
          0,
          0,
        );
      }
      const reason = typeof details?.message === "string" && details.message.trim() !== ""
        ? details.message.replace(/\s+/g, " ").trim()
        : typeof details?.code === "string" ? details.code : "unknown error";
      const summary = deps.t?.("module.subagents.tool.interrupt_agent.result.failed", { reason }) ?? `Interrupt failed: ${reason}`;
      if (!options.expanded) return new Text(theme.fg("error", summary), 0, 0);
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      return new Text([theme.fg("error", summary), text ? theme.fg("muted", text) : ""].filter(Boolean).join("\n"), 0, 0);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx: ToolContext) {
      const resolved = resolveLifecycleTarget(deps, ctx, params.target);
      if ("error" in resolved) return resolved.error;
      const target = resolved.target;
      const running = target.agentId ? deps.registry.get(target.agentId) : undefined;
      if (!running) {
        const status = target.agentId ? historicalStatus(deps, ctx, target.agentId) : null;
        if (status === "handed_off") return errorResult("agent_handed_off", `Subagent "${target.name}" was handed off and cannot be interrupted in this process.`, { target: params.target, agent_id: target.agentId, task_name: target.name, status });
        return errorResult("agent_already_finished", `Subagent "${target.name}" is not running and cannot be interrupted.`, { target: params.target, agent_id: target.agentId || null, task_name: target.name, status: status ?? "completed" });
      }
      if (running.interruptRequested || running.publicStatus === "waiting") {
        return errorResult("agent_already_waiting", `Subagent "${running.name}" is already waiting after its current round was interrupted.`, { target: params.target, agent_id: running.id, task_name: running.name, status: "waiting" });
      }
      if (running.member) return errorResult("target_not_receivable", `Team member "${running.name}" has no interruptible one-shot round.`, { target: params.target, agent_id: running.id, task_name: running.name });

      const previousStatus = running.publicStatus ?? "running";
      running.interruptRequested = true;
      running.publicStatus = "waiting";
      deps.interruptCurrentRound(running);
      deps.registry.updatePublicStatus(
        deps.registry.publicPathFor(deps.getArtifactDir(ctx.sessionManager.getSessionDir(), ctx.sessionManager.getSessionId())),
        running.id,
        "waiting",
        "Current round interrupted; context is preserved for follow-up.",
      );
      const submissionId = `interrupt-${randomUUID()}`;
      const update = lifecycleQueue(deps, ctx).interruptStatus({
        agent_id: running.id,
        task_name: running.name,
        status: "waiting",
        summary: `Current round interrupted (${submissionId}).`,
        update_id: submissionId,
      });
      const details = lifecycleUpdateDetails(update, target, submissionId);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ...details, previous_status: previousStatus, status: "waiting" }) }],
        details: { ...details, previous_status: previousStatus, status: "waiting" },
      };
    },
  });
}

export type { RuntimeRegistry };
