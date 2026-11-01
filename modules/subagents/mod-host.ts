import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { muxSetupHint } from "./surface.ts";
import { discoverAgentDefinitions as discoverAgents, loadAgentDefaults as loadAgentDefaultsFrom, type AgentDefaults } from "./agents.ts";
import { subagentsTableTranslator, type SubagentsTranslate } from "./messages/index.ts";
import type { Translator } from "../../i18n/index.ts";
import type { UsageRunEvent } from "../usage/api.ts";
import type { ModelErrorJournal, ModelHealthGateway } from "./model-health.ts";
import type { TierRouteInjectedSource } from "./routing.ts";
import {
  MCP_TOOL_PREFIX,
  SPAWNING_TOOLS,
  TEAM_TOOLS,
} from "./launch-config.ts";

export const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url));

export interface SubagentsHostSection {
  readonly source: string;
  readonly section: Record<string, unknown>;
}

export interface SubagentsExtensionOptions {

  readHostSection?: () => SubagentsHostSection | null;

  modelHealth?: ModelHealthGateway;

  modelErrorJournal?: ModelErrorJournal;

  recordUsage?: (event: UsageRunEvent) => void;

  t?: Translator;
}

export let hostOptions: SubagentsExtensionOptions = {};

export function configureSubagentsExtension(options: SubagentsExtensionOptions): void {
  hostOptions = options;
}

export function hostSection(): SubagentsHostSection | null {
  try {
    return hostOptions.readHostSection?.() ?? null;
  } catch {
    return null;
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const FALLBACK_TRANSLATE = subagentsTableTranslator("en");

export const widgetText: SubagentsTranslate = (key, vars) => (hostOptions.t ?? FALLBACK_TRANSLATE)(key, vars);

export function resolveHostTierSources(): TierRouteInjectedSource[] {
  const host = hostSection();
  if (!host) return [];
  const raw: Record<string, unknown> = {};
  if (host.section.models !== undefined) raw.models = host.section.models;
  if (host.section.thinking !== undefined) raw.thinking = host.section.thinking;
  if (Object.keys(raw).length === 0) return [];
  return [{ source: host.source, raw }];
}

const BUILTIN_TOOLS = new Set(["read", "write", "edit", "bash", "grep", "find", "ls"]);

export function getAgentConfigDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

const EXTRA_TOOL_EXTENSIONS = new Map<string, string>();

export function registerToolExtension(name: string, extensionPath: string): void {
  if (BUILTIN_TOOLS.has(name)) {
    throw new Error(`Cannot register custom tool "${name}": shadows a built-in pi tool`);
  }
  if ((SPAWNING_TOOLS as readonly string[]).includes(name)) {
    throw new Error(`Cannot register custom tool "${name}": shadows a spawning tool`);
  }
  const existing = EXTRA_TOOL_EXTENSIONS.get(name);
  if (existing === extensionPath) return;
  if (existing !== undefined) {
    throw new Error(
      `Tool extension already registered for "${name}": ${existing} (refusing to overwrite with ${extensionPath})`,
    );
  }
  EXTRA_TOOL_EXTENSIONS.set(name, extensionPath);
}

(globalThis as any).__pi_interactive_subagents = {
  registerToolExtension,
};

export function getToolExtensionPath(tool: string): string | undefined {
  if (BUILTIN_TOOLS.has(tool)) return undefined;
  if ((SPAWNING_TOOLS as readonly string[]).includes(tool)) {
    return fileURLToPath(new URL("./mod.ts", import.meta.url));
  }
  const extBase = join(getAgentConfigDir(), "extensions");
  const map: Record<string, string> = {
    web_search: join(extBase, "web-search", "index.ts"),
    web_fetch: join(extBase, "web-fetch", "index.ts"),
    video_extract: join(extBase, "video-extract", "index.ts"),
    youtube_search: join(extBase, "youtube-search", "index.ts"),
    google_image_search: join(extBase, "google-image-search", "index.ts"),
    safe_bash: join(SUBAGENTS_DIR, "tools", "safe-bash.ts"),
  };

  const builtin = map[tool];
  if (builtin && existsSync(builtin)) return builtin;
  const registered = EXTRA_TOOL_EXTENSIONS.get(tool);
  if (registered) return registered;

  const bundled: Record<string, string> = {
    web_search: join(SUBAGENTS_DIR, "tools", "web-search.ts"),
    web_fetch: join(SUBAGENTS_DIR, "tools", "web-fetch.ts"),
  };
  const fallback = bundled[tool];
  return fallback && existsSync(fallback) ? fallback : undefined;
}

export interface ToolProvisionReport {
  tool: string;
  kind: "builtin" | "module" | "extension" | "mcp";
  provider?: string;
}

export function classifyToolProvisions(allowlist: string): {
  provided: ToolProvisionReport[];
  missing: string[];
} {
  const provided: ToolProvisionReport[] = [];
  const missing: string[] = [];
  for (const raw of allowlist.split(",")) {
    const tool = raw.trim();
    if (!tool) continue;

    if (tool.startsWith(MCP_TOOL_PREFIX)) {
      provided.push({ tool, kind: "mcp" });
      continue;
    }
    if (BUILTIN_TOOLS.has(tool)) {
      provided.push({ tool, kind: "builtin" });
      continue;
    }
    const isSpawning = (SPAWNING_TOOLS as readonly string[]).includes(tool);
    const isTeam = (TEAM_TOOLS as readonly string[]).includes(tool);
    if (isSpawning || isTeam || tool === "ask_question") {
      provided.push({ tool, kind: "module" });
      continue;
    }
    const provider = getToolExtensionPath(tool);
    if (provider && existsSync(provider)) {
      provided.push({ tool, kind: "extension", provider });
      continue;
    }
    missing.push(tool);
  }
  return { provided, missing };
}

export function validateToolProvision(allowlist: string): string[] {
  return classifyToolProvisions(allowlist).missing;
}

const SUBAGENT_ALLOWLIST: Set<string> | null = (() => {
  const raw = process.env.PI_SUBAGENT_ALLOWED;
  if (raw === undefined) return null;
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
})();

function getBundledAgentsDir(): string {
  return join(SUBAGENTS_DIR, "agents");
}

function agentDiscoveryOptions(cwd = process.cwd()) {
  return {
    bundledDir: getBundledAgentsDir(),
    configDir: getAgentConfigDir(),
    projectDir: cwd,
    allowlist: SUBAGENT_ALLOWLIST,
  };
}

export function discoverAgentDefinitions(cwd = process.cwd()) {
  return discoverAgents(agentDiscoveryOptions(cwd));
}

export function loadAgentDefaults(agentName: string, cwd = process.cwd()): AgentDefaults | null {
  return loadAgentDefaultsFrom(agentName, agentDiscoveryOptions(cwd));
}

export function getShellReadyDelayMs(): number {
  const raw = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 500;
}

export function muxUnavailableResult() {
  return {
    content: [
      {
        type: "text" as const,
        text:
          `Sub-agents in a visible pane require herdr or tmux. ${muxSetupHint()} ` +
          `Autonomous sub-agents can also run headless in the background without a multiplexer ` +
          `(surface "background", or the default "auto" for auto-exit agents).`,
      },
    ],
    details: { error: "supported multiplexer not available" },
    isError: true,
  };
}

export function getArtifactDir(sessionDir: string, sessionId: string): string {
  return join(sessionDir, "artifacts", sessionId);
}
