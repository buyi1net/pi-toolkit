import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { AgentDefaults, AgentSessionMode } from "./agents.ts";
import type { SubagentParams } from "./params.ts";

export const SPAWNING_TOOLS = [
  "subagent",
  "subagent_message",
  "subagents_list",
  "subagent_inspect",
] as const;

/** 成员间直信工具:仅 member spawn 注入白名单(注册在 subagent-done.ts)。 */
export const TEAM_TOOLS = ["team_send"] as const;

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

/**
 * Resolve the lifecycle flag that is actually passed to the child process.
 * `interactive` and `auto-exit` describe the same boundary from opposite
 * directions, so an explicit value on either side must not leave the other
 * side undefined. In particular, `interactive: false` without
 * `auto-exit: true` must still terminate a headless child after its turn.
 */
export function resolveEffectiveAutoExit(agentDefs: AgentDefaults | null): boolean {
  if (agentDefs?.interactive != null) return !agentDefs.interactive;
  return agentDefs?.autoExit ?? false;
}

/** Reject contradictory frontmatter instead of silently creating a hanging or
 * prematurely self-closing subagent. A valid pair is interactive=true,
 * auto-exit=false, or interactive=false, auto-exit=true. */
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

/**
 * 表面选择(纯函数):
 *   - "pane":强制可见 pane(现有 herdr/tmux 路径,行为不变)。
 *   - "background":强制 headless——独立后台 pi 进程,不创建 pane。
 *     interactive(演示型)子代理必须拒绝:它们依赖用户在 pane 中操作,
 *     静默降级成 headless 或反过来静默建 pane 都是错的,直接报错返回。
 *   - "auto"(默认,兼容旧调用不传 surface):interactive → pane,自动任务 → headless。
 *
 * 返回 { choice } 或 { error }(error 为面向 tool result 的完整错误文本)。
 */
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
        'surface "background" (headless) was refused instead of silently creating a pane. ' +
        "Spawn an autonomous agent, or omit `surface` to place this sub-agent in a pane.";
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

export function buildSubagentToolAllowlist(
  effectiveTools: string | undefined,
  opts?: { grantSpawning?: boolean; grantTeamSend?: boolean },
): string | null {
  const requested = (effectiveTools ?? "")
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);
  const grantSpawning = opts?.grantSpawning ?? false;
  const grantTeamSend = opts?.grantTeamSend ?? false;
  const hasExplicitTools = effectiveTools !== undefined;
  const spawningNames = new Set<string>(SPAWNING_TOOLS);
  const teamNames = new Set<string>(TEAM_TOOLS);

  // A profile cannot opt itself into delegation merely by putting a spawning
  // tool in `tools`; the explicit subagent_agents grant is the authority.
  // team_send 同理:profile 不能靠把工具名写进 tools 自授;member spawn 的
  // 显式注入才是授权来源。
  const allow = new Set(
    requested.filter((tool) =>
      (grantSpawning || !spawningNames.has(tool)) && (grantTeamSend || !teamNames.has(tool)),
    ),
  );
  if (grantSpawning) {
    for (const tool of SPAWNING_TOOLS) allow.add(tool);
  }
  if (grantTeamSend) {
    for (const tool of TEAM_TOOLS) allow.add(tool);
  }
  if (requested.length > 0 || grantSpawning || grantTeamSend) allow.add("ask_question");

  // null means "use Pi's normal defaults". An explicitly empty/forbidden
  // list must remain an empty allowlist rather than widening back to defaults.
  if (allow.size === 0 && !hasExplicitTools && !grantSpawning && !grantTeamSend) return null;
  return [...allow].join(",");
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
