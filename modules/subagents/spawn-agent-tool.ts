import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Box, Text, stripTerminalSequences, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { readNameRegistry, registerName } from "./session.ts";
import { validateCodexV2ModelSelection, validateCodexV2SpawnParams, createCodexV2LaunchError, normalizeForkTurns, type CodexV2SpawnParams } from "./protocol.ts";
import type { ModelDirectory } from "./model-selector.ts";
import type { RuntimeRegistry } from "./registry.ts";
import type { SubagentStartup } from "./startup.ts";
import type { RunningSubagent, SubagentResult } from "./types.ts";
import { detectDisplayModeAvailability, displayFallbackCause, explainDisplayFallback, resolveDisplaySurface } from "./surface.ts";
import { createParentUpdateQueue, createParentUpdateProducers } from "./parent-update-queue.ts";
import {
  agentTreeRootDir,
  appendRunningAgentTreeRecord,
  terminalOutcomeFromTree,
  writeAgentTerminal,
} from "./agent-tree.ts";
import { deriveTaskNameFromMessage, normalizeTaskName } from "./names.ts";
import type { SubagentsTranslate } from "./messages/index.ts";
import { subagentsTableTranslator } from "./messages/index.ts";
import { lifecycleFailureFactLines } from "./send-message-tool.ts";
import { compactRenderText, renderToolCardCall, renderToolCardResult, formatToolCardLine, cardBackground } from "../../kit/tool-card.ts";

const DEFAULT_AGENT_TYPE = "general-purpose";

export interface SpawnNormalization {
  readonly field: "task_name" | "agent_type" | "display_mode" | "model" | "reasoning_effort" | "fork_turns";
  readonly reason: "derived" | "normalized" | "suffixed" | "unknown" | "near_match";
  readonly requested: string | null;
  readonly resolved: string;
}

const DISPLAY_MODE_VALUES = ["auto", "herdr", "tmux"] as const;

/** Absent and unrecognized display modes both fall through to the configured mode. */
function normalizeDisplayMode(value: unknown): "auto" | "herdr" | "tmux" | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return (DISPLAY_MODE_VALUES as readonly string[]).includes(normalized)
    ? (normalized as "auto" | "herdr" | "tmux")
    : null;
}

/**
 * Agent types are a closed set owned by the plugin, so an unknown value is a user-input
 * error we can absorb: fall back to general-purpose and say so in the result.
 */
function resolveAgentType(requested: unknown, allowed: readonly string[], notes: SpawnNormalization[]): string {
  const raw = typeof requested === "string" ? requested.trim() : "";
  const fold = (value: string) => value.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (raw) {
    const exact = allowed.find((name) => name === raw);
    if (exact) return exact;
    const folded = allowed.find((name) => fold(name) === fold(raw));
    if (folded) {
      if (folded !== raw) notes.push({ field: "agent_type", reason: "normalized", requested: raw, resolved: folded });
      return folded;
    }
  }
  const fallback = allowed.find((name) => name === DEFAULT_AGENT_TYPE) ?? allowed[0]!;
  if (raw) notes.push({ field: "agent_type", reason: "unknown", requested: raw, resolved: fallback });
  return fallback;
}

function agentTypeDescription(names: readonly string[]): string {
  return names.length > 0
    ? `Optional string; omit it to use ${DEFAULT_AGENT_TYPE}. Available: ${names.join(", ")}. An unknown value falls back to ${DEFAULT_AGENT_TYPE} and the result says so.`
    : `Optional string; omit it to use ${DEFAULT_AGENT_TYPE}. Call subagent_models to list the available agent names.`;
}

/**
 * Plain string on purpose: a literal union would be rejected by the host schema before
 * `execute` runs, and the plugin could neither normalize it nor explain the failure.
 */
function agentTypeParameterSchema(discoverAgents: () => Array<{ name: string }>) {
  let names: string[] = [];
  try {
    names = [...new Set(discoverAgents().map((agent) => agent.name).filter((name) => typeof name === "string" && name.length > 0))].sort();
  } catch {
    // Agent discovery can be temporarily unavailable; discovery at execute time stays authoritative.
  }
  return Type.Optional(Type.String({ description: agentTypeDescription(names) }));
}

