import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { normalizeSubagentName } from "./names.ts";
import { buildTeamRoundPrompt, findRosterMember, rosterPath, upsertRosterMember, type RosterMember } from "./team.ts";
import type { RuntimeRegistry } from "./registry.ts";
import type { SubagentsTranslate } from "./messages/index.ts";

export interface TeamDispatchToolDeps {

  registry: RuntimeRegistry;
  getArtifactDir: (sessionDir: string, sessionId: string) => string;
  rosterPath: (artifactDir: string) => string;
  findRosterMember: (path: string, name: string) => RosterMember | null;
  upsertRosterMember: (
    path: string,
    entry: Parameters<typeof upsertRosterMember>[1],
  ) => RosterMember;
  countSessionEntryLines: (sessionFile: string) => number;
  readonly t?: SubagentsTranslate;
}

interface DispatchContext {
  sessionManager: {
    getSessionFile(): string | null | undefined;
    getSessionId(): string;
    getSessionDir(): string;
  };
}

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
        theme.fg("toolTitle", theme.bold(deps.t?.("module.subagents.tool.team_dispatch.display") ?? "Dispatch to team")) +
          " " + theme.fg("accent", target),
        0,
        0,
      );
    },

    renderResult(result, options, theme) {
      const details = result.details as any;
      if (details?.status === "dispatched") {
        if (!options.expanded) return new Text("", 0, 0);
        const text = result.content[0]?.type === "text" ? result.content[0].text : "";
        return new Text(
          [theme.fg("toolOutput", deps.t?.("module.subagents.tool.team_dispatch.result.dispatched") ?? "Round dispatched"), text ? theme.fg("muted", text) : ""].filter(Boolean).join("\n"),
          0,
          0,
        );
      }
      const content = result.content[0];
      const text = content && content.type === "text" ? content.text : "Dispatch failed";
      return new Text(theme.fg("error", text), 0, 0);
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

      const member = deps.registry.list().find(
        (running) => running.member === true && running.name === name,
      );
      if (!member) {

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
