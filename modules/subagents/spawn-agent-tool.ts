import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readNameRegistry, registerName } from "./session.ts";
import { validateCodexV2ModelSelection, validateCodexV2SpawnParams, createCodexV2LaunchError, type CodexV2SpawnParams } from "./protocol.ts";
import type { ModelDirectory } from "./model-selector.ts";
import type { RuntimeRegistry } from "./registry.ts";
import type { SubagentStartup } from "./startup.ts";
import type { RunningSubagent, SubagentResult } from "./types.ts";
import { detectDisplayModeAvailability, resolveDisplaySurface } from "./surface.ts";
import { createParentUpdateQueue, createParentUpdateProducers } from "./parent-update-queue.ts";
import type { SubagentsTranslate } from "./messages/index.ts";
import { compactRenderText, renderToolCardCall, renderToolCardResult } from "../../kit/tool-card.ts";

const DEFAULT_AGENT_TYPE = "general-purpose";

function agentTypeParameterSchema(discoverAgents: () => Array<{ name: string }>) {
  let names: string[] = [];
  try {
    names = [...new Set(discoverAgents().map((agent) => agent.name).filter((name) => typeof name === "string" && name.length > 0))].sort();
  } catch {
    // Runtime validation below remains authoritative when discovery is temporarily unavailable.
  }
  if (names.length === 0) return Type.Optional(Type.String({ minLength: 1, description: "Choose one of the available agent names reported by subagent_models." }));
  if (names.length === 1) return Type.Optional(Type.Literal(names[0]!));
  return Type.Optional(Type.Union(names.map((name) => Type.Literal(name))));
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
      "Start a sub-agent and return immediately. Read subagent_models first; choose agent_type from the available agent choices, and choose model and reasoning_effort from the same directory. model accepts a unique model id/name or an exact provider/model route. " +
      "If multiple providers expose the same name, pass the provider/model route from the directory. " +
      "Choose fork_turns explicitly: none starts with only the task context, all inherits the parent history. " +
      "The field is required; do not omit it. " +
      "The returned agent_id and canonical_task_name identify the new run.",
    promptSnippet: "Start an agent, choose fork_turns explicitly (none or all), and do not omit it.",
    parameters: Type.Object({
      task_name: Type.String({ minLength: 1, maxLength: 72, pattern: "^[a-z0-9_]+$" }),
      message: Type.String({ minLength: 1 }),
      agent_type: agentTypeParameterSchema(deps.discoverAgents),
      fork_turns: Type.Union([Type.Literal("none"), Type.Literal("all")]),
      model: Type.String({ minLength: 1 }),
      reasoning_effort: Type.String({ minLength: 1 }),
      display_mode: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("herdr"), Type.Literal("tmux")])),
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
        };
      };
      const args = (context?.args ?? {}) as { task_name?: unknown };
      const taskName = compactRenderText(args.task_name) || compactRenderText(details.task_name) || "(task)";
      const succeeded = details.status === "running";
      if (!succeeded) {
        const reason = spawnFailureReason(details, deps.t);
        const rawMessage = compactRenderText(details.message);
        return renderToolCardResult(
          {
            title: deps.t?.("module.subagents.tool.spawn_agent.display") ?? "Spawn subagent",
            object: taskName,
            status: deps.t?.("module.subagents.tool.spawn_agent.result.failed", { reason }) ?? `Launch failed: ${reason}`,
            details: rawMessage ? [rawMessage] : [],
          },
          theme,
          options,
          context,
        );
      }
      const started = deps.t?.("module.subagents.tool.spawn_agent.result.started") ?? "Started";
      const model = compactRenderText(details.resolved?.model);
      const reasoning = compactRenderText(details.resolved?.reasoning_effort);
      return renderToolCardResult(
        {
          title: deps.t?.("module.subagents.tool.spawn_agent.display") ?? "Spawn subagent",
          object: taskName,
          status: started,
          details: [model ? `model: ${model}` : "", reasoning ? `reasoning_effort: ${reasoning}` : ""].filter(Boolean),
        },
        theme,
        options,
        context,
      );
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
      const agent = input.agent_type ?? DEFAULT_AGENT_TYPE;
      const allowed = new Set(deps.discoverAgents().map((candidate) => candidate.name));
      if (!allowed.has(agent)) {
        const available = [...allowed];
        if (available.length === 0) {
          return errorResult({
            code: "agent_definitions_unavailable",
            message: "No agent definitions were discovered.",
            requested: agent,
            available,
          });
        }
        return errorResult({
          code: "agent_type_unknown",
          message: `Unknown agent_type "${agent}". Available: ${available.join(", ")}.`,
          requested: agent,
          available,
        });
      }

      const directory = deps.getModelDirectory(ctx);
      const selected = validateCodexV2ModelSelection(directory, input.model, input.reasoning_effort);
      if (!selected.ok) return errorResult(createCodexV2LaunchError({
        code: selected.code,
        message: selected.message,
        selectedModel: input.model,
        reasoning_effort: input.reasoning_effort,
        display_mode: input.display_mode ?? null,
        underlying_error: selected.details,
      }));

      const nestedAgentPolicy = parentTaskDepth() >= 1;
      const requestedMode = nestedAgentPolicy ? "auto" : (deps.resolveDisplayMode?.(ctx, input.display_mode) ?? (input.display_mode ?? "auto"));
      const availability = detectDisplayModeAvailability();
      const resolvedSurface = resolveDisplaySurface(requestedMode, availability);
      if (typeof resolvedSurface === "object") return errorResult(displayError(requestedMode));
      const surface = resolvedSurface === "background" ? "background" : "pane";
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) return errorResult({ code: "agent_launch_failed", message: "A persistent parent session is required." });
      const artifactDir = deps.getArtifactDir(ctx.sessionManager.getSessionDir(), ctx.sessionManager.getSessionId());
      if (deps.registry.isNameTaken(input.task_name) || Object.prototype.hasOwnProperty.call(readNameRegistry(artifactDir), input.task_name)) {
        return errorResult({ code: "task_name_conflict", message: `Task name "${input.task_name}" is already in use.`, task_name: input.task_name });
      }
      deps.registry.reserveName(input.task_name);
      try {
        const route = `${selected.model.provider}/${selected.model.id}`;
        const params = {
          agent,
          task: input.message,
          name: input.task_name,
          model: route,
          thinking: input.reasoning_effort,
          surface,
          display_mode: requestedMode,
          modelIdentity: selected.model,
        } as any;
        const planned = deps.startup.planSpawn(params, ctx, { protocol: "codex-v2", forkTurns: input.fork_turns });
        if (planned.kind === "error") return errorResult(createCodexV2LaunchError({
          code: "agent_launch_failed",
          message: planned.error,
          selectedModel: input.model,
          reasoning_effort: input.reasoning_effort,
          display_mode: requestedMode,
          resolved_display_mode: resolvedSurface === "background" ? null : resolvedSurface,
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
            reasoning_effort: input.reasoning_effort,
            display_mode: requestedMode,
            resolved_display_mode: resolvedSurface === "background" ? null : resolvedSurface,
            underlying_error: error instanceof Error ? error.message : String(error),
          }));
        }
        const canonicalParent = process.env.PI_SUBAGENT_TASK_PATH ?? "/root";
        const canonical = `${canonicalParent}/${input.task_name}`;
        registerName(artifactDir, input.task_name, {
          sessionFile: started.running.sessionFile,
          sessionId: null,
          anchored: started.running.anchoredLoadout,
        });
        const producers = createParentUpdateProducers(createParentUpdateQueue(
          deps.getArtifactDir(ctx.sessionManager.getSessionDir(), ctx.sessionManager.getSessionId()),
        ));
        producers.spawnStatus({ agent_id: started.running.id, task_name: input.task_name, status: "starting", summary: "Spawn accepted and starting.", update_id: `spawn:${started.running.id}:starting` });
        producers.spawnStatus({ agent_id: started.running.id, task_name: input.task_name, status: "running", summary: "Subagent is running.", update_id: `spawn:${started.running.id}:running` });
        void started.watch.then((watchResult: any) => {
          if (watchResult?.interruptedRound || watchResult?.handedOff) return;
          const status = watchResult?.userClosed || watchResult?.stopped ? "interrupted" : watchResult?.exitCode === 0 ? "completed" : "failed";
          const update = (watchResult?.userClosed ? producers.surfaceClosed : producers.watcherTerminal)({ agent_id: started.running.id, task_name: input.task_name, status, summary: watchResult?.summary || watchResult?.errorMessage || "Subagent finished.", update_id: `spawn:${started.running.id}:terminal`, final_text: watchResult?.summary || watchResult?.errorMessage || undefined });
          deps.deliverTerminal?.(started.running, watchResult as SubagentResult, "spawn", update.delivery_id);
          void update;
        }).catch((error) => producers.watcherTerminal({
          agent_id: started.running.id,
          task_name: input.task_name,
          status: "failed",
          summary: error instanceof Error ? error.message : String(error),
          update_id: `spawn:${started.running.id}:terminal`,
        }));
        const publicResolvedDisplayMode = resolvedSurface === "background" ? "auto" : resolvedSurface;
        const nestedPolicy = nestedAgentPolicy ? { display_policy: "nested_agent_forced_background" } : {};
        return {
          content: [{ type: "text", text: JSON.stringify({ agent_id: started.running.id, task_name: input.task_name, canonical_task_name: canonical, status: "running", resolved: { model: route, reasoning_effort: input.reasoning_effort, display_mode: requestedMode, resolved_display_mode: publicResolvedDisplayMode, ...nestedPolicy, fork_turns: input.fork_turns, agent_type: agent } }) }],
          details: { agent_id: started.running.id, task_name: input.task_name, canonical_task_name: canonical, status: "running", resolved: { model: route, reasoning_effort: input.reasoning_effort, display_mode: requestedMode, resolved_display_mode: publicResolvedDisplayMode, ...nestedPolicy, fork_turns: input.fork_turns, agent_type: agent } },
        };
      } finally {
        deps.registry.releaseName(input.task_name);
      }
    },
  });
}
