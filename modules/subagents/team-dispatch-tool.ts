import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { normalizeSubagentName } from "./names.ts";
import { buildTeamRoundPrompt, findRosterMember, rosterPath, upsertRosterMember, type RosterMember } from "./team.ts";
import type { RunningSubagent } from "./types.ts";

export interface TeamDispatchToolDeps {
  /** 本进程运行中的子代理(member 查找与在线判定)。 */
  runningSubagents: Map<string, RunningSubagent>;
  getArtifactDir: (sessionDir: string, sessionId: string) => string;
  rosterPath: (artifactDir: string) => string;
  findRosterMember: (path: string, name: string) => RosterMember | null;
  upsertRosterMember: (
    path: string,
    entry: Parameters<typeof upsertRosterMember>[1],
  ) => RosterMember;
  countSessionEntryLines: (sessionFile: string) => number;
}

interface DispatchContext {
  sessionManager: {
    getSessionFile(): string | null | undefined;
    getSessionId(): string;
    getSessionDir(): string;
  };
}

/**
 * `team_dispatch`:向持久团队成员(member: true)派发下一轮任务。
 *
 * 约束(最小 MVP,诚实边界):
 * - 只允许本会话登记的成员;非 member 名字直接拒绝(不隐式升级)。
 * - 每个成员同一时间至多一个在途轮次;在途时明确报 busy。
 * - 投递即返回 ack(经 RPC steer:运行中排队/空闲开新 run);轮次结果由
 *   父侧 round watcher 在 .round 结束信号后恰好回注一次。
 * - offline 成员不伪称在线:明确提示重启(subagent member: true)或显式
 *   resume(subagent_message,一次性任务语义)。
 */
