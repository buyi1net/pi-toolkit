import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { debugLog } from "./diagnostics.ts";
import { subagentTaskDepth } from "./launch-config.ts";
import type { PublicAgentStatus } from "./registry.ts";
import type { ParentSessionUpdate } from "./parent-update-queue.ts";
import type { RunningSubagent } from "./types.ts";

const AGENT_TREE_FILE = "subagent-tree.jsonl";
const AGENT_TREE_BUBBLED_FILE = "subagent-bubbled-updates.jsonl";
const AGENT_TREE_VERSION = 1;
const SUMMARY_LIMIT = 200;

export interface AgentTreeRecord {
  v: number;
  agent_id: string;
  task_name: string;
  canonical_task_name: string;
  parent_agent_id: string | null;
  parent_canonical_task_name: string | null;
  status: PublicAgentStatus;
  summary: string;
  artifact_dir: string | null;
  session_file: string | null;
  pid: number | null;
  surface: string | null;
  surface_kind: "headless" | "herdr" | "tmux" | null;
  owner_pid: number;
  owner_session_id: string | null;
  updated_at: number;
}

export function agentTreeRootDir(localArtifactDir: string): string {
  const inherited = process.env.PI_SUBAGENT_ROOT_ARTIFACT_DIR?.trim();
  return inherited && inherited.length > 0 ? inherited : localArtifactDir;
}

export function agentTreePath(rootDir: string): string {
  return join(rootDir, AGENT_TREE_FILE);
}

export function bubbledUpdatesPath(rootDir: string): string {
  return join(rootDir, AGENT_TREE_BUBBLED_FILE);
}

export function canonicallyWithin(canonical: string, prefix: string): boolean {
  if (canonical === prefix) return true;
  const base = prefix.endsWith("/") ? prefix : `${prefix}/`;
  return canonical.startsWith(base);
}

export function appendAgentTreeRecord(rootDir: string, record: Omit<AgentTreeRecord, "v" | "updated_at">): void {
  const line: AgentTreeRecord = {
    ...record,
    v: AGENT_TREE_VERSION,
    summary: (record.summary ?? "").slice(0, SUMMARY_LIMIT),
    updated_at: Date.now(),
  };
  try {
    mkdirSync(dirname(agentTreePath(rootDir)), { recursive: true });
    appendFileSync(agentTreePath(rootDir), `${JSON.stringify(line)}\n`, "utf8");
  } catch (error) {
    debugLog("Could not append agent tree record", error);
  }
}

function parseRecord(line: string): AgentTreeRecord | null {
  try {
    const parsed = JSON.parse(line) as Partial<AgentTreeRecord>;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.agent_id !== "string" || parsed.agent_id === "") return null;
    if (typeof parsed.canonical_task_name !== "string") return null;
    if (typeof parsed.status !== "string") return null;
    return {
      v: typeof parsed.v === "number" ? parsed.v : AGENT_TREE_VERSION,
      agent_id: parsed.agent_id,
      task_name: typeof parsed.task_name === "string" ? parsed.task_name : parsed.canonical_task_name.split("/").pop() ?? "",
      canonical_task_name: parsed.canonical_task_name,
      parent_agent_id: typeof parsed.parent_agent_id === "string" ? parsed.parent_agent_id : null,
      parent_canonical_task_name: typeof parsed.parent_canonical_task_name === "string" ? parsed.parent_canonical_task_name : null,
      status: parsed.status as PublicAgentStatus,
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      artifact_dir: typeof parsed.artifact_dir === "string" ? parsed.artifact_dir : null,
      session_file: typeof parsed.session_file === "string" ? parsed.session_file : null,
      pid: typeof parsed.pid === "number" ? parsed.pid : null,
      surface: typeof parsed.surface === "string" ? parsed.surface : null,
      surface_kind:
        parsed.surface_kind === "headless" || parsed.surface_kind === "herdr" || parsed.surface_kind === "tmux"
          ? parsed.surface_kind
          : null,
      owner_pid: typeof parsed.owner_pid === "number" ? parsed.owner_pid : 0,
      owner_session_id: typeof parsed.owner_session_id === "string" ? parsed.owner_session_id : null,
      updated_at: typeof parsed.updated_at === "number" ? parsed.updated_at : 0,
    };
  } catch {
    return null;
  }
}

