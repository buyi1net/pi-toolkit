import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { RuntimeRegistry } from "./registry.ts";
import type { SubagentStartup } from "./startup.ts";
import type { RunningSubagent, SubagentResult } from "./types.ts";
import type { DeliverTerminal } from "./spawn-agent-tool.ts";
import {
  lifecycleQueue,
  lifecycleUpdateDetails,
  resolveLifecycleTarget,
  type SendMessageToolDeps,
  type ToolContext,
} from "./send-message-tool.ts";

export interface FollowupTaskToolDeps extends SendMessageToolDeps {
  startup: SubagentStartup;
  registry: RuntimeRegistry;
  deliverTerminal?: DeliverTerminal;
}

function errorResult(code: string, message: string, details: Record<string, unknown> = {}) {
  const error = { code, message, ...details };
  return { content: [{ type: "text" as const, text: JSON.stringify(error) }], details: error };
}

function targetRunningInterrupted(registry: RuntimeRegistry, agentId: string): boolean {
  return registry.get(agentId)?.interruptRequested === true;
}

export function registerFollowupTaskTool(pi: ExtensionAPI, deps: FollowupTaskToolDeps): void {
  pi.registerTool({
    name: "followup_task",
    label: "Follow Up Task",
    description: "Start the next task round for an existing subagent while preserving its session context. target accepts agent_id, canonical_task_name, or a local task name.",
    promptSnippet: "Continue an existing subagent session with a new task round using its agent_id, canonical path, or task name.",
    parameters: Type.Object({ target: Type.String({ minLength: 1 }), message: Type.String({ minLength: 1 }) }),
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold(deps.t?.("module.subagents.tool.followup_task.display") ?? "Follow-up task")) +
          " " + theme.fg("accent", args.target ?? "(target)"),
        0,
        0,
      );
    },
    renderResult(result, options, theme) {
      const details = result.details as any;
      const t = deps.t;
      if (details?.submission_id) {
        if (!options.expanded) return new Text("", 0, 0);
        const text = result.content[0]?.type === "text" ? result.content[0].text : "";
        return new Text(
          [theme.fg("toolOutput", t?.("module.subagents.tool.followup_task.result.started") ?? "Follow-up started"), text ? theme.fg("muted", text) : ""].filter(Boolean).join("\n"),
          0,
          0,
        );
      }
      const text = result.content[0]?.type === "text" ? result.content[0].text : "Follow-up failed";
      return new Text(theme.fg("error", text), 0, 0);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx: ToolContext) {
      const message = params.message.trim();
      if (!message) return errorResult("invalid_params", "message must be non-empty.");
      const resolved = resolveLifecycleTarget(deps, ctx, params.target);
      if ("error" in resolved) return resolved.error;
      const target = resolved.target;
      const liveTarget = target.agentId ? deps.registry.get(target.agentId) : undefined;
      if (liveTarget && !targetRunningInterrupted(deps.registry, target.agentId)) {
        return errorResult("agent_already_running", `Subagent "${target.name}" is already running; wait for its current round before starting a follow-up.`, {
          target: params.target,
          agent_id: target.agentId,
          task_name: target.name,
          status: deps.registry.get(target.agentId)?.waitMode ?? "running",
        });
      }
      if (deps.registry.isNameReserved(target.name)) {
        return errorResult("agent_already_running", `A follow-up for "${target.name}" is already being started.`, { target: params.target, task_name: target.name });
      }

      const planned = deps.startup.planResume({ name: target.name, message }, ctx as any);
      if (planned.kind === "steer") {
        return errorResult("agent_already_running", `Subagent "${target.name}" became active while the follow-up was being prepared.`, { target: params.target, task_name: target.name });
      }
      if (planned.kind === "error") {
        const text = planned.error;
        const code = /missing|session|context|loadout/i.test(text) ? "context_unavailable" : "target_not_receivable";
        return errorResult(code, text, { target: params.target, task_name: target.name });
      }

      const submissionId = `followup-${randomUUID()}`;
      deps.registry.reserveName(target.name);
      try {
        const started = await deps.startup.resume(planned.plan, ctx as any, pi);
        const running = started.running;
        running.interruptRequested = false;
        const statusUpdate = lifecycleQueue(deps, ctx).followupStatus({
          agent_id: running.id,
          task_name: running.name,
          status: "running",
          summary: `Follow-up ${submissionId} started.`,
          update_id: submissionId,
        });
        const details = lifecycleUpdateDetails(statusUpdate, { ...target, agentId: running.id }, submissionId);
        void started.watch.then((result) => {
          if (!result) {
            const terminal: SubagentResult = { exitCode: 1, errorMessage: "Follow-up watcher ended without a terminal result." } as SubagentResult;
            const update = lifecycleQueue(deps, ctx).watcherTerminal({
              agent_id: running.id,
              task_name: running.name,
              status: "failed",
              summary: terminal.errorMessage!,
              update_id: `${submissionId}:terminal`,
              final_text: terminal.errorMessage,
            });
            deps.deliverTerminal?.(running, terminal, "followup", update.delivery_id);
            return;
          }
          if (result.interruptedRound) return;
          const queue = lifecycleQueue(deps, ctx);
          const update = queue.watcherTerminal({
            agent_id: running.id,
            task_name: running.name,
            status: result.userClosed || result.stopped ? "interrupted" : result.exitCode === 0 ? "completed" : "failed",
            summary: result.summary || result.errorMessage || "Follow-up round finished.",
            update_id: `${submissionId}:terminal`,
            final_text: result.summary || result.errorMessage || undefined,
          });
          deps.deliverTerminal?.(running, result, "followup", update.delivery_id);
        }).catch((error) => {
          const terminal: SubagentResult = { exitCode: 1, errorMessage: error instanceof Error ? error.message : String(error) } as SubagentResult;
          const update = lifecycleQueue(deps, ctx).watcherTerminal({
            agent_id: running.id,
            task_name: running.name,
            status: "failed",
            summary: terminal.errorMessage!,
            update_id: `${submissionId}:terminal`,
            final_text: terminal.errorMessage,
          });
          deps.deliverTerminal?.(running, terminal, "followup", update.delivery_id);
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ...details, status: "running" }) }],
          details: { ...details, status: "running" },
        };
      } catch (error) {
        return errorResult("context_unavailable", `Could not start follow-up for "${target.name}": ${error instanceof Error ? error.message : String(error)}.`, { target: params.target, task_name: target.name });
      } finally {
        deps.registry.releaseName(target.name);
      }
    },
  });
}
