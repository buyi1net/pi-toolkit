/**
 * 持久团队 MVP 的父会话侧协议文件(全部位于父会话 artifactDir 下):
 *
 *   team-roster.json       成员名册:每个 member 的运行状态(idle/dispatched/offline)。
 *                          父进程是唯一写者(成员侧只读),读-改-写 + tmp/rename 原子落盘。
 *   team-mailbox/<name>/   每成员一个收件箱目录;成员侧 team_send 原子投递
 *                          (<uuid>.msg.json,tmp+rename),父侧 round watcher 认领并经
 *                          RPC steer 注入目标成员后删除。
 *
 * 诚实边界(README 同步):fire-and-forget——发送成功只代表落盘成功,不保证
 * 目标在线期间消费;成员 offline 后残留消息不自动补投。无阻塞 request/response,
 * 天然不存在 A↔B 互等死锁。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { debugLog } from "./diagnostics.ts";
import { normalizeSubagentName } from "./names.ts";

/** 成员每轮结束写入的 sidecar(subagent-done.ts 的 agent_end 写入)。 */
export interface RoundSignal {
  version: 1;
  name: string;
  /** 进程内递增轮次序号(成员侧内存计数,仅供诊断)。 */
  seq: number;
  at: number;
}

// ── 派单轮关联 nonce ──────────────────────────────────────────────────
// team_dispatch 的每一轮生成唯一 roundId,经 steer 文本携带进入成员会话
// (成员侧无需感知);父侧 round watcher 在 .round 认领时检索会话用户消息,
// 只有确实出现过本次派单 marker 的 .round 才属于派单轮——自发轮(成员间
// 消息/ask 回复触发)的 .round 不会错误消费派单结果(见 index.ts
// watchMemberRound 的关联判定)。首轮(spawn 时的初始 prompt)同样带 marker,
// 保证语义统一。

/** 派单轮关联标记文本(出现在成员会话的用户消息里)。 */
export function teamRoundMarker(roundId: string): string {
  return `[team-round:${roundId}]`;
}

/** 组装带关联标记的派单 prompt(标记行是协议噪音,明确标注可忽略)。 */
export function buildTeamRoundPrompt(roundId: string, task: string): string {
  return `${teamRoundMarker(roundId)} (team round protocol marker — ignore this line)\n\n${task}`;
}

/** 原子写轮次结束信号(成员侧,tmp+rename)。 */
export function writeRoundSignal(sessionFile: string, signal: Omit<RoundSignal, "version">): void {
  const tmp = `${sessionFile}.round.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, ...signal } satisfies RoundSignal), "utf-8");
  renameSync(tmp, `${sessionFile}.round`);
}

/**
 * 父侧认领并消费轮次结束信号(atomic rename claim):消费恰好一次;
 * 读取失败/格式非法时删除并返回 null(坏信号不会重复触发回注)。
 */
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
  /** 当前在途轮次开始的时间戳(仅 dispatched)。 */
  dispatchedAt?: number;
  /** 最近一次轮次完成时间戳。 */
  lastRoundAt?: number;
  /** offline 原因(含 process-exited / prompt-rejected / round-association-failed / stopped / host-shutdown / host-reload)。 */
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

/**
 * 幂等 upsert + 状态转换。父进程单写者,无需锁;offline 是吸收态——
 * 再次登记(重新 spawn 同名 member)按新生命周期覆盖。
 */
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

// ── 成员间消息(mailbox)──────────────────────────────────────────────

export interface TeamMessage {
  version: 1;
  /** 发送方成员名(成员进程 env 注入,父侧信任来源)。 */
  from: string;
  /** 接收方成员名。 */
  to: string;
  text: string;
  sentAt: number;
}

// 同毫秒内多次投递的单调序号:文件名排序即投递顺序(父侧按序注入)。
let mailboxSeq = 0;

/** 原子投递一条 fire-and-forget 消息(tmp+rename;目录按需创建)。 */
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

/**
 * 认领并读取目标成员的全部待投递消息(按文件名时间升序),认领即移出
 * mailbox(rename 到 .processing,读完删除)——消费恰好一次;失败文件
 * 留在 .processing 供人工排查,不会重复注入。
 */
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