export function registerTeamDispatchTool(pi: ExtensionAPI, deps: TeamDispatchToolDeps): void {
  pi.registerTool({
    name: "team_dispatch",
    label: "Dispatch to Team Member",
    description:
      "Dispatch the NEXT round of work to a persistent team member (spawned with subagent + member: true) by name. " +
      "Returns an immediate acknowledgement — the round runs asynchronously and its real result is delivered exactly once " +
      "as a steer message when the round ends (.round signal). One in-flight round per member at a time: dispatching while " +
      "a round is running is refused (wait for its result message). Members are session-scoped; an offline member " +
      "(stopped / host shutdown / reload) is reported explicitly with restart/resume guidance — never treated as online. " +
      "This tool never spawns anything: create members with subagent({ member: true }).",
    promptSnippet:
      "Dispatch the next round to a persistent team member by name; returns an ack, the round's result arrives later as a steer message.",
    parameters: Type.Object({
      name: Type.String({
        description:
          "Exact display name of a persistent team member spawned with member: true in this session.",
      }),
      task: Type.String({
        description: "The task for this round. Keep it self-contained: the member keeps its conversation across rounds.",
      }),
    }),

    renderCall(args, theme) {
      const target = typeof (args as any).name === "string" ? (args as any).name : "(unknown)";
      return new Text(
        "○ " + theme.fg("toolTitle", theme.bold(target)) + theme.fg("dim", " — team dispatch"),
        0,
        0,
      );
    },

    renderResult(result, _opts, theme) {
      const details = result.details as any;
      const name = details?.name ?? "member";
      if (details?.status === "dispatched") {
        return new Text(
          theme.fg("accent", "◆") + " " + theme.fg("toolTitle", theme.bold(name)) +
            theme.fg("accent", " — round dispatched"),
          0,
          0,
        );
      }
      const content = result.content[0];
      const text = content && content.type === "text" ? content.text : "";
      return new Text(theme.fg("dim", text), 0, 0);
    },

    async execute(_toolCallId, params, _signal, _onUpdate, ctx: DispatchContext) {
      const rawName = typeof params?.name === "string" ? params.name.trim() : "";
      const task = typeof params?.task === "string" ? params.task.trim() : "";
      if (!rawName) {
        const error = "Provide the team member's `name` (spawned with member: true) and a non-empty `task`.";
        return { content: [{ type: "text", text: error }], details: { error } };
      }
      if (!task) {
        const error = "Provide a non-empty `task` for this round.";
        return { content: [{ type: "text", text: error }], details: { error, name: rawName } };
      }
      const name = normalizeSubagentName(rawName, "");

      const member = Array.from(deps.runningSubagents.values()).find(
        (running) => running.member === true && running.name === name,
      );
      if (!member) {
        // 不在本进程运行态:查 roster 给出诚实提示(offline/未知)。
        const sessionFile = ctx?.sessionManager?.getSessionFile?.();
        let rosterEntry: RosterMember | null = null;
        if (sessionFile) {
          const rosterFile = deps.rosterPath(
            deps.getArtifactDir(ctx.sessionManager.getSessionDir(), ctx.sessionManager.getSessionId()),
          );
          rosterEntry = deps.findRosterMember(rosterFile, name);
        }
        if (rosterEntry) {
          return {
            content: [{
              type: "text",
              text:
                `Team member "${name}" is OFFLINE (${rosterEntry.offlineReason ?? "unknown reason"}). ` +
                `It is NOT running — do not dispatch work to it. Restart it with ` +
                `subagent({ agent: ${rosterEntry.agent ? `"${rosterEntry.agent}"` : "…"}, member: true, name: "${name}", … }) ` +
                `(fresh member process; its preserved session file is ${rosterEntry.sessionFile}), or resume its session as a ` +
                `one-shot task with subagent_message({ name: "${name}", message: "…" }).`,
            }],
            details: { error: "member-offline", name, roster: rosterEntry },
          };
        }
        return {
          content: [{
            type: "text",
            text:
              `No team member named "${name}" in this session. Members are created explicitly with ` +
              `subagent({ agent: "…", member: true, name: "${name}" }) and stay registered in the team roster. ` +
              `Regular one-shot sub-agents cannot receive team_dispatch.`,
          }],
          details: { error: "unknown-member", name },
        };
      }

      if (member.dispatchedRound) {
        return {
          content: [{
            type: "text",
            text:
              `Team member "${name}" already has a round in flight. Wait for its steer-delivered round result ` +
              `before dispatching again — do not queue work blindly.`,
          }],
          details: { error: "member-busy", name },
        };
      }

      const child = member.headlessChild;
      if (!child || child.exited || member.stdinLost) {
        return {
          content: [{
            type: "text",
            text:
              `Team member "${name}" is no longer reachable (process gone). Respawn it with ` +
              `subagent({ member: true, … }) or resume its preserved session with subagent_message.`,
          }],
          details: { error: "member-unreachable", name },
        };
      }

      // 轮次关联 nonce:baseline 先于投递记录(派单消息进入会话之后才会出
      // 现),steer 文本带 marker;父侧 round watcher 在 .round 认领时用它区分
      // 本次派单轮与交错的自发轮(见 index.ts watchMemberRound)。
      const roundEntryBaseline = deps.countSessionEntryLines(member.sessionFile);
      const roundId = randomUUID();
      try {
        child.steer(buildTeamRoundPrompt(roundId, task));
      } catch (error: any) {
        return {
          content: [{
            type: "text",
            text: `Could not deliver the round to "${name}": ${error?.message ?? String(error)}. Treat it as offline.`,
          }],
          details: { error: "dispatch-failed", name, detail: error?.message ?? String(error) },
        };
      }

      member.dispatchedRound = true;
      member.dispatchedRoundId = roundId;
      member.roundEntryBaseline = roundEntryBaseline;
      if (member.rosterFile) {
        try {
          deps.upsertRosterMember(member.rosterFile, {
            name: member.name,
            ...(member.agent ? { agent: member.agent } : {}),
            sessionFile: member.sessionFile,
            ...(member.pid != null ? { pid: member.pid } : {}),
            status: "dispatched",
            dispatchedAt: Date.now(),
          });
        } catch {
          // roster 写失败不影响派单;round watcher 的状态更新尽力而为。
        }
      }

      return {
        content: [{
          type: "text",
          text:
            `Round dispatched to team member "${name}". Do NOT assume or fabricate its result — the real result ` +
            `of this round will be delivered as a steer message exactly once when it ends. Meanwhile you can work on ` +
            `other tasks or dispatch to OTHER idle members.`,
        }],
        details: {
          name: member.name,
          id: member.id,
          sessionFile: member.sessionFile,
          status: "dispatched",
          roundId,
        },
      };
    },
  });
}
