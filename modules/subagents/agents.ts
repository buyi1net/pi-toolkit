import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export type AgentSource = "package" | "global" | "project";
export type AgentSessionMode = "standalone" | "lineage-only" | "fork";

export interface AgentDefaults {
  model?: string;
  tools?: string;
  skills?: string;
  thinking?: string;
  /**
   * 能力标签要求（工单 24，原始逗号列表，启动时归一校验）：声明本代理
   * 需要的模型能力（如 vision/reasoning），tier 候选池选择器用它过滤
   * 候选。词汇表与校验在 model-selector.ts。
   */
  capabilities?: string[];
  subagentAgents?: string[];
  /** 持久成员的受限成员间直信 ACL:允许向这些成员名 team_send(空/缺省 = 无权限)。 */
  peerSend?: string[];
  autoExit?: boolean;
  interactive?: boolean;
  systemPromptMode?: "append" | "replace";
  sessionMode?: AgentSessionMode;
  cwd?: string;
  body?: string;
  disableModelInvocation?: boolean;
}

export interface AgentDefinition extends AgentDefaults {
  name: string;
  description?: string;
  disableModelInvocation: boolean;
  filePath: string;
}

export interface ListedAgentDefinition extends AgentDefinition {
  source: AgentSource;
}

function getFrontmatterValue(frontmatter: string, key: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match ? match[1].trim() : undefined;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  return value != null ? value === "true" : undefined;
}

function parseCommaList(value: string | undefined): string[] | undefined {
  if (value == null) return undefined;
  const list = value.split(",").map((item) => item.trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

function parseSessionMode(value: string | undefined): AgentSessionMode | undefined {
  if (value === "standalone" || value === "lineage-only" || value === "fork") return value;
  return undefined;
}

export function parseAgentDefinition(
  content: string,
  fallbackName: string,
  filePath = fallbackName,
): AgentDefinition | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;

  const frontmatter = match[1];
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, "").trim();
  const systemPromptMode = getFrontmatterValue(frontmatter, "system-prompt");

  return {
    name: getFrontmatterValue(frontmatter, "name") ?? fallbackName,
    description: getFrontmatterValue(frontmatter, "description"),
    model: getFrontmatterValue(frontmatter, "model"),
    tools: getFrontmatterValue(frontmatter, "tools"),
    systemPromptMode:
      systemPromptMode === "replace" || systemPromptMode === "append" ? systemPromptMode : undefined,
    skills: getFrontmatterValue(frontmatter, "skill") ?? getFrontmatterValue(frontmatter, "skills"),
    thinking: getFrontmatterValue(frontmatter, "thinking"),
    capabilities: parseCommaList(getFrontmatterValue(frontmatter, "capabilities")),
    subagentAgents: parseCommaList(getFrontmatterValue(frontmatter, "subagent_agents")),
    peerSend: parseCommaList(getFrontmatterValue(frontmatter, "peer-send")),
    autoExit: parseOptionalBoolean(getFrontmatterValue(frontmatter, "auto-exit")),
    interactive: parseOptionalBoolean(getFrontmatterValue(frontmatter, "interactive")),
    sessionMode: parseSessionMode(getFrontmatterValue(frontmatter, "session-mode")),
    cwd: getFrontmatterValue(frontmatter, "cwd"),
    body: body || undefined,
    disableModelInvocation:
      getFrontmatterValue(frontmatter, "disable-model-invocation")?.toLowerCase() === "true",
    filePath,
  };
}

export interface AgentDiscoveryOptions {
  bundledDir: string;
  configDir: string;
  projectDir: string;
  allowlist?: Set<string> | null;
}

function discoverAll(options: AgentDiscoveryOptions): ListedAgentDefinition[] {
  const agents = new Map<string, ListedAgentDefinition>();
  const dirs: Array<{ path: string; source: AgentSource }> = [
    { path: options.bundledDir, source: "package" },
    { path: join(options.configDir, "agents"), source: "global" },
    { path: join(options.projectDir, ".pi", "agents"), source: "project" },
  ];

  for (const { path: dir, source } of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".md"))) {
      const filePath = join(dir, file);
      const parsed = parseAgentDefinition(readFileSync(filePath, "utf8"), file.replace(/\.md$/, ""), filePath);
      if (parsed) agents.set(parsed.name, { ...parsed, source });
    }
  }

  return [...agents.values()];
}

export function discoverAgentDefinitions(options: AgentDiscoveryOptions): ListedAgentDefinition[] {
  const all = discoverAll(options);
  return options.allowlist ? all.filter((agent) => options.allowlist!.has(agent.name)) : all;
}

export function loadAgentDefaults(
  agentName: string,
  options: AgentDiscoveryOptions,
): AgentDefinition | null {
  return discoverAll(options).find((agent) => agent.name === agentName) ?? null;
}
