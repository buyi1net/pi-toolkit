import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderToolCardCall, renderToolCardResult, toolCardFailureReason, compactRenderText } from "../../kit/tool-card.ts";
import type { RuntimeRegistry } from "./registry.ts";
import type { RunningSubagent } from "./types.ts";
import { subagentFailureLabels, subagentStatusWord } from "./messages/index.ts";
import { agentTreeRootDir, appendAgentTreeRecord, appendRunningAgentTreeRecord, readAgentTreeRecord } from "./agent-tree.ts";
import { terminateHeadlessProcess } from "./headless.ts";
import { sendCommandFor } from "./surface.ts";
import {
  lifecycleFailureFactLines,
  lifecycleQueue,
  lifecycleUpdateDetails,
  resolveLifecycleTarget,
  type SendMessageToolDeps,
  type ToolContext,
} from "./send-message-tool.ts";

export interface InterruptAgentToolDeps extends SendMessageToolDeps {

  interruptCurrentRound: (running: RunningSubagent) => void;
  terminateProcess?: (pid: number) => void;
  interruptRemoteSurface?: (kind: "herdr" | "tmux", surface: string) => void;
}

function errorResult(code: string, message: string, details: Record<string, unknown> = {}) {
  const error = { code, message, ...details };
  return { content: [{ type: "text" as const, text: JSON.stringify(error) }], details: error, isError: true };
}

function processOutcomeLine(action: string, ok: unknown, t: SubagentsTranslate | undefined): string {
  if (ok === true) {
    return action === "close_pane"
      ? t?.("module.subagents.tool.interrupt_agent.result.paneClosed") ?? "pane closed"
      : t?.("module.subagents.tool.interrupt_agent.result.processTerminated") ?? "process terminated";
  }
  if (ok === false) return t?.("module.subagents.tool.interrupt_agent.result.processFailed") ?? "process action failed";
  return t?.("module.subagents.tool.interrupt_agent.result.processSkipped") ?? "no process action needed";
}

import type { SubagentsTranslate } from "./messages/index.ts";

function historicalStatus(deps: SendMessageToolDeps, ctx: ToolContext, agentId: string): string | null {
  const artifactDir = deps.getArtifactDir(ctx.sessionManager.getSessionDir(), ctx.sessionManager.getSessionId());
  return deps.registry.listPublic(deps.registry.publicPathFor(artifactDir)).find((record) => record.agent_id === agentId)?.status ?? null;
}

