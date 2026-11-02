import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text, stripTerminalSequences, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { toolCardFailureReason, renderToolCardCall, formatToolCardLine, cardBackground, compactRenderText } from "../../kit/tool-card.ts";
import { readNameRegistry } from "./session.ts";
import { normalizeTaskName } from "./names.ts";
import type { RuntimeRegistry } from "./registry.ts";
import { subagentFailureLabels, subagentStatusWord, type SubagentsTranslate } from "./messages/index.ts";
import { createParentUpdateQueue, createParentUpdateProducers, type ParentSessionUpdate } from "./parent-update-queue.ts";
import { agentTreeRootDir, readAgentTreeRecords } from "./agent-tree.ts";

export interface SendMessageToolDeps {
  registry: RuntimeRegistry;
  getArtifactDir: (sessionDir: string, sessionId: string) => string;
  handleSubagentSteer: (params: { name?: string; message?: string }) => unknown;
  readonly t?: SubagentsTranslate;
}

export interface ToolContext {
  sessionManager: { getSessionDir(): string; getSessionId(): string };
}

export interface Target {
  name: string;
  agentId: string;
  canonicalTaskName: string;
  status: string | null;
  managedLocally?: boolean;
  parentAgentId?: string | null;
  parentCanonicalTaskName?: string | null;
}

function callerAgentId(): string | null {
  const id = process.env.PI_SUBAGENT_ID?.trim();
  return id && id.length > 0 ? id : null;
}

function callerCanonical(): string {
  return canonicalParent();
}

function rootCanonical(): string {
  return "/root";
}

function canonicalParent(): string {
  return process.env.PI_SUBAGENT_TASK_PATH?.trim() || "/root";
}

function canonicalFor(name: string): string {
  return `${canonicalParent()}/${name}`;
}

function errorResult(code: string, message: string, details: Record<string, unknown> = {}) {
  const error = { code, message, ...details };
  return { content: [{ type: "text" as const, text: JSON.stringify(error) }], details: error, isError: true };
}

interface ResolvedEntry {
  name: string;
  agentId: string;
  canonicalTaskName: string;
  status: string | null;
  updatedAt: number;
  running: boolean;
  managedLocally?: boolean;
  parentAgentId?: string | null;
  parentCanonicalTaskName?: string | null;
}

function asTarget(entry: ResolvedEntry): Target {
  return {
    name: entry.name,
    agentId: entry.agentId,
    canonicalTaskName: entry.canonicalTaskName,
    status: entry.status,
    managedLocally: entry.managedLocally ?? true,
    parentAgentId: entry.parentAgentId ?? null,
    parentCanonicalTaskName: entry.parentCanonicalTaskName ?? null,
  };
}

