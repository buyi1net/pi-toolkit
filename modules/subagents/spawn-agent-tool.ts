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

const DEFAULT_AGENT_TYPE = "worker";

export type DeliverTerminal = (running: RunningSubagent, result: SubagentResult, source: "spawn" | "followup" | "recovered-exit" | "recovered-headless" | "recovered-pane", deliveryId: string) => void;

export interface SpawnAgentToolDeps {
  readonly startup: SubagentStartup;
  readonly registry: RuntimeRegistry;
  readonly discoverAgents: () => Array<{ name: string }>;
  readonly getArtifactDir: (sessionDir: string, sessionId: string) => string;
  readonly resolveDisplayMode?: (ctx: ExtensionContext, requested?: unknown) => "auto" | "herdr" | "tmux";
  readonly getModelDirectory: (ctx: ExtensionContext) => ModelDirectory;
  readonly deliverTerminal?: DeliverTerminal;
}

function errorResult(error: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(error) }], details: error };
}

function displayError(mode: string): Record<string, unknown> {
  return createCodexV2LaunchError({
    code: "agent_launch_failed",
    message: `Display mode "${mode}" is unavailable in the current environment.`,
    modelKey: null,
    reasoning_effort: null,
    display_mode: mode as "auto" | "herdr" | "tmux",
    underlying_error: "display_unavailable",
  });
}

/** Codex v2 的启动接缝：只负责协议映射、启动前校验和立即回执。 */
export function registerSpawnAgentTool(pi: ExtensionAPI, deps: SpawnAgentToolDeps): void {
  pi.registerTool({
    name: "spawn_agent",
    label: "Spawn Agent",
    description:
      "Start a sub-agent and return immediately. Read subagent_models first; model must be its opaque modelKey. " +
      "The returned agent_id and canonical_task_name identify the new run.",
    promptSnippet: "Start an agent without waiting for its final result.",
    parameters: Type.Object({
      task_name: Type.String({ minLength: 1, maxLength: 72, pattern: "^[a-z0-9_]+$" }),
      message: Type.String({ minLength: 1 }),
      agent_type: Type.Optional(Type.String({ minLength: 1 })),
      fork_turns: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("none")])),
      model: Type.String({ minLength: 1 }),
      reasoning_effort: Type.String({ minLength: 1 }),
      display_mode: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("herdr"), Type.Literal("tmux")])),
    }),
    async execute(_toolCallId, raw, _signal, _onUpdate, ctx) {
      const validated = validateCodexV2SpawnParams(raw);
      if (!validated.ok) return errorResult({ code: "invalid_params", message: "Invalid spawn_agent parameters.", details: validated.errors });
      const input: CodexV2SpawnParams = validated.value;
      const agent = input.agent_type ?? DEFAULT_AGENT_TYPE;
      const allowed = new Set(deps.discoverAgents().map((candidate) => candidate.name));
      if (!allowed.has(agent)) return errorResult({ code: "agent_type_unknown", message: `Unknown agent_type "${agent}".` });

      const directory = deps.getModelDirectory(ctx);
      const selected = validateCodexV2ModelSelection(directory, input.model, input.reasoning_effort);
      if (!selected.ok) return errorResult(createCodexV2LaunchError({
        code: selected.code,
        message: selected.message,
        modelKey: input.model,
        reasoning_effort: input.reasoning_effort,
        display_mode: input.display_mode ?? null,
        underlying_error: selected.details,
      }));

      const requestedMode = deps.resolveDisplayMode?.(ctx, input.display_mode) ?? (input.display_mode ?? "auto");
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
        const planned = deps.startup.planSpawn(params, ctx, { protocol: "codex-v2", forkTurns: input.fork_turns ?? "all" });
        if (planned.kind === "error") return errorResult(createCodexV2LaunchError({
          code: "agent_launch_failed",
          message: planned.error,
          modelKey: input.model,
          reasoning_effort: input.reasoning_effort,
          display_mode: requestedMode,
          resolved_display_mode: resolvedSurface === "background" ? null : resolvedSurface,
          underlying_error: planned.details ?? null,
        }));
        const started = await deps.startup.spawn(planned.plan, ctx, pi);
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
        return {
          content: [{ type: "text", text: JSON.stringify({ agent_id: started.running.id, task_name: input.task_name, canonical_task_name: canonical, status: "running", resolved: { model: route, reasoning_effort: input.reasoning_effort, display_mode: requestedMode, resolved_display_mode: publicResolvedDisplayMode, fork_turns: input.fork_turns ?? "all", agent_type: agent } }) }],
          details: { agent_id: started.running.id, task_name: input.task_name, canonical_task_name: canonical, status: "running", resolved: { model: route, reasoning_effort: input.reasoning_effort, display_mode: requestedMode, resolved_display_mode: publicResolvedDisplayMode, fork_turns: input.fork_turns ?? "all", agent_type: agent } },
        };
      } finally {
        deps.registry.releaseName(input.task_name);
      }
    },
  });
}
