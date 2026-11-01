import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { AgentDefaults, AgentSessionMode } from "./agents.ts";
import type { SubagentParams } from "./params.ts";

import type { SubagentProtocol } from "./protocol.ts";

export const CODEX_V2_SPAWNING_TOOLS = [
  "spawn_agent",
  "send_message",
  "followup_task",
  "wait_agent",
  "interrupt_agent",
  "list_agents",
  "subagent_models",
] as const;

export const SPAWNING_TOOLS = CODEX_V2_SPAWNING_TOOLS;

export function spawningToolsForProtocol(_protocol: SubagentProtocol): readonly string[] {
  return SPAWNING_TOOLS;
}

export const TEAM_TOOLS = ["team_send"] as const;

export const MCP_TOOL_PREFIX = "mcp__";

export function declaredMcpTools(toolAllowlist: string | null | undefined): string[] {
  if (!toolAllowlist) return [];
  const seen = new Set<string>();
  const declared: string[] = [];
  for (const raw of toolAllowlist.split(",")) {
    const entry = raw.trim();
    if (!entry.startsWith(MCP_TOOL_PREFIX) || seen.has(entry)) continue;
    seen.add(entry);
    declared.push(entry);
  }
  return declared;
}

export function describeMcpIsolation(toolAllowlist: string | null | undefined): string {
  if (toolAllowlist == null) {
    return "MCP: inherited from the parent session (no agent-profile MCP restriction)";
  }
  const declared = declaredMcpTools(toolAllowlist);
  if (declared.length === 0) {
    return "MCP: isolated (launched with --no-mcp; no MCP servers connect and no MCP tools are reachable)";
  }
  return `MCP: ${declared.join(", ")} (declared patterns only; undeclared MCP servers are unreachable)`;
}

export type SubagentSessionMode = AgentSessionMode;

export function resolveSubagentPaths(
  params: SubagentParams,
  agentDefs: AgentDefaults | null,
  getAgentConfigDir: () => string,
): { effectiveCwd: string | null; localAgentDir: string | null; effectiveAgentDir: string } {
  const rawCwd = params.cwd ?? agentDefs?.cwd ?? null;
  const cwdIsFromAgent = !params.cwd && agentDefs?.cwd != null;
  const cwdBase = cwdIsFromAgent ? getAgentConfigDir() : process.cwd();
  const effectiveCwd = rawCwd
    ? isAbsolute(rawCwd)
      ? rawCwd
      : join(cwdBase, rawCwd)
    : null;
  const localAgentDir = effectiveCwd ? join(effectiveCwd, ".pi", "agent") : null;
  const effectiveAgentDir =
    localAgentDir && existsSync(localAgentDir) ? localAgentDir : getAgentConfigDir();
  return { effectiveCwd, localAgentDir, effectiveAgentDir };
}

export function getDefaultSessionDirFor(cwd: string, agentDir: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const sessionDir = join(agentDir, "sessions", safePath);
  if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });
  return sessionDir;
}

export function resolveEffectiveSessionMode(
  agentDefs: AgentDefaults | null,
): SubagentSessionMode {
  return agentDefs?.sessionMode ?? "standalone";
}

export function resolveLaunchBehavior(
  params: SubagentParams,
  agentDefs: AgentDefaults | null,
): {
  sessionMode: SubagentSessionMode;
  seededSessionMode: "lineage-only" | "fork" | null;
  inheritsConversationContext: boolean;
  taskDelivery: "direct" | "artifact";
} {
  const sessionMode = resolveEffectiveSessionMode(agentDefs);
  const inheritsConversationContext = sessionMode === "fork";
  return {
    sessionMode,
    seededSessionMode: sessionMode === "standalone" ? null : sessionMode,
    inheritsConversationContext,
    taskDelivery: inheritsConversationContext ? "direct" : "artifact",
  };
}

export function resolveEffectiveInteractive(
  _params: SubagentParams,
  agentDefs: AgentDefaults | null,
): boolean {
  if (agentDefs?.interactive != null) return agentDefs.interactive;
  return !(agentDefs?.autoExit ?? false);
}

