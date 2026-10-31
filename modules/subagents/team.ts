import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { debugLog } from "./diagnostics.ts";
import { normalizeSubagentName } from "./names.ts";

export interface RoundSignal {
  version: 1;
  name: string;

  seq: number;
  at: number;
}

export function teamRoundMarker(roundId: string): string {
  return `[team-round:${roundId}]`;
}

export function buildTeamRoundPrompt(roundId: string, task: string): string {
  return `${teamRoundMarker(roundId)} (team round protocol marker — ignore this line)\n\n${task}`;
}

export function writeRoundSignal(sessionFile: string, signal: Omit<RoundSignal, "version">): void {
  const tmp = `${sessionFile}.round.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, ...signal } satisfies RoundSignal), "utf-8");
  renameSync(tmp, `${sessionFile}.round`);
}

export function claimRoundSignal(sessionFile: string): RoundSignal | null {
  const path = `${sessionFile}.round`;
  const claimed = `${path}.${process.pid}.${randomUUID()}.processing`;
  try {
    renameSync(path, claimed);
    const parsed = JSON.parse(readFileSync(claimed, "utf-8")) as RoundSignal;
    rmSync(claimed, { force: true });
    if (parsed?.version === 1 && typeof parsed.name === "string") return parsed;
    return null;
  } catch (error) {
    try { rmSync(claimed, { force: true }); } catch {}
    if (existsSync(path)) debugLog(`Could not claim round signal ${path}`, error);
    return null;
  }
}

export type MemberStatus = "idle" | "dispatched" | "offline";

export interface RosterMember {
  name: string;
  agent?: string;
  sessionFile: string;
  pid?: number;
  status: MemberStatus;

  dispatchedAt?: number;

  lastRoundAt?: number;

  offlineReason?: string;
}

interface RosterFile {
  version: 1;
  members: RosterMember[];
}

export function rosterPath(artifactDir: string): string {
  return join(artifactDir, "team-roster.json");
}

export function mailboxDir(artifactDir: string, memberName: string): string {
  return join(artifactDir, "team-mailbox", normalizeSubagentName(memberName, "member"));
}

function readRosterRaw(path: string): RosterFile {
  try {
    if (!existsSync(path)) return { version: 1, members: [] };
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as RosterFile;
    if (parsed?.version !== 1 || !Array.isArray(parsed.members)) return { version: 1, members: [] };
    return parsed;
  } catch (error) {
    debugLog(`Could not read team roster ${path}`, error);
    return { version: 1, members: [] };
  }
}

function writeRosterRaw(path: string, roster: RosterFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(roster), "utf-8");
  renameSync(tmp, path);
}

export function readRoster(path: string): RosterMember[] {
  return readRosterRaw(path).members.filter((member) =>
    member && typeof member.name === "string" && typeof member.sessionFile === "string" &&
    (member.status === "idle" || member.status === "dispatched" || member.status === "offline"),
  );
}

export function findRosterMember(path: string, name: string): RosterMember | null {
  const key = normalizeSubagentName(name, "");
  return readRoster(path).find((member) => member.name === key) ?? null;
}

export function upsertRosterMember(
  path: string,
  entry: {
    name: string;
    agent?: string;
    sessionFile: string;
    pid?: number;
    status: MemberStatus;
    dispatchedAt?: number;
    lastRoundAt?: number;
    offlineReason?: string;
  },
): RosterMember {
  const roster = readRosterRaw(path);
  const key = normalizeSubagentName(entry.name, "");
  const next: RosterMember = {
    name: key,
    ...(entry.agent ? { agent: entry.agent } : {}),
    sessionFile: entry.sessionFile,
    ...(entry.pid != null ? { pid: entry.pid } : {}),
    status: entry.status,
    ...(entry.dispatchedAt != null ? { dispatchedAt: entry.dispatchedAt } : {}),
    ...(entry.lastRoundAt != null ? { lastRoundAt: entry.lastRoundAt } : {}),
    ...(entry.offlineReason ? { offlineReason: entry.offlineReason } : {}),
  };
  const idx = roster.members.findIndex((member) => member.name === key);
  if (idx >= 0) roster.members[idx] = next;
  else roster.members.push(next);
  writeRosterRaw(path, roster);
  return next;
}

export function removeRosterMember(path: string, name: string): void {
  const roster = readRosterRaw(path);
  const key = normalizeSubagentName(name, "");
  const filtered = roster.members.filter((member) => member.name !== key);
  if (filtered.length === roster.members.length) return;
  writeRosterRaw(path, { version: 1, members: filtered });
}

export interface TeamMessage {
  version: 1;

  from: string;

  to: string;
  text: string;
  sentAt: number;
}

let mailboxSeq = 0;

export function postTeamMessage(artifactDir: string, message: Omit<TeamMessage, "version">): string {
  const dir = mailboxDir(artifactDir, message.to);
  mkdirSync(dir, { recursive: true });
  mailboxSeq += 1;
  const file = join(dir, `${Date.now()}-${String(mailboxSeq).padStart(6, "0")}-${randomUUID()}.msg.json`);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, ...message } satisfies TeamMessage), "utf-8");
  renameSync(tmp, file);
  return file;
}

export function claimTeamMessages(artifactDir: string, memberName: string): TeamMessage[] {
  const dir = mailboxDir(artifactDir, memberName);
  if (!existsSync(dir)) return [];
  const messages: TeamMessage[] = [];
  const files = readdirSync(dir)
    .filter((file) => file.endsWith(".msg.json"))
    .sort();
  for (const file of files) {
    const src = join(dir, file);
    const claimed = `${src}.${process.pid}.processing`;
    try {
      renameSync(src, claimed);
      const parsed = JSON.parse(readFileSync(claimed, "utf-8")) as TeamMessage;
      if (parsed?.version === 1 && typeof parsed.from === "string" && typeof parsed.text === "string") {
        messages.push(parsed);
      }
      rmSync(claimed, { force: true });
    } catch (error) {
      debugLog(`Could not claim team message ${src}`, error);
    }
  }
  return messages;
}