export function appendRunningAgentTreeRecord(params: {
  rootDir: string;
  running: RunningSubagent;
  status: PublicAgentStatus;
  summary: string;
  artifactDir: string;
  ownerSessionId: string | null;
}): AgentTreeRecord {
  const { running } = params;
  const parentCanonical = running.parentCanonicalTaskName ?? null;
  const canonical = running.canonicalTaskName ?? `${parentCanonical ?? "/root"}/${running.name}`;
  const record = {
    agent_id: running.id,
    task_name: running.name,
    canonical_task_name: canonical,
    parent_agent_id: running.parentId ?? null,
    parent_canonical_task_name: parentCanonical,
    status: params.status,
    summary: params.summary,
    artifact_dir: params.artifactDir,
    session_file: running.sessionFile ?? null,
    pid: running.pid ?? null,
    surface: running.surface ?? null,
    surface_kind: running.kind === "headless" ? "headless" : running.surfaceKind ?? null,
    owner_pid: process.pid,
    owner_session_id: params.ownerSessionId,
  } as const;
  appendAgentTreeRecord(params.rootDir, record);
  return { ...record, v: AGENT_TREE_VERSION, updated_at: Date.now() };
}

export function writeAgentTerminal(params: {
  rootDir: string;
  running: RunningSubagent;
  status: PublicAgentStatus;
  summary: string;
  artifactDir: string;
  ownerSessionId: string | null;
  update: ParentSessionUpdate;
}): void {
  const record = appendRunningAgentTreeRecord(params);
  if (subagentTaskDepth(record.canonical_task_name) >= 2) appendBubbledUpdate(params.rootDir, params.update);
}

export function readAgentTreeRecords(rootDir: string): AgentTreeRecord[] {
  let raw: string;
  try {
    if (!existsSync(agentTreePath(rootDir))) return [];
    raw = readFileSync(agentTreePath(rootDir), "utf8");
  } catch (error) {
    debugLog("Could not read agent tree", error);
    return [];
  }
  const folded = new Map<string, AgentTreeRecord>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const record = parseRecord(line);
    if (!record) continue;
    const existing = folded.get(record.agent_id);
    if (existing && existing.status === "closed" && record.status !== "closed") continue;
    folded.set(record.agent_id, record);
  }
  return [...folded.values()];
}

export function readAgentTreeRecord(rootDir: string, agentId: string): AgentTreeRecord | null {
  return readAgentTreeRecords(rootDir).find((record) => record.agent_id === agentId) ?? null;
}

type TerminalTreeOutcome = { action: "report"; status: PublicAgentStatus } | { action: "skip"; reason: "closed" };

export function terminalOutcomeFromTree(rootDir: string, agentId: string, fallbackStatus: PublicAgentStatus): TerminalTreeOutcome {
  const record = readAgentTreeRecord(rootDir, agentId);
  if (!record) return { action: "report", status: fallbackStatus };
  if (record.status === "closed") return { action: "skip", reason: "closed" };
  if (record.status === "waiting") return { action: "report", status: "interrupted" };
  return { action: "report", status: fallbackStatus };
}

function bubbledUpdateLine(update: ParentSessionUpdate): string {
  const { final_text: _finalText, ...rest } = update;
  return `${JSON.stringify({ v: AGENT_TREE_VERSION, ...rest, summary: (update.summary ?? "").slice(0, SUMMARY_LIMIT) })}\n`;
}

export function appendBubbledUpdate(rootDir: string, update: ParentSessionUpdate): void {
  try {
    mkdirSync(dirname(bubbledUpdatesPath(rootDir)), { recursive: true });
    appendFileSync(bubbledUpdatesPath(rootDir), bubbledUpdateLine(update), "utf8");
  } catch (error) {
    debugLog("Could not append bubbled subagent update", error);
  }
}

export function readBubbledUpdateFrom(
  rootDir: string,
  offset: number,
): { update: ParentSessionUpdate | null; nextOffset: number } | null {
  let raw: string;
  try {
    if (!existsSync(bubbledUpdatesPath(rootDir))) return null;
    raw = readFileSync(bubbledUpdatesPath(rootDir), "utf8");
  } catch (error) {
    debugLog("Could not read bubbled subagent updates", error);
    return null;
  }
  const safeOffset = Number.isSafeInteger(offset) && offset > 0 ? offset : 0;
  if (safeOffset >= raw.length) return null;
  const rest = raw.slice(safeOffset);
  const end = rest.indexOf("\n");
  if (end < 0) return null;
  const nextOffset = safeOffset + end + 1;
  let parsed: any;
  try {
    parsed = JSON.parse(rest.slice(0, end));
  } catch {
    return { update: null, nextOffset };
  }
  if (!parsed || typeof parsed.agent_id !== "string" || typeof parsed.update_id !== "string") {
    return { update: null, nextOffset };
  }
  const update: ParentSessionUpdate = {
    agent_id: parsed.agent_id,
    task_name: typeof parsed.task_name === "string" ? parsed.task_name : "",
    kind: "terminal",
    status: typeof parsed.status === "string" ? parsed.status : "completed",
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    update_id: parsed.update_id,
    update_seq: typeof parsed.update_seq === "number" ? parsed.update_seq : 0,
    delivery_id: typeof parsed.delivery_id === "string" ? parsed.delivery_id : `bubbled-${parsed.update_id}`,
  };
  return { update, nextOffset };
}
