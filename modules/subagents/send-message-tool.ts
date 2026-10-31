import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { readNameRegistry } from "./session.ts";
import type { RuntimeRegistry } from "./registry.ts";
import { createParentUpdateQueue, createParentUpdateProducers, type ParentSessionUpdate } from "./parent-update-queue.ts";

export interface SendMessageToolDeps {
  registry: RuntimeRegistry;
  getArtifactDir: (sessionDir: string, sessionId: string) => string;
  handleSubagentSteer: (params: { name?: string; message?: string }) => unknown;
}

export interface ToolContext {
  sessionManager: { getSessionDir(): string; getSessionId(): string };
}

export interface Target {
  name: string;
  agentId: string;
  canonicalTaskName: string;
}

function canonicalParent(): string {
  return process.env.PI_SUBAGENT_TASK_PATH?.trim() || "/root";
}

function canonicalFor(name: string): string {
  return `${canonicalParent()}/${name}`;
}

function errorResult(code: string, message: string, details: Record<string, unknown> = {}) {
  const error = { code, message, ...details };
  return { content: [{ type: "text" as const, text: JSON.stringify(error) }], details: error };
}

function targetNames(deps: SendMessageToolDeps, ctx: ToolContext): Array<{ name: string; agentId: string; canonicalTaskName: string; running: boolean }> {
  const live = deps.registry.list().map((entry) => ({
    name: entry.name,
    agentId: entry.id,
    canonicalTaskName: entry.canonicalTaskName ?? canonicalFor(entry.name),
    running: true,
  }));
  const artifactDir = deps.getArtifactDir(ctx.sessionManager.getSessionDir(), ctx.sessionManager.getSessionId());
  const publicRecords = deps.registry.listPublic(deps.registry.publicPathFor(artifactDir));
  const historical = publicRecords.map((record) => ({ name: record.task_name, agentId: record.agent_id, canonicalTaskName: record.canonical_task_name, running: false }));
  const entries = historical.length > 0 ? historical : Object.keys(readNameRegistry(artifactDir)).map((name) => ({ name, agentId: "", canonicalTaskName: canonicalFor(name), running: false }));
  const seen = new Set<string>();
  return [...entries, ...live].filter((entry) => {
    const key = `${entry.agentId}:${entry.canonicalTaskName}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function resolveLifecycleTarget(
  deps: SendMessageToolDeps,
  ctx: ToolContext,
  rawTarget: string,
): { target: Target } | { error: ReturnType<typeof errorResult> } {
  const target = rawTarget.trim();
  if (!target) return { error: errorResult("target_not_found", "A non-empty target is required.", { target: rawTarget }) };
  const liveById = deps.registry.get(target);
  if (liveById) return { target: { name: liveById.name, agentId: liveById.id, canonicalTaskName: canonicalFor(liveById.name) } };

  const entries = targetNames(deps, ctx);
  if (target.startsWith("/")) {
    const matches = entries.filter((entry) => entry.canonicalTaskName === target);

    if (matches.length === 1) {
      return { target: { name: matches[0]!.name, agentId: matches[0]!.agentId, canonicalTaskName: matches[0]!.canonicalTaskName } };
    }
    if (matches.length > 1) return { error: errorResult("target_ambiguous", `Canonical task path "${target}" matches multiple targets.`, { target, candidates: matches.map((entry) => entry.name) }) };
    return { error: errorResult("target_not_found", `No subagent matches canonical task path "${target}".`, { target }) };
  }

  const matches = entries.filter((entry) => entry.name === target);
  const idMatches = entries.filter((entry) => entry.agentId === target);
  if (idMatches.length > 1) {
    return { error: errorResult("target_ambiguous", `Agent id "${target}" matches multiple historical runs.`, { target, candidates: idMatches.map((entry) => ({ agent_id: entry.agentId, canonical_task_name: entry.canonicalTaskName })) }) };
  }
  if (idMatches.length === 1) {
    const match = idMatches[0]!;
    return { target: { name: match.name, agentId: match.agentId, canonicalTaskName: match.canonicalTaskName } };
  }
  if (matches.length > 1) {
    return { error: errorResult("target_ambiguous", `Local task name "${target}" is ambiguous.`, { target, candidates: matches.map((entry) => ({ agent_id: entry.agentId, canonical_task_name: entry.canonicalTaskName })) }) };
  }
  if (matches.length === 1) {
    return { target: { name: target, agentId: matches[0]!.agentId, canonicalTaskName: matches[0]!.canonicalTaskName } };
  }
  return { error: errorResult("target_not_found", `No subagent matches target "${target}".`, {
    target,
    candidates: entries.map((entry) => ({ agent_id: entry.agentId || null, canonical_task_name: entry.canonicalTaskName, task_name: entry.name })),
  }) };
}

export function lifecycleQueue(deps: SendMessageToolDeps, ctx: ToolContext) {
  return createParentUpdateProducers(createParentUpdateQueue(
    deps.getArtifactDir(ctx.sessionManager.getSessionDir(), ctx.sessionManager.getSessionId()),
  ));
}

export function lifecycleUpdateDetails(update: ParentSessionUpdate, target: Target, submissionId: string) {
  return {
    submission_id: submissionId,
    update_id: update.update_id,
    delivery_id: update.delivery_id,
    update_seq: update.update_seq,
    agent_id: target.agentId || null,
    task_name: target.name,
    canonical_task_name: target.canonicalTaskName,
  };
}

export function registerSendMessageTool(pi: ExtensionAPI, deps: SendMessageToolDeps): void {
  pi.registerTool({
    name: "send_message",
    label: "Send Message",
    description: "Deliver an immediate message to an existing subagent. target accepts agent_id, canonical_task_name, or a unique local task name. This never starts a new task round.",
    promptSnippet: "Send an immediate message using the agent_id, canonical path, or task name without starting a new round.",
    parameters: Type.Object({ target: Type.String({ minLength: 1 }), message: Type.String({ minLength: 1 }) }),
    renderCall(args, theme) { return new Text("○ " + theme.fg("toolTitle", theme.bold(args.target ?? "(unknown)")) + theme.fg("dim", " — message"), 0, 0); },
    renderResult(result, _opts, theme) {
      const details = result.details as any;
      if (details?.submission_id) return new Text(theme.fg("success", "✓") + " " + theme.fg("toolTitle", theme.bold(details.task_name)) + theme.fg("dim", " — message submitted"), 0, 0);
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      return new Text(theme.fg("dim", text), 0, 0);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx: ToolContext) {
      const message = params.message.trim();
      if (!message) return errorResult("invalid_params", "message must be non-empty.");
      const resolved = resolveLifecycleTarget(deps, ctx, params.target);
      if ("error" in resolved) return resolved.error;
      const target = resolved.target;
      if (!target.agentId) return errorResult("target_not_receivable", `Subagent "${target.name}" is not running and cannot receive an immediate message.`, { target: params.target, task_name: target.name });
      const delivered = deps.handleSubagentSteer({ name: target.name, message }) as any;
      if (delivered?.details?.error) return errorResult("target_not_receivable", String(delivered.details.error), { target: params.target, agent_id: target.agentId, task_name: target.name });
      const submissionId = `message-${randomUUID()}`;
      const update = lifecycleQueue(deps, ctx).message({
        agent_id: target.agentId,
        task_name: target.name,
        status: "running",
        summary: `Immediate message ${submissionId} delivered.`,
        update_id: submissionId,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify({ ...lifecycleUpdateDetails(update, target, submissionId), status: "delivered" }) }], details: { ...lifecycleUpdateDetails(update, target, submissionId), status: "delivered" } };
    },
  });
}