const TASK_NAME_DESCRIPTION =
  "Optional. Any text is accepted and folded into a handle: lowercase ASCII letters, digits and underscores, at most 72 characters. Separators, spaces, punctuation and case are normalized, overlong names are truncated, and a name already in use gets a numeric suffix. Omit it to derive a name from message. The result always reports the final task_name.";

const FORK_TURNS_DESCRIPTION =
  "Optional; all by default. all inherits the parent conversation text only — user and assistant messages, without tool calls or tool results — so put context the child needs into message. none starts with only the task context. Case and whitespace are tolerated; any other value falls back to all and the result says so.";

const FALLBACK_T = subagentsTableTranslator("en");

const SPAWN_FALLBACK_CAUSE_KEYS: Record<string, Parameters<SubagentsTranslate>[0]> = {
  "env-not-set": "module.subagents.tool.spawn_agent.result.fallback.envNotSet",
  "cli-unavailable": "module.subagents.tool.spawn_agent.result.fallback.cliUnavailable",
  "no-availability-info": "module.subagents.tool.spawn_agent.result.fallback.noInfo",
  context: "module.subagents.tool.spawn_agent.result.fallback.context",
};

function spawnFallbackReasonText(cause: string, mode: string, t: SubagentsTranslate | undefined): string {
  const key = SPAWN_FALLBACK_CAUSE_KEYS[cause];
  return key ? (t ?? FALLBACK_T)(key, { mode }) : "";
}

/** User-facing lines for values the plugin normalized; internal field names stay out of the card. */
function spawnNormalizationLines(value: unknown, t: SubagentsTranslate | undefined): string[] {
  if (!Array.isArray(value)) return [];
  const lines: string[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const note = raw as Partial<SpawnNormalization>;
    const requested = compactRenderText(note.requested);
    const resolved = compactRenderText(note.resolved);
    if (!resolved) continue;
    if (note.field === "task_name") {
      // A rename is shown once, as the "originally requested" line below; only a derived
      // name (no original value) keeps its own note.
      if (note.reason === "derived") {
        lines.push(t?.("module.subagents.tool.spawn_agent.result.note.taskNameDerived", { name: resolved }) ?? `Task name derived from the message: ${resolved}`);
      }
      continue;
    }
    if (note.field === "agent_type") {
      lines.push(t?.("module.subagents.tool.spawn_agent.result.note.agentTypeChanged", { requested, name: resolved }) ?? `Agent type ${requested} -> ${resolved}`);
      continue;
    }
    if (note.field === "display_mode") {
      lines.push(t?.("module.subagents.tool.spawn_agent.result.note.displayModeChanged", { requested, name: resolved }) ?? `Display mode ${requested} -> ${resolved}`);
      continue;
    }
    if (note.field === "model") {
      lines.push(t?.("module.subagents.tool.spawn_agent.result.note.modelChanged", { requested, name: resolved }) ?? `Model ${requested} -> ${resolved}`);
      continue;
    }
    if (note.field === "reasoning_effort") {
      lines.push(t?.("module.subagents.tool.spawn_agent.result.note.effortChanged", { requested, name: resolved }) ?? `Reasoning effort ${requested} -> ${resolved}`);
      continue;
    }
    if (note.field === "fork_turns") {
      lines.push(t?.("module.subagents.tool.spawn_agent.result.note.forkTurnsChanged", { requested, name: resolved }) ?? `fork turns ${requested} is not a choice; using ${resolved}`);
    }
  }
  return lines;
}

export type DeliverTerminal = (running: RunningSubagent, result: SubagentResult, source: "spawn" | "followup" | "recovered-exit" | "recovered-headless" | "recovered-pane", deliveryId: string) => void;

export interface SpawnAgentToolDeps {
  readonly startup: SubagentStartup;
  readonly registry: RuntimeRegistry;
  readonly discoverAgents: () => Array<{ name: string }>;
  readonly getArtifactDir: (sessionDir: string, sessionId: string) => string;
  readonly resolveDisplayMode?: (ctx: ExtensionContext, requested?: unknown) => "auto" | "herdr" | "tmux";
  readonly getModelDirectory: (ctx: ExtensionContext) => ModelDirectory;
  readonly deliverTerminal?: DeliverTerminal;
  readonly t?: SubagentsTranslate;
}

function parentTaskDepth(): number {
  const path = process.env.PI_SUBAGENT_TASK_PATH ?? "/root";
  const parts = path.split("/").filter(Boolean);
  return parts[0] === "root" ? Math.max(0, parts.length - 1) : parts.length;
}