function targetNames(deps: SendMessageToolDeps, ctx: ToolContext): ResolvedEntry[] {
  const live = deps.registry.list().map((entry) => ({
    name: entry.name,
    agentId: entry.id,
    canonicalTaskName: entry.canonicalTaskName ?? canonicalFor(entry.name),
    status: entry.publicStatus ?? (entry.waitMode === "recovered" ? "waiting" : "running"),
    updatedAt: entry.startTime,
    running: true,
  }));
  const artifactDir = deps.getArtifactDir(ctx.sessionManager.getSessionDir(), ctx.sessionManager.getSessionId());
  const publicRecords = deps.registry.listPublic(deps.registry.publicPathFor(artifactDir));
  const historical = publicRecords.map((record) => ({ name: record.task_name, agentId: record.agent_id, canonicalTaskName: record.canonical_task_name, status: record.status, updatedAt: record.updated_at, running: false }));
  const entries = historical.length > 0 ? historical : Object.keys(readNameRegistry(artifactDir)).map((name) => ({ name, agentId: "", canonicalTaskName: canonicalFor(name), status: null, updatedAt: 0, running: false }));
  const seen = new Set<string>();
  const merged = [...entries, ...live].filter((entry) => {
    const key = `${entry.agentId}:${entry.canonicalTaskName}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const localSessionId = ctx.sessionManager.getSessionId();
  const localIds = new Set(merged.map((entry) => entry.agentId).filter(Boolean));
  const remote = readAgentTreeRecords(agentTreeRootDir(artifactDir))
    .filter((record) => !localIds.has(record.agent_id))
    .map((record) => ({
      name: record.task_name,
      agentId: record.agent_id,
      canonicalTaskName: record.canonical_task_name,
      status: record.status,
      updatedAt: record.updated_at,
      running: record.status === "starting" || record.status === "running",
      managedLocally: record.owner_session_id === localSessionId,
      parentAgentId: record.parent_agent_id,
      parentCanonicalTaskName: record.parent_canonical_task_name,
    }));
  return [...merged.map((entry) => ({ ...entry, managedLocally: true as const, parentAgentId: null, parentCanonicalTaskName: null })), ...remote];
}

/**
 * Resolve a human/model-supplied name against the entries. Exact names win; only when nothing
 * matches exactly do we fall back to the same normalization `spawn_agent` applies, and even then
 * only when that folded form names exactly one agent. Two distinct names folding together
 * (`pi-x` and `pi_x`) stay ambiguous instead of silently picking one.
 */
function resolveNameMatches(
  entries: ResolvedEntry[],
  target: string,
): { entries: ResolvedEntry[] } | { error: ReturnType<typeof errorResult> } {
  const exact = entries.filter((entry) => entry.name === target);
  if (exact.length > 0) return { entries: exact };
  const normalized = normalizeTaskName(target);
  if (!normalized) return { entries: [] };
  const folded = entries.filter((entry) => normalizeTaskName(entry.name) === normalized);
  const distinctNames = [...new Set(folded.map((entry) => entry.name))];
  if (distinctNames.length > 1) {
    return {
      error: errorResult("target_ambiguous", `Normalized task name "${normalized}" matches multiple targets.`, {
        target,
        candidates: folded.map((entry) => ({ agent_id: entry.agentId, canonical_task_name: entry.canonicalTaskName })),
      }),
    };
  }
  return { entries: folded };
}

export function resolveLifecycleTarget(
  deps: SendMessageToolDeps,
  ctx: ToolContext,
  rawTarget: string,
  options: { preferLatestHistorical?: boolean } = {},
): { target: Target } | { error: ReturnType<typeof errorResult> } {
  const target = rawTarget.trim();
  if (!target) return { error: errorResult("target_not_found", "A non-empty target is required.", { target: rawTarget }) };
  const trimmedCanonical = target.replace(/\/+$/, "");
  if (trimmedCanonical === rootCanonical()) {
    return { error: errorResult("target_not_permitted", "The root agent is not a spawned agent; it cannot be targeted by lifecycle tools.", { target: rawTarget, reason: "root", canonical_task_name: rootCanonical() }) };
  }
  if ((callerAgentId() !== null && target === callerAgentId()) || trimmedCanonical === callerCanonical()) {
    return { error: errorResult("target_not_permitted", "An agent cannot target itself; its parent manages it.", { target: rawTarget, reason: "self" }) };
  }
  const liveById = deps.registry.get(target);
  if (liveById) {
    return {
      target: {
        name: liveById.name,
        agentId: liveById.id,
        canonicalTaskName: liveById.canonicalTaskName ?? canonicalFor(liveById.name),
        status: liveById.publicStatus ?? "running",
        managedLocally: true,
        parentAgentId: liveById.parentId ?? null,
        parentCanonicalTaskName: liveById.parentCanonicalTaskName ?? null,
      },
    };
  }

  const entries = targetNames(deps, ctx);
  if (target.startsWith("/")) {
    const matches = entries.filter((entry) => entry.canonicalTaskName === target);

    if (matches.length === 1) {
      return { target: asTarget(matches[0]!) };
    }
    if (matches.length > 1) return { error: errorResult("target_ambiguous", `Canonical task path "${target}" matches multiple targets.`, { target, candidates: matches.map((entry) => entry.name) }) };
    return { error: errorResult("target_not_found", `No subagent matches canonical task path "${target}".`, { target }) };
  }

  const nameMatches = resolveNameMatches(entries, target);
  if ("error" in nameMatches) return { error: nameMatches.error };
  const openMatches = nameMatches.entries.filter((entry) => entry.status !== "closed");
  const matches = openMatches.length > 0
    ? openMatches
    : [...nameMatches.entries].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 1);
  const idMatches = entries.filter((entry) => entry.agentId === target);
  if (idMatches.length > 1) {
    return { error: errorResult("target_ambiguous", `Agent id "${target}" matches multiple historical runs.`, { target, candidates: idMatches.map((entry) => ({ agent_id: entry.agentId, canonical_task_name: entry.canonicalTaskName })) }) };
  }
  if (idMatches.length === 1) {
    const match = idMatches[0]!;
    return { target: asTarget(match) };
  }
  const runningMatches = matches.filter((entry) => entry.running);
  if (matches.length > 1 && runningMatches.length === 1) {
    const match = runningMatches[0]!;
    return { target: asTarget(match) };
  }
  if (matches.length > 1) {
    if (options.preferLatestHistorical && runningMatches.length === 0) {
      const match = [...matches].sort((left, right) => right.updatedAt - left.updatedAt)[0]!;
      return { target: asTarget(match) };
    }
    return { error: errorResult("target_ambiguous", `Local task name "${target}" is ambiguous.`, { target, candidates: matches.map((entry) => ({ agent_id: entry.agentId, canonical_task_name: entry.canonicalTaskName })) }) };
  }
  if (matches.length === 1) {
    return { target: asTarget(matches[0]!) };
  }
  return { error: errorResult("target_not_found", `No subagent matches target "${target}".`, {
    target,
    candidates: entries.map((entry) => ({ agent_id: entry.agentId || null, canonical_task_name: entry.canonicalTaskName, task_name: entry.name })),
  }) };
}

export function targetManagedByParentError(target: Target, rawTarget: string) {
  const parentCanonical = target.parentCanonicalTaskName ?? null;
  const parentAgentId = target.parentAgentId ?? null;
  const label = parentCanonical ?? parentAgentId ?? "(its parent agent)";
  return errorResult(
    "target_managed_by_parent",
    `Subagent "${target.name}" is managed by ${label}; send the message to ${label} instead.`,
    {
      target: rawTarget,
      agent_id: target.agentId,
      task_name: target.name,
      status: target.status ?? null,
      parent_agent_id: parentAgentId,
      parent_canonical_task_name: parentCanonical,
    },
  );
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

/** 失败卡展开区的事实行：目标名 / 状态 / 运行时事实；写给模型的指令与原文不进用户卡。 */
export function lifecycleFailureFactLines(
  details: Record<string, unknown>,
  t?: SubagentsTranslate,
): string[] {
  const lines: string[] = [];
  const target = compactRenderText(details.task_name) || compactRenderText(details.target);
  if (target) lines.push(t?.("module.subagents.tool.meta.target", { name: target }) ?? `target ${target}`);
  const status = compactRenderText(details.status);
  if (status) {
    const word = subagentStatusWord(status, t);
    lines.push(t?.("module.subagents.tool.meta.status", { status: word }) ?? `status ${word}`);
  }
  const fact = compactRenderText(details.fact);
  if (fact) lines.push(fact);
  return lines;
}

export function registerSendMessageTool(pi: ExtensionAPI, deps: SendMessageToolDeps): void {
  pi.registerTool({
    name: "send_message",
    label: "Send Message",
    renderShell: "self",
    description: "Deliver an immediate message to an existing subagent in the current parent session. target accepts agent_id, canonical_task_name, or a unique local task name; peers short ids such as #62nvbt belong to peers_send. This never starts a new task round.",
    promptSnippet: "Send an immediate message using the agent_id, canonical path, or task name without starting a new round.",
    parameters: Type.Object({ target: Type.String({ minLength: 1 }), message: Type.String({ minLength: 1 }) }),
    renderCall(args, theme, context) {
      return renderToolCardCall(
        { title: deps.t?.("module.subagents.tool.send_message.display") ?? "Message subagent", object: args.target ?? "(target)" },
        theme,
        context,
      );
    },
    renderResult(result, options, theme, context) {
      const details = result.details as any;
      const submitted = typeof details?.submission_id === "string";
      const title = deps.t?.("module.subagents.tool.send_message.display") ?? "Message subagent";
      const object = typeof details?.task_name === "string" ? details.task_name : typeof details?.target === "string" ? details.target : undefined;
      const status = submitted
        ? deps.t?.("module.subagents.tool.send_message.result.submitted") ?? "Message submitted"
        : toolCardFailureReason(
            details,
            subagentFailureLabels(deps.t?.("module.subagents.tool.failure.send") ?? "Message not submitted", deps.t),
          );
      const message = typeof context?.args?.message === "string" ? context.args.message : "";
      const failureFacts = submitted ? [] : lifecycleFailureFactLines(details, deps.t);

      const component = {
        invalidate() {},
        render(width: number): string[] {
          const lineWidth = Math.max(1, width - 2);
          const lines = [formatToolCardLine({ title, object, status }, theme, context?.isError === true)];
          if (options.expanded) {
            const bodyLines = message
              .split("\n")
              .flatMap((line) => wrapTextWithAnsi(stripTerminalSequences(line), lineWidth));
            if (submitted && bodyLines.length > 0) {
              lines.push(
                "",
                theme.fg("muted", deps.t?.("module.subagents.tool.send_message.result.bodyLabel") ?? "Message text"),
                ...bodyLines.map((line) => theme.fg("toolOutput", line)),
              );
            }
            if (!submitted && failureFacts.length > 0) {
              lines.push("", ...failureFacts.map((entry) => theme.fg("dim", truncateToWidth(entry, lineWidth))));
            }
          }
          const box = new Box(1, 1, cardBackground(theme, context?.isError === true ? "toolErrorBg" : "toolSuccessBg"));
          box.addChild(new Text(lines.join("\n"), 0, 0));
          return ["", ...box.render(width)];
        },
      };
      return component;
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx: ToolContext) {
      const message = params.message.trim();
      if (!message) return errorResult("invalid_params", "message must be non-empty.");
      const resolved = resolveLifecycleTarget(deps, ctx, params.target);
      if ("error" in resolved) return resolved.error;
      const target = resolved.target;
      if (target.status === "closed") {
        const message = `Subagent "${target.name}" is closed; if you need to continue, spawn a new subagent.`;
        return errorResult("agent_closed", message, { target: params.target, agent_id: target.agentId, task_name: target.name, status: "closed" });
      }
      if (target.managedLocally === false) return targetManagedByParentError(target, params.target);
      if (!target.agentId || !deps.registry.has(target.agentId)) {
        const status = target.status;
        const message = status === "waiting"
          ? `Subagent "${target.name}" had its current round interrupted and is waiting; immediate messages cannot be delivered. Use followup_task with this message to start the next round.`
          : status && ["completed", "failed", "interrupted"].includes(status)
            ? `Subagent "${target.name}" has already finished (${status}) and cannot receive an immediate message. Use followup_task to start a new round if its context is recoverable.`
            : `Subagent "${target.name}" is not running and cannot receive an immediate message. If its session context is recoverable, use followup_task to start a new round.`;
        return errorResult("target_not_receivable", message, { target: params.target, agent_id: target.agentId, task_name: target.name, status: status ?? null });
      }
      const delivered = deps.handleSubagentSteer({ name: target.name, message }) as any;
      if (delivered?.details?.error) {
        const errorFact = String(delivered.details.error);
        return errorResult("target_not_receivable", `${errorFact} If its session context is recoverable, use followup_task to start a new round.`, { target: params.target, agent_id: target.agentId, task_name: target.name, status: target.status ?? null, fact: errorFact });
      }
      const submissionId = `message-${randomUUID()}`;
      const update = lifecycleQueue(deps, ctx).message({
        agent_id: target.agentId,
        task_name: target.name,
        status: "running",
        summary: deps.t?.("module.subagents.updates.messageSubmitted") ?? "Immediate message submitted.",
        update_id: submissionId,
      });
      const ids = lifecycleUpdateDetails(update, target, submissionId);
      const text =
        `Message submitted to subagent "${target.name}" (submission id ${submissionId}, agent id ${target.agentId}, ` +
        `canonical task name ${target.canonicalTaskName}, update id ${update.update_id}). ` +
        `This records the submission and the runtime's delivery attempt at the subagent's next turn boundary. ` +
        `There is no acknowledgement: nothing here proves that the subagent read the message or added it to its context, ` +
        `and the message may never be processed if the subagent exits first.`;
      return { content: [{ type: "text" as const, text }], details: { ...ids, status: "submitted" } };
    },
  });
}
