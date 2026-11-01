import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { terminateHeadlessProcess } from "./headless.ts";
import { adoptSurfaceFor, closeSurfaceFor, sendCommand, sendCommandFor } from "./surface.ts";
import {
  getAgentConfigDir,
  getArtifactDir,
  hostOptions,
  hostSection,
  resolveHostTierSources,
  widgetText,
  discoverAgentDefinitions,
} from "./mod-host.ts";
import { runtimeRegistry, handleSubagentSteer } from "./mod.ts";
import { updateWidget } from "./mod-widget.ts";
import { deliverSpawnTerminal } from "./mod-delivery.ts";
import { registerCloseAgentTool } from "./close-agent-tool.ts";
import { registerFollowupTaskTool } from "./followup-task-tool.ts";

import { registerInterruptAgentTool } from "./interrupt-agent-tool.ts";
import { registerListAgentsTool } from "./list-agents-tool.ts";
import { registerSendMessageTool } from "./send-message-tool.ts";
import { registerSpawnAgentTool } from "./spawn-agent-tool.ts";
import { registerSubagentModelsTool, buildSubagentModelsResult, summarizeAgentTypes } from "./models-tool.ts";
import { registerSubagentRenderers } from "./renderers.ts";
import { registerWaitAgentTool } from "./wait-agent-tool.ts";
import { loadTierRouteConfig, MODEL_TIERS } from "./routing.ts";
import { projectModelDirectoryHealth } from "./model-selector.ts";
import { detectDisplayModeAvailability } from "./surface.ts";
import { resolveDisplayMode } from "./config.ts";
import { detectDisplayContext } from "./surface.ts";
import type { SubagentStartup } from "./startup.ts";

export function registerSubagentTools(pi: ExtensionAPI, startup: SubagentStartup): void {
  const modelDirectoryCache = new WeakMap<object, Map<string, ReturnType<typeof buildSubagentModelsResult>>>();
  const getSharedModelDirectory = (ctx: ExtensionContext) => {
    const registry = ctx.modelRegistry as object;
    if (!registry) throw new Error("Host model registry is required for Codex v2 model selection.");
    const cwd = ctx.cwd ?? process.cwd();
    const loaded = loadTierRouteConfig({ cwd, agentConfigDir: getAgentConfigDir(), injected: resolveHostTierSources() });
    const pools = loaded.config
      ? Object.fromEntries(MODEL_TIERS.map((tier) => [tier, loaded.config!.tiers[tier].pool ?? []]))
      : {};
    const availableModels = (ctx.modelRegistry as any).getAvailable();
    const agent_types = summarizeAgentTypes(discoverAgentDefinitions(cwd));
    const key = JSON.stringify({
      currentModel: ctx.model ?? null,
      registry: availableModels,
      auth: availableModels.map((model: any) => ({ provider: model.provider, id: model.id, configured: (ctx.modelRegistry as any).hasConfiguredAuth?.(model) ?? null })),
      pools,
      agent_types,
    });
    let byConfig = modelDirectoryCache.get(registry);
    if (!byConfig) { byConfig = new Map(); modelDirectoryCache.set(registry, byConfig); }
    let directory = byConfig.get(key);
    if (!directory) {
      directory = buildSubagentModelsResult({
        currentModel: ctx.model as any,
        pools,
        modelRegistry: ctx.modelRegistry as any,
        health: new Map(),
        display_modes: detectDisplayModeAvailability(),
        agent_types,
      });
      byConfig.set(key, directory);
    }
    const health = hostOptions.modelHealth?.read(Object.values(pools).flatMap((pool) => pool ?? []));
    return { ...projectModelDirectoryHealth(directory, health), display_modes: detectDisplayModeAvailability(), agent_types };
  };

  registerSpawnAgentTool(pi, {
    startup,
    registry: runtimeRegistry,
    discoverAgents: discoverAgentDefinitions,
    getArtifactDir,
    resolveDisplayMode: (ctx, requested) => {
      const section = hostSection()?.section ?? {};
      return resolveDisplayMode({ requested, context: detectDisplayContext(), config: section });
    },
    getModelDirectory: getSharedModelDirectory,
    t: widgetText,
    deliverTerminal: (running, result, source, deliveryId) => deliverSpawnTerminal(running, result, pi, deliveryId, source),
  });

  registerWaitAgentTool(pi, {
    getArtifactDir,
    registry: runtimeRegistry,
    t: widgetText,
  });

  registerFollowupTaskTool(pi, {
    startup,
    registry: runtimeRegistry,
    getArtifactDir,
    handleSubagentSteer,
    t: widgetText,
    deliverTerminal: (running, result, source, deliveryId) => deliverSpawnTerminal(running, result, pi, deliveryId, source),
  });
  registerSendMessageTool(pi, {
    registry: runtimeRegistry,
    getArtifactDir,
    handleSubagentSteer,
    t: widgetText,
  });

  registerInterruptAgentTool(pi, {
    registry: runtimeRegistry,
    getArtifactDir,
    handleSubagentSteer,
    t: widgetText,
    terminateProcess: terminateHeadlessProcess,
    interruptRemoteSurface: (kind, surface) => sendCommandFor(kind, surface, "\u0003"),
    interruptCurrentRound: (running) => {
      if (running.kind === "headless") {
        running.headlessChild?.abort();
        if (running.pid != null) terminateHeadlessProcess(running.pid);
      } else sendCommand(running.surface, "\u0003");
      runtimeRegistry.remove(running.id, { keepRecord: true });
      updateWidget();
    },
  });

  registerCloseAgentTool(pi, {
    registry: runtimeRegistry,
    getArtifactDir,
    handleSubagentSteer,
    t: widgetText,
    terminateProcess: terminateHeadlessProcess,
    closeRemoteSurface: (kind, surface) => {
      adoptSurfaceFor(kind, surface);
      closeSurfaceFor(kind, surface);
    },
    interruptCurrentRound: (running) => {
      if (running.kind === "headless") {
        running.headlessChild?.abort();
        if (running.pid != null) terminateHeadlessProcess(running.pid);
      } else sendCommand(running.surface, "\u0003");
      runtimeRegistry.remove(running.id, { keepRecord: true });
      updateWidget();
    },
  });


  registerListAgentsTool(pi, {
    registry: runtimeRegistry,
    getArtifactDir,
    t: widgetText,
  });
  registerSubagentModelsTool(pi, {
    getPools: (cwd: string) => {
      const loaded = loadTierRouteConfig({
        cwd,
        agentConfigDir: getAgentConfigDir(),
        injected: resolveHostTierSources(),
      });
      if (!loaded.config) return {};
      return Object.fromEntries(
        MODEL_TIERS.map((tier) => [tier, loaded.config!.tiers[tier].pool ?? []]),
      );
    },
    getHealth: (pool) => hostOptions.modelHealth?.read(pool) ?? new Map(),
    getDisplayModes: () => detectDisplayModeAvailability(),
    getModelDirectory: getSharedModelDirectory,
    t: widgetText,
  });

  registerSubagentRenderers(pi, widgetText);
}