function errorResult(error: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(error) }], details: error, isError: true };
}

function displayError(mode: string): Record<string, unknown> {
  return createCodexV2LaunchError({
    code: "agent_launch_failed",
    message: `Display mode "${mode}" is unavailable in the current environment.`,
    selectedModel: null,
    reasoning_effort: null,
    display_mode: mode as "auto" | "herdr" | "tmux",
    underlying_error: "display_unavailable",
  });
}

function spawnFailureReason(
  details: Record<string, unknown>,
  t: SubagentsTranslate | undefined,
): string {
  const code = typeof details.code === "string" ? details.code : "";
  switch (code) {
    case "agent_type_unknown": {
      const type = compactRenderText(details.requested) || compactRenderText(details.agent_type) || "(unknown)";
      return t?.("module.subagents.tool.spawn_agent.result.failure.agentTypeUnknown", { type }) ?? `Unknown subagent type ${type}`;
    }
    case "agent_definitions_unavailable":
      return t?.("module.subagents.tool.spawn_agent.result.failure.agentDefinitionsUnavailable") ?? "No subagent definitions were discovered";
    case "model_ambiguous":
      return t?.("module.subagents.tool.spawn_agent.result.failure.modelAmbiguous") ?? "The model name matches multiple providers";
    case "model_not_found":
      return t?.("module.subagents.tool.spawn_agent.result.failure.modelNotFound") ?? "The model was not found";
    case "model_key_deprecated":
      return t?.("module.subagents.tool.spawn_agent.result.failure.modelKeyDeprecated") ?? "The model key is deprecated";
    case "reasoning_effort_unsupported":
      return t?.("module.subagents.tool.spawn_agent.result.failure.reasoningUnsupported") ?? "The reasoning level is unsupported";
    case "task_name_conflict":
      return t?.("module.subagents.tool.spawn_agent.result.failure.taskNameConflict") ?? "The task name is already in use";
    case "invalid_params":
      return t?.("module.subagents.tool.spawn_agent.result.failure.invalidParams") ?? "The spawn parameters are invalid";
    case "agent_depth_limit":
      return t?.("module.subagents.tool.spawn_agent.result.failure.agentDepthLimit") ?? "The subagent depth limit was reached";
    case "agent_launch_failed":
      return t?.("module.subagents.tool.spawn_agent.result.failure.agentLaunchFailed") ?? "The subagent could not be launched";
    default:
      return t?.("module.subagents.tool.spawn_agent.result.failure.unknown") ?? "The subagent could not be started";
  }
}

