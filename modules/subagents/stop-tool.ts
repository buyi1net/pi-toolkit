import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { debugLog } from "./diagnostics.ts";
import type { RunningSubagent, SubagentResult } from "./types.ts";
import type { SubagentsTranslate } from "./messages/index.ts";

export interface SubagentStopToolDeps {

  resolveRunningByName: (name: string) => { running: RunningSubagent } | { error: string };

  closeSurface: (surface: string) => void;
  updateWidget: () => void;

  settleTimeoutMs?: number;

  stopMember?: (running: RunningSubagent) => void;
  readonly t?: SubagentsTranslate;
}

const STOP_SETTLE_TIMEOUT_MS = 10_000;

export function registerSubagentStopTool(pi: ExtensionAPI, deps: SubagentStopToolDeps): void {
  pi.registerTool({
    name: "subagent_stop",
    label: "Stop Subagent",
    description:
      "Explicitly stop a RUNNING subagent by name — this is the ONLY way to terminate one. " +
      "Aborting the spawning tool call (Escape) only detaches the wait: the sub-agent keeps running and is NOT cancelled. " +
      "subagent_message text is never interpreted as a stop command. " +
      "Only subagents registered by THIS session's pi-subagents extension can be stopped; finished sub-agents have no live process to stop. " +
      "Stopping kills the headless process / closes the pane, cleans up its runtime registration, settles its dependency record as cancelled, " +
      "and delivers a single terminal result through the existing path (the blocked tool call, or a late steer message if the wait was detached).",
    promptSnippet:
      "Stop a running subagent by name — the only explicit stop entry point. Escape-detached sub-agents keep running; use this to really terminate one.",
    parameters: Type.Object({
      name: Type.String({
        description:
          "Exact display name of the RUNNING subagent to stop (see subagents_list scope:session). " +
          "Names are unique per session; finished sub-agents cannot be stopped.",
      }),
    }),

    renderCall(args, theme) {
      const target = typeof (args as any).name === "string" ? (args as any).name : "(unknown)";
      return new Text(
        theme.fg("toolTitle", theme.bold(deps.t?.("module.subagents.tool.subagent_stop.display") ?? "Stop subagent")) +
          " " + theme.fg("accent", target),
        0,
        0,
      );
    },

    renderResult(result, options, theme) {
      const details = result.details as any;
      if (details?.status === "stopped") {
        if (!options.expanded) return new Text("", 0, 0);
        return new Text(theme.fg("toolOutput", deps.t?.("module.subagents.tool.subagent_stop.result.stopped") ?? "Stopped"), 0, 0);
      }
      if (details?.status === "stop-requested") {
        return new Text(theme.fg("warning", deps.t?.("module.subagents.tool.subagent_stop.result.stopRequested") ?? "Stop requested; settling"), 0, 0);
      }
      const content = result.content[0];
      const text = content && content.type === "text" ? content.text : "Stop failed";
      return new Text(theme.fg("error", text), 0, 0);
    },

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const rawName = typeof params?.name === "string" ? params.name.trim() : "";
      if (!rawName) {
        const error = "Provide the exact `name` of the running subagent to stop.";
        return { content: [{ type: "text", text: error }], details: { error }, isError: true };
      }
      const resolved = deps.resolveRunningByName(rawName);
      if ("error" in resolved) {
        return {
          content: [{
            type: "text",
            text:
              `${resolved.error} ` +
              `Only subagents still running in this session can be stopped — finished ones have no live process. ` +
              `Use subagents_list with scope "session" to see what is running.`,
          }],
          details: { error: resolved.error, name: rawName },
          isError: true,
        };
      }

      const running = resolved.running;

      if (running.member) {
        running.stopRequested = true;
        deps.stopMember?.(running);
        deps.updateWidget();
        return {
          content: [{
            type: "text",
            text:
              `Team member "${running.name}" was stopped: its process was terminated and the roster marks it offline. ` +
              `Its session/loadout are preserved at ${running.sessionFile} — resume it as a one-shot task with ` +
              `subagent_message, or respawn a fresh member with subagent({ member: true, … }) if the team still needs it.`,
          }],
          details: {
            id: running.id,
            name: running.name,
            sessionFile: running.sessionFile,
            status: "stopped",
            member: true,
          },
        };
      }

      running.stopRequested = true;

      if (running.interactive && running.kind !== "headless") {
        try {
          deps.closeSurface(running.surface);
        } catch (error) {
          debugLog(`Could not close interactive pane ${running.surface} during stop`, error);
        }
      }

      running.abortController?.abort();
      deps.updateWidget();

      if (running.watchPromise) {
        const timeoutMs = deps.settleTimeoutMs ?? STOP_SETTLE_TIMEOUT_MS;
        type StopSettle =
          | { ok: true; result: SubagentResult | null; error?: string }
          | { ok: false };
        const settled: StopSettle = await Promise.race([
          running.watchPromise.then(
            (result): StopSettle => ({ ok: true, result }),
            (error: any): StopSettle => ({
              ok: true,
              result: null,
              error: error?.message ?? String(error),
            }),
          ),
          new Promise<StopSettle>((resolve) =>
            setTimeout(() => resolve({ ok: false }), timeoutMs),
          ),
        ]);
        if (settled.ok && settled.result) {
          return {
            content: [{
              type: "text",
              text:
                `Sub-agent "${running.name}" was stopped. Its process/pane was terminated, its runtime ` +
                `registration cleaned up, and its dependency record settled as cancelled. ` +
                (settled.result.sessionFile
                  ? `Its session file is preserved at ${settled.result.sessionFile} and can be resumed with subagent_message.`
                  : `A terminal result is being delivered through the existing path.`),
            }],
            details: {
              id: running.id,
              name: running.name,
              sessionFile: settled.result.sessionFile ?? running.sessionFile,
              status: "stopped",
              exitCode: settled.result.exitCode,
              elapsed: settled.result.elapsed,
            },
          };
        }
        if (settled.ok && settled.result === null) {

          const errorText = settled.error ?? "unknown watcher error";
          return {
            content: [{
              type: "text",
              text:
                `Stop signal was delivered to "${running.name}", but its watcher ended with an error: ${errorText}. ` +
                `Treat the sub-agent as stopped and check its session if needed.`,
            }],
            details: { id: running.id, name: running.name, status: "stopped", error: errorText },
          };
        }
        if (!settled.ok) {
          return {
            content: [{
              type: "text",
              text:
                `Stop signal was delivered to "${running.name}"; it did not settle within ` +
                `${timeoutMs / 1000}s (the watcher may still be tearing down). ` +
                `The terminal result will arrive through the existing delivery path — do not respawn.`,
            }],
            details: { id: running.id, name: running.name, status: "stop-requested" },
          };
        }
      }

      return {
        content: [{
          type: "text",
          text:
            `Stop signal was delivered to "${running.name}". The sub-agent is being terminated; ` +
            `its terminal result will arrive through the existing delivery path.`,
        }],
        details: { id: running.id, name: running.name, status: "stop-requested" },
      };
    },
  });
}