export function resolveEffectiveAutoExit(agentDefs: AgentDefaults | null): boolean {
  if (agentDefs?.interactive != null) return !agentDefs.interactive;
  return agentDefs?.autoExit ?? false;
}

export function validateAgentLifecycleConfig(agentDefs: AgentDefaults | null): string | null {
  if (
    agentDefs?.interactive != null &&
    agentDefs.autoExit != null &&
    agentDefs.interactive === agentDefs.autoExit
  ) {
    return (
      `Agent lifecycle settings conflict: interactive=${agentDefs.interactive} and ` +
      `auto-exit=${agentDefs.autoExit}. Set interactive=false with auto-exit=true ` +
      `for an autonomous agent, or interactive=true with auto-exit=false for a demo pane.`
    );
  }
  return null;
}

export type SubagentSurfaceChoice = "headless" | "pane";

export function resolveSurfaceChoice(
  surface: string | undefined,
  effectiveInteractive: boolean,
): { choice: SubagentSurfaceChoice } | { error: string } {
  const requested = surface ?? "auto";
  if (requested === "pane") return { choice: "pane" };
  if (requested === "background") {
    if (effectiveInteractive) {
      const reason =
        'interactive (demo) sub-agents run in a visible pane the user operates; ' +
        'surface "background" (headless) was refused instead of silently creating a pane.';
      return { error: reason };
    }
    return { choice: "headless" };
  }
  if (requested === "auto") {
    return { choice: effectiveInteractive ? "pane" : "headless" };
  }
  return {
    error: `Invalid surface "${requested}". Use "auto", "background", or "pane".`,
  };
}

export function subagentTaskDepth(taskPath = process.env.PI_SUBAGENT_TASK_PATH): number {
  const path = taskPath ?? "/root";
  const parts = path.split("/").filter(Boolean);
  return parts[0] === "root" ? Math.max(0, parts.length - 1) : parts.length;
}

export function buildSubagentToolAllowlist(
  effectiveTools: string | undefined,
  opts?: { grantSpawning?: boolean; grantTeamSend?: boolean; protocol?: SubagentProtocol },
): string | null {
  const requested = (effectiveTools ?? "")
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);
  const grantSpawning = opts?.grantSpawning ?? false;
  const grantTeamSend = opts?.grantTeamSend ?? false;
  const hasExplicitTools = effectiveTools !== undefined;
  const protocol = opts?.protocol ?? "codex-v2";
  if (!hasExplicitTools && (opts?.grantSpawning ?? false) && !(opts?.grantTeamSend ?? false)) return null;
  const spawningNames = new Set<string>(spawningToolsForProtocol(protocol));
  const teamNames = new Set<string>(TEAM_TOOLS);

  const allow = new Set(
    requested.filter((tool) =>
      (grantSpawning || !spawningNames.has(tool)) && (grantTeamSend || !teamNames.has(tool)),
    ),
  );
  if (grantSpawning) {
    for (const tool of spawningNames) allow.add(tool);
  }
  if (grantTeamSend) {
    for (const tool of TEAM_TOOLS) allow.add(tool);
  }
  if (requested.length > 0 || grantSpawning || grantTeamSend) allow.add("ask_question");

  if (allow.size === 0 && !hasExplicitTools && !grantSpawning && !grantTeamSend) return null;
  return [...allow].join(",");
}

export function needsEnvProxyForTools(toolAllowlist: string | null | undefined): boolean {
  if (!toolAllowlist) return false;
  return /(^|,)\s*web_(search|fetch)\s*(,|$)/.test(toolAllowlist);
}

export function buildPiPromptArgs(params: {
  effectiveSkills?: string;
  taskDelivery: "direct" | "artifact";
  taskArg: string;
}): string[] {
  const skillPrompts = (params.effectiveSkills ?? "")
    .split(",")
    .map((skill) => skill.trim())
    .filter(Boolean)
    .map((skill) => `/skill:${skill}`);
  const needsSeparator = params.taskDelivery === "artifact" && skillPrompts.length > 0;
  return [
    ...(needsSeparator ? [""] : []),
    ...skillPrompts,
    params.taskArg,
  ];
}