export function registerInterruptAgentTool(pi: ExtensionAPI, deps: InterruptAgentToolDeps): void {
  pi.registerTool({
    name: "interrupt_agent",
    label: "Interrupt Agent",
    renderShell: "self",
    description: "Interrupt the current round of a subagent and leave its session available for followup_task. target accepts agent_id, canonical_task_name, or a local task name.",
    promptSnippet: "Interrupt a subagent using its agent_id, canonical path, or task name while preserving its context for a follow-up task.",
    parameters: Type.Object({ target: Type.String({ minLength: 1 }) }),
    renderCall(args, theme, context) {
      return renderToolCardCall(
        { title: deps.t?.("module.subagents.tool.interrupt_agent.display") ?? "Interrupt subagent", object: args.target ?? "(target)" },
        theme,
        context,
      );
    },
    renderResult(result, options, theme, context) {
      const details = result.details as any;
      const success = details?.status === "waiting";
      const t = deps.t;
      if (success) {
        const lines: string[] = [];
        const from = subagentStatusWord(details.previous_status, t);
        const to = subagentStatusWord("waiting", t);
        lines.push(t?.("module.subagents.tool.interrupt_agent.result.statusLine", { from, to }) ?? `status ${from} → ${to}`);
        const control = details.process_control;
        if (control && typeof control === "object") {
          const action = compactRenderText((control as Record<string, unknown>).action) || "process";
          lines.push(processOutcomeLine(action, (control as Record<string, unknown>).ok, t));
        }
        return renderToolCardResult(
          {
            title: t?.("module.subagents.tool.interrupt_agent.display") ?? "Interrupt subagent",
            object: typeof details?.task_name === "string" ? details.task_name : undefined,
            status: t?.("module.subagents.tool.interrupt_agent.result.interrupted") ?? "Interrupted",
            details: options.expanded ? lines : [],
          },
          theme,
          options,
          context,
        );
      }
      return renderToolCardResult(
        {
          title: t?.("module.subagents.tool.interrupt_agent.display") ?? "Interrupt subagent",
          object: typeof details?.task_name === "string" ? details.task_name : undefined,
          status: toolCardFailureReason(
            details,
            subagentFailureLabels(t?.("module.subagents.tool.failure.interrupt") ?? "Interrupt failed", t),
          ),
          details: lifecycleFailureFactLines(details, t),
        },
        theme,
        options,
        context,
      );
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx: ToolContext) {
      const resolved = resolveLifecycleTarget(deps, ctx, params.target);
      if ("error" in resolved) return resolved.error;
      const target = resolved.target;
      if (target.status === "closed") return errorResult("agent_closed", `Subagent "${target.name}" is closed; if you need to continue, spawn a new subagent.`, { target: params.target, agent_id: target.agentId, task_name: target.name, status: "closed" });
      const artifactDir = deps.getArtifactDir(ctx.sessionManager.getSessionDir(), ctx.sessionManager.getSessionId());
      const rootDir = agentTreeRootDir(artifactDir);
      const running = target.agentId ? deps.registry.get(target.agentId) : undefined;
      if (target.managedLocally === false) {
        const record = target.agentId ? readAgentTreeRecord(rootDir, target.agentId) : null;
        if (!record) return errorResult("target_not_receivable", `Subagent "${target.name}" is not reachable from this session.`, { target: params.target, agent_id: target.agentId || null, task_name: target.name, status: target.status ?? null });
        if (record.status === "waiting") return errorResult("agent_already_waiting", `Subagent "${record.task_name}" is already waiting after its current round was interrupted.`, { target: params.target, agent_id: record.agent_id, task_name: record.task_name, status: "waiting" });
        if (record.status === "handed_off") return errorResult("agent_handed_off", `Subagent "${record.task_name}" was handed off and cannot be interrupted in this process.`, { target: params.target, agent_id: record.agent_id, task_name: record.task_name, status: "handed_off" });
        if (record.status === "completed" || record.status === "failed" || record.status === "interrupted") return errorResult("agent_already_finished", `Subagent "${record.task_name}" has already finished (${record.status}) and cannot be interrupted.`, { target: params.target, agent_id: record.agent_id, task_name: record.task_name, status: record.status });
        const previousStatus = record.status;
        const interruptedSummary = deps.t?.("module.subagents.updates.roundInterrupted") ?? "Current round interrupted.";
        appendAgentTreeRecord(rootDir, { ...record, status: "waiting", summary: interruptedSummary });
        const terminateProcess = deps.terminateProcess ?? terminateHeadlessProcess;
        const interruptRemoteSurface = deps.interruptRemoteSurface ?? ((kind, surface) => sendCommandFor(kind, surface, "\u0003"));
        let action: "terminate" | "interrupt_pane" | "none" = "none";
        let attempted = false;
        let ok: boolean | null = null;
        if (record.pid !== null) {
          terminateProcess(record.pid);
          action = "terminate";
          attempted = true;
          ok = true;
        } else if (record.surface && (record.surface_kind === "herdr" || record.surface_kind === "tmux")) {
          interruptRemoteSurface(record.surface_kind, record.surface);
          action = "interrupt_pane";
          attempted = true;
          ok = true;
        }
        const details = {
          agent_id: record.agent_id,
          task_name: record.task_name,
          canonical_task_name: record.canonical_task_name,
          previous_status: previousStatus,
          status: "waiting",
          managed_by: record.owner_session_id,
          process_control: { action, attempted, ok },
        };
        return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
      }
      if (!running) {
        const status = target.agentId ? historicalStatus(deps, ctx, target.agentId) : null;
        if (status === "handed_off") return errorResult("agent_handed_off", `Subagent "${target.name}" was handed off and cannot be interrupted in this process.`, { target: params.target, agent_id: target.agentId, task_name: target.name, status });
        if (status === "waiting") {
          return errorResult(
            "agent_not_running",
            `Subagent "${target.name}" is not running: its current round is already interrupted and it is waiting for instructions. Send followup_task to wake it.`,
            { target: params.target, agent_id: target.agentId || null, task_name: target.name, status: "waiting" },
          );
        }
        return errorResult("agent_already_finished", `Subagent "${target.name}" is not running and cannot be interrupted.`, { target: params.target, agent_id: target.agentId || null, task_name: target.name, status: status ?? "completed" });
      }
      if (running.interruptRequested || running.publicStatus === "waiting") {
        return errorResult("agent_already_waiting", `Subagent "${running.name}" is already waiting after its current round was interrupted.`, { target: params.target, agent_id: running.id, task_name: running.name, status: "waiting" });
      }
      if (running.member) return errorResult("target_not_receivable", `Team member "${running.name}" has no interruptible one-shot round.`, { target: params.target, agent_id: running.id, task_name: running.name });

      const previousStatus = running.publicStatus ?? "running";
      running.interruptRequested = true;
      running.publicStatus = "waiting";
      deps.registry.markInterrupted(running.runtimeFile, running.id);
      deps.interruptCurrentRound(running);
      const interruptedSummary = deps.t?.("module.subagents.updates.roundInterrupted") ?? "Current round interrupted.";
      deps.registry.updatePublicStatus(
        deps.registry.publicPathFor(artifactDir),
        running.id,
        "waiting",
        interruptedSummary,
      );
      appendRunningAgentTreeRecord({ rootDir, running, status: "waiting", summary: interruptedSummary, artifactDir, ownerSessionId: ctx.sessionManager.getSessionId() });
      const submissionId = `interrupt-${randomUUID()}`;
      const update = lifecycleQueue(deps, ctx).interruptStatus({
        agent_id: running.id,
        task_name: running.name,
        status: "waiting",
        summary: interruptedSummary,
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