export function registerSpawnAgentTool(pi: ExtensionAPI, deps: SpawnAgentToolDeps): void {
  pi.registerTool({
    name: "spawn_agent",
    label: "Spawn Agent",
    renderShell: "self",
    description:
      "Start a sub-agent and return immediately. Read subagent_models first; agent_type is optional and defaults to general-purpose. Choose model and reasoning_effort from the same directory. model accepts a unique model id/name or an exact provider/model route. " +
      "If multiple providers expose the same name, pass the provider/model route from the directory. " +
      "fork_turns is optional and defaults to all: all inherits the parent conversation text only (user and assistant messages, no tool calls and no tool results), so put every context the child needs into message; none starts with only the task context. " +
      "Delegation is capped at one more level: an agent at depth 1 holds this tool and may delegate one more level; an agent at depth 2 does not receive this tool and must complete the task itself. " +
      "Spelling variants of a model reference are accepted and the result reports the resolved route; a reference that is not close to anything returns model_not_found with up to three suggestions, ordered same-family first, then substring matches, then nearest by name distance. " +
      "model is required and has no default; do not omit it. " +
      "The run posts progress updates to the parent queue and its terminal result is delivered to this session automatically as a message — use wait_agent to receive updates, followup_task to continue the run, and close_agent to release the name. " +
      "The returned agent_id and canonical_task_name identify the new run.",
    promptSnippet: "Start an agent; fork_turns defaults to all (inherits the parent text conversation), pass none to start with only the task.",
    parameters: Type.Object({
      task_name: Type.Optional(Type.String({ description: TASK_NAME_DESCRIPTION })),
      message: Type.String({ minLength: 1, description: "The task for the new sub-agent: concrete work, needed context, and expected output. It becomes the sub-agent's first turn." }),
      agent_type: agentTypeParameterSchema(deps.discoverAgents),
      fork_turns: Type.Optional(Type.String({ description: FORK_TURNS_DESCRIPTION })),
      model: Type.String({ description: "Required, no default: pick from subagent_models. Accepts an exact provider/model route, a unique id or display name, case/separator variants of either, or a unique near match; the result reports the resolved route. When several providers expose the same name, pass the provider/model route from the directory." }),
      reasoning_effort: Type.Optional(Type.String({ description: "Optional reasoning effort; omit it to inherit the parent session level. Levels are listed per model in subagent_models. A level the chosen model does not support is clamped to the nearest supported one and the result says so." })),
      display_mode: Type.Optional(Type.String({ description: "auto (default): use a pane surface when the current environment provides herdr or tmux, otherwise run in the background. herdr or tmux: request that surface; when it is unavailable the run falls back to the background and the result says why. Agents nested inside other sub-agents always run in the background. Unknown values fall back to auto and the result says so." })),
    }),
    renderCall(args, theme, context) {
      const taskName = compactRenderText(args.task_name) || "(task)";
      return renderToolCardCall(
        { title: deps.t?.("module.subagents.tool.spawn_agent.display") ?? "Spawn subagent", object: taskName },
        theme,
        context,
      );
    },
    renderResult(result, options, theme, context) {
      const details = (result.details ?? {}) as Record<string, unknown> & {
        resolved?: {
          model?: unknown;
          reasoning_effort?: unknown;
          agent_type?: unknown;
          fork_turns?: unknown;
          display_mode?: unknown;
          resolved_display_mode?: unknown;
          display_policy?: unknown;
          fallback_reason?: unknown;
          fallback_cause?: unknown;
          display_note?: unknown;
        };
      };
      const args = (context?.args ?? {}) as { task_name?: unknown; message?: unknown };
      // The receipt carries the final (possibly normalized) name; the raw argument is only a fallback.
      const taskName = compactRenderText(details.task_name) || compactRenderText(args.task_name) || "(task)";
      const succeeded = context?.isError !== true && details.status === "running";
      if (!succeeded) {
        const reason = spawnFailureReason(details, deps.t);
        return renderToolCardResult(
          {
            title: deps.t?.("module.subagents.tool.spawn_agent.display") ?? "Spawn subagent",
            object: taskName,
            status: deps.t?.("module.subagents.tool.spawn_agent.result.failed", { reason }) ?? `Launch failed: ${reason}`,
            details: lifecycleFailureFactLines(details, deps.t),
          },
          theme,
          options,
          context,
        );
      }
      const t = deps.t;
      const started = t?.("module.subagents.tool.spawn_agent.result.started") ?? "Started";
      const title = t?.("module.subagents.tool.spawn_agent.display") ?? "Spawn subagent";
      const resolved = details.resolved ?? {};
      const metaLines: string[] = [];
      const agentType = compactRenderText(resolved.agent_type);
      const forkTurns = compactRenderText(resolved.fork_turns);
      if (agentType || forkTurns) {
        const parts = [
          agentType ? t?.("module.subagents.tool.spawn_agent.result.agentTag", { type: agentType }) ?? `agent ${agentType}` : "",
          forkTurns ? t?.("module.subagents.tool.spawn_agent.result.forkTag", { fork: forkTurns }) ?? `fork ${forkTurns}` : "",
        ].filter(Boolean);
        metaLines.push(parts.join(" · "));
      }
      const model = compactRenderText(resolved.model);
      const reasoning = compactRenderText(resolved.reasoning_effort);
      if (model) {
        metaLines.push([
          t?.("module.subagents.tool.spawn_agent.result.modelTag", { model }) ?? `model ${model}`,
          reasoning ? t?.("module.subagents.tool.spawn_agent.result.thinkingTag", { level: reasoning }) ?? `thinking ${reasoning}` : "",
        ].filter(Boolean).join(" · "));
      }
      const resolvedSurface = compactRenderText(resolved.resolved_display_mode);
      const displayMode = resolvedSurface || compactRenderText(resolved.display_mode);
      if (displayMode) {
        const fallbackCause = compactRenderText(resolved.fallback_cause);
        const displayPolicy = compactRenderText(resolved.display_policy);
        let reasonText = "";
        if (fallbackCause) {
          reasonText = spawnFallbackReasonText(fallbackCause, compactRenderText(resolved.display_mode) || displayMode, t);
        } else if (displayPolicy) {
          reasonText = displayPolicy === "nested_agent_forced_background"
            ? t?.("module.subagents.tool.spawn_agent.result.displayPolicy.nested") ?? "nested agents always run in the background"
            : "";
        }
        const modeLabel = resolvedSurface === "background"
          ? t?.("module.subagents.tool.spawn_agent.result.displayTag.background") ?? "background run"
          : t?.("module.subagents.tool.spawn_agent.result.displayTag", { mode: displayMode }) ?? `display ${displayMode}`;
        metaLines.push([modeLabel, reasonText].filter(Boolean).join(" · "));
      }
      const taskBody = typeof args.message === "string" ? args.message : "";
      const normalizationLines = spawnNormalizationLines(details.normalizations, t);
      const requestedName = details.renamed === true ? compactRenderText(details.requested_task_name) : "";
      const originalNameLine = requestedName
        ? t?.("module.subagents.tool.spawn_agent.result.originalName", { name: requestedName }) ?? `originally requested: ${requestedName}`
        : "";
      const component = {
        invalidate() {},
        render(width: number): string[] {
          const lineWidth = Math.max(1, width - 2);
          const lines = [formatToolCardLine({ title, object: taskName, status: started }, theme, false)];
          if (options.expanded) {
            if (originalNameLine) lines.push(theme.fg("muted", truncateToWidth(originalNameLine, lineWidth)));
            for (const note of normalizationLines) lines.push(theme.fg("muted", truncateToWidth(note, lineWidth)));
            for (const meta of metaLines) lines.push(theme.fg("dim", truncateToWidth(meta, lineWidth)));
            if (taskBody.trim() !== "") {
              lines.push(
                "",
                theme.fg("muted", t?.("module.subagents.tool.spawn_agent.result.taskLabel") ?? "task"),
                ...taskBody.split("\n").flatMap((line) => wrapTextWithAnsi(stripTerminalSequences(line), lineWidth)).map((line) => theme.fg("toolOutput", line)),
              );
            }
          }
          const box = new Box(context?.outputPad ?? 1, 1, cardBackground(theme, "toolSuccessBg"));
          box.addChild(new Text(lines.join("\n"), 0, 0));
          return ["", ...box.render(width)];
        },
      };
      return component;
    },
    async execute(_toolCallId, raw, _signal, _onUpdate, ctx) {
      if (parentTaskDepth() >= 2) {
        return errorResult({
          code: "agent_depth_limit",
          message: "Agents at depth 2 or deeper cannot spawn additional sub-agents.",
        });
      }
      const validated = validateCodexV2SpawnParams(raw);
      if (!validated.ok) return errorResult({ code: "invalid_params", message: "Invalid spawn_agent parameters.", details: validated.errors });
      const input: CodexV2SpawnParams = validated.value;
      const normalizations: SpawnNormalization[] = [];
      const forkTurns = normalizeForkTurns(input.fork_turns);
      if (forkTurns.unknown) {
        normalizations.push({ field: "fork_turns", reason: "unknown", requested: forkTurns.requested ?? "", resolved: forkTurns.fork_turns });
      }
      const requestedTaskName = typeof input.task_name === "string" ? input.task_name.trim() : "";
      let taskName = normalizeTaskName(input.task_name);
      if (!taskName) {
        taskName = deriveTaskNameFromMessage(input.message) || normalizeTaskName(input.agent_type) || DEFAULT_AGENT_TYPE;
        normalizations.push({ field: "task_name", reason: "derived", requested: requestedTaskName || null, resolved: taskName });
      } else if (taskName !== requestedTaskName) {
        normalizations.push({ field: "task_name", reason: "normalized", requested: requestedTaskName, resolved: taskName });
      }

      const availableAgents = [...new Set(deps.discoverAgents().map((candidate) => candidate.name))];
      if (availableAgents.length === 0) {
        return errorResult({
          code: "agent_definitions_unavailable",
          message: "No agent definitions were discovered.",
          requested: input.agent_type ?? DEFAULT_AGENT_TYPE,
          available: [],
        });
      }
      const agent = resolveAgentType(input.agent_type, availableAgents, normalizations);

      const directory = deps.getModelDirectory(ctx);
      const requestedEffort = (typeof input.reasoning_effort === "string" ? input.reasoning_effort.trim() : "")
        || (typeof ctx.thinkingLevel === "string" ? ctx.thinkingLevel : "");
      const selected = validateCodexV2ModelSelection(directory, input.model, requestedEffort || undefined);
      if (!selected.ok) return errorResult(createCodexV2LaunchError({
        code: selected.code,
        message: selected.message,
        selectedModel: input.model,
        reasoning_effort: selected.details.reasoning_effort || null,
        display_mode: normalizeDisplayMode(input.display_mode) ?? null,
        underlying_error: selected.details,
      }));
      if (selected.effort_note) {
        normalizations.push({ field: "reasoning_effort", reason: "normalized", requested: requestedEffort, resolved: selected.reasoning_effort });
      }
      if (selected.match_note) {
        normalizations.push({
          field: "model",
          reason: selected.match_note === "folded" ? "normalized" : "near_match",
          requested: input.model,
          resolved: `${selected.model.provider}/${selected.model.id}`,
        });
      }

      const nestedAgentPolicy = parentTaskDepth() >= 1;
      const displayModeInput = normalizeDisplayMode(input.display_mode);
      const requestedMode = nestedAgentPolicy ? "auto" : (deps.resolveDisplayMode?.(ctx, displayModeInput ?? undefined) ?? (displayModeInput ?? "auto"));
      if (input.display_mode !== undefined && displayModeInput === null) {
        normalizations.push({ field: "display_mode", reason: "unknown", requested: String(input.display_mode), resolved: requestedMode });
      } else if (displayModeInput !== null && displayModeInput !== input.display_mode) {
        normalizations.push({ field: "display_mode", reason: "normalized", requested: String(input.display_mode), resolved: displayModeInput });
      }
      const availability = detectDisplayModeAvailability();
      const resolvedSurface = resolveDisplaySurface(requestedMode, availability);
      if (typeof resolvedSurface === "object") return errorResult(displayError(requestedMode));
      const fallbackReason = explainDisplayFallback(requestedMode, availability, resolvedSurface);
      const fallbackDetails = fallbackReason
        ? {
            fallback_reason: fallbackReason,
            fallback_cause: displayFallbackCause(requestedMode, availability, resolvedSurface),
            display_note: `Requested display_mode "${requestedMode}" but it fell back to a background run: ${fallbackReason}.`,
          }
        : {};
      const surface = resolvedSurface === "background" ? "background" : "pane";
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) return errorResult({ code: "agent_launch_failed", message: "A persistent parent session is required." });
      const artifactDir = deps.getArtifactDir(ctx.sessionManager.getSessionDir(), ctx.sessionManager.getSessionId());
      // A name that is already in use is never a failure: suffix it and report the final value.
      const takenNames = new Set<string>();
      for (const record of deps.registry.listPublic(deps.registry.publicPathFor(artifactDir))) {
        if (record.status !== "closed") takenNames.add(record.task_name);
      }
      for (const registered of Object.keys(readNameRegistry(artifactDir))) takenNames.add(registered);
      const finalTaskName = deps.registry.uniqueName(taskName, takenNames);
      if (finalTaskName !== taskName) {
        normalizations.push({ field: "task_name", reason: "suffixed", requested: taskName, resolved: finalTaskName });
        taskName = finalTaskName;
      }
      deps.registry.reserveName(taskName);
      try {
        const route = `${selected.model.provider}/${selected.model.id}`;
        const params = {
          agent,
          task: input.message,
          name: taskName,
          model: route,
          thinking: selected.reasoning_effort,
          surface,
          display_mode: requestedMode,
          modelIdentity: selected.model,
        } as any;
        const planned = deps.startup.planSpawn(params, ctx, { protocol: "codex-v2", forkTurns: forkTurns.fork_turns });
        if (planned.kind === "error") return errorResult(createCodexV2LaunchError({
          code: "agent_launch_failed",
          message: planned.error,
          selectedModel: input.model,
          reasoning_effort: selected.reasoning_effort,
          display_mode: requestedMode,
          resolved_display_mode: resolvedSurface,
          underlying_error: planned.details ?? null,
        }));
        let started: Awaited<ReturnType<SubagentStartup["spawn"]>>;
        try {
          started = await deps.startup.spawn(planned.plan, ctx, pi);
        } catch (error) {
          return errorResult(createCodexV2LaunchError({
            code: "agent_launch_failed",
            message: error instanceof Error ? error.message : String(error),
            selectedModel: input.model,
            reasoning_effort: selected.reasoning_effort,
            display_mode: requestedMode,
            resolved_display_mode: resolvedSurface,
            underlying_error: error instanceof Error ? error.message : String(error),
          }));
        }
        const canonicalParent = process.env.PI_SUBAGENT_TASK_PATH ?? "/root";
        const canonical = `${canonicalParent}/${taskName}`;
        registerName(artifactDir, taskName, {
          sessionFile: started.running.sessionFile,
          sessionId: null,
          agentId: started.running.id,
          anchored: started.running.anchoredLoadout,
        });
        const rootDir = agentTreeRootDir(artifactDir);
        const ownerSessionId = ctx.sessionManager.getSessionId();
        const producers = createParentUpdateProducers(createParentUpdateQueue(artifactDir));
        producers.spawnStatus({ agent_id: started.running.id, task_name: taskName, status: "starting", summary: "Spawn accepted and starting.", update_id: `spawn:${started.running.id}:starting` });
        producers.spawnStatus({ agent_id: started.running.id, task_name: taskName, status: "running", summary: "Subagent is running.", update_id: `spawn:${started.running.id}:running` });
        appendRunningAgentTreeRecord({ rootDir, running: started.running, status: "running", summary: "Subagent is running.", artifactDir, ownerSessionId });
        void started.watch.then((watchResult: any) => {
          if (started.running.closed) return;
          if (watchResult?.interruptedRound || watchResult?.handedOff) return;
          const failureStatus = watchResult?.userClosed || watchResult?.stopped ? "interrupted" : watchResult?.exitCode === 0 ? "completed" : "failed";
          const outcome = terminalOutcomeFromTree(rootDir, started.running.id, failureStatus);
          if (outcome.action === "skip") {
            started.running.closed = true;
            return;
          }
          const status = outcome.status;
          const summary = watchResult?.summary || watchResult?.errorMessage || "Subagent finished.";
          const update = (watchResult?.userClosed ? producers.surfaceClosed : producers.watcherTerminal)({ agent_id: started.running.id, task_name: taskName, status, summary, update_id: `spawn:${started.running.id}:terminal`, final_text: watchResult?.summary || watchResult?.errorMessage || undefined });
          writeAgentTerminal({ rootDir, running: started.running, status, summary, artifactDir, ownerSessionId, update });
          deps.deliverTerminal?.(started.running, watchResult as SubagentResult, "spawn", update.delivery_id);
          void update;
        }).catch((error) => {
          if (started.running.closed) return;
          const outcome = terminalOutcomeFromTree(rootDir, started.running.id, "failed");
          if (outcome.action === "skip") {
            started.running.closed = true;
            return;
          }
          const summary = error instanceof Error ? error.message : String(error);
          const update = producers.watcherTerminal({ agent_id: started.running.id, task_name: taskName, status: outcome.status, summary, update_id: `spawn:${started.running.id}:terminal` });
          writeAgentTerminal({ rootDir, running: started.running, status: outcome.status, summary, artifactDir, ownerSessionId, update });
        });
        const nestedPolicy = nestedAgentPolicy ? { display_policy: "nested_agent_forced_background" } : {};
        const renamed = taskName !== requestedTaskName;
        const receipt = {
          agent_id: started.running.id,
          task_name: taskName,
          canonical_task_name: canonical,
          status: "running",
          renamed,
          ...(requestedTaskName === "" || requestedTaskName === taskName ? {} : { requested_task_name: requestedTaskName }),
          ...(normalizations.length > 0 ? { normalizations } : {}),
          resolved: {
            model: route,
            reasoning_effort: selected.reasoning_effort,
            display_mode: requestedMode,
            resolved_display_mode: resolvedSurface,
            ...nestedPolicy,
            fork_turns: forkTurns.fork_turns,
            ...(started.inherited ?? {}),
            agent_type: agent,
            ...fallbackDetails,
          },
        };
        return {
          content: [{ type: "text", text: JSON.stringify(receipt) }],
          details: receipt,
        };
      } finally {
        deps.registry.releaseName(taskName);
      }
    },
  });
}
