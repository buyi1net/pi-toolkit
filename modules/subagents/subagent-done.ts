import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { renameSync, writeFileSync } from "node:fs";
import { compactRenderText, renderToolCardCall, renderToolCardResult, toolCardText, cardBackground } from "../../kit/tool-card.ts";

function writeSidecar(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}
import { createSubagentActivityRecorder } from "./activity.ts";
import { postTeamMessage, readRoster, rosterPath, writeRoundSignal } from "./team.ts";
import { normalizeSubagentName } from "./names.ts";
import { subagentsTableTranslator } from "./messages/index.ts";

export function shouldMarkUserTookOver(agentStarted: boolean): boolean {
  return agentStarted;
}

function collapsedReason(text: string): string | undefined {
  const compact = compactRenderText(text);
  if (!compact) return undefined;
  return compact.length > 48 ? `${compact.slice(0, 47)}…` : compact;
}

export function runningChildrenCount(): number {
  const fn = (globalThis as any)[Symbol.for("pi-subagents/running-children-count")];
  if (typeof fn !== "function") return 0;
  try {
    const n = fn();
    return typeof n === "number" && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function shouldAutoExitOnAgentEnd(
  _userTookOver: boolean,
  messages: any[] | undefined,
): boolean {

  if (messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === "assistant") {
        return msg.stopReason !== "aborted";
      }
    }
  }

  return true;
}

export interface SubagentErrorInfo {
  errorMessage: string;
  stopReason: "error";
}

export function findLatestAssistantError(
  messages: any[] | undefined,
): SubagentErrorInfo | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    if (msg.stopReason !== "error") return null;
    const raw = typeof msg.errorMessage === "string" ? msg.errorMessage.trim() : "";
    return {
      errorMessage: raw || "Subagent agent loop ended with stopReason=error (no errorMessage field).",
      stopReason: "error",
    };
  }
  return null;
}

export function parseDeniedTools(rawValue: string | undefined): string[] {
  return (rawValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function shouldWriteRoundSignal(
  memberMode: boolean,
  awaitingAnswer: boolean,
  pendingChildren: number,
): boolean {
  return memberMode && !awaitingAnswer && pendingChildren === 0;
}

export default function (pi: ExtensionAPI) {
  const toolText = subagentsTableTranslator("en");
  let toolNames: string[] = [];
  let denied: string[] = [];
  let expanded = false;

  const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
  const deniedToolsValue = process.env.PI_DENY_TOOLS;
  const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";
  const barrierMode = process.env.PI_SUBAGENT_BARRIER === "1";

  const memberMode = process.env.PI_SUBAGENT_MEMBER === "1";
  const teamDir = process.env.PI_SUBAGENT_TEAM_DIR ?? "";
  const peerSendAcl = parseDeniedTools(process.env.PI_SUBAGENT_PEER_SEND);
  let memberRoundSeq = 0;
  const recorder = createSubagentActivityRecorder({
    runningChildId: process.env.PI_SUBAGENT_ID,
    activityFile: process.env.PI_SUBAGENT_ACTIVITY_FILE,
  });

  function renderWidget(ctx: { ui: { setWidget: Function } }, _theme: any) {
    ctx.ui.setWidget(
      "subagent-tools",
      (_tui: any, theme: any) => {
        const box = new Box(1, 0, cardBackground(theme, "toolSuccessBg"));

        if (expanded) {

          const countInfo = theme.fg("dim", ` — ${toolNames.length} available`);
          const hint = theme.fg("muted", "  (Ctrl+Alt+O to collapse)");

          const toolList = toolNames
            .map((name: string) => theme.fg("dim", name))
            .join(theme.fg("muted", ", "));

          let deniedLine = "";
          if (denied.length > 0) {
            const deniedList = denied
              .map((name: string) => theme.fg("error", name))
              .join(theme.fg("muted", ", "));
            deniedLine = "\n" + theme.fg("muted", "denied: ") + deniedList;
          }

          const content = new Text(
            `${countInfo}${hint}\n${toolList}${deniedLine}`,
            0,
            0,
          );
          box.addChild(content);
        } else {

          const countInfo = theme.fg("dim", ` — ${toolNames.length} tools`);
          const deniedInfo =
            denied.length > 0
              ? theme.fg("dim", " · ") + theme.fg("error", `${denied.length} denied`)
              : "";
          const hint = theme.fg("muted", "  (Ctrl+Alt+O to expand)");

          const content = new Text(`${countInfo}${deniedInfo}${hint}`, 0, 0);
          box.addChild(content);
        }

        return box;
      },
      { placement: "aboveEditor" },
    );
  }

  let userTookOver = false;
  let agentStarted = false;

  let awaitingAnswer = false;

  pi.on("session_start", async (_event, ctx) => {
    const provider = process.env.PI_SUBAGENT_MODEL_PROVIDER;
    const modelId = process.env.PI_SUBAGENT_MODEL_ID;
    const api = process.env.PI_SUBAGENT_MODEL_API ?? "";
    const baseUrl = process.env.PI_SUBAGENT_MODEL_BASE_URL ?? "";
    if (provider && modelId) {
      const models = (ctx as any).modelRegistry?.getAll?.() as Array<Record<string, unknown>> | undefined;
      const selected = models?.find((model) => model.provider === provider && model.id === modelId && (model.api ?? "") === api && (model.baseUrl ?? "") === baseUrl);
      if (selected) await pi.setModel(selected as any);
    }
    recorder.sessionStart();
    const tools = pi.getAllTools();
    toolNames = tools.map((t) => t.name).sort();
    denied = parseDeniedTools(deniedToolsValue);

    renderWidget(ctx, null);
  });

  pi.on("input", () => {
    recorder.input();

    awaitingAnswer = false;

    if (!shouldMarkUserTookOver(agentStarted)) return;
    userTookOver = true;
  });

  pi.on("before_agent_start", () => {
    recorder.beforeAgentStart();
  });

  pi.on("agent_start", () => {
    agentStarted = true;

    awaitingAnswer = false;
    recorder.agentStart();
  });

  pi.on("agent_end", (event, ctx) => {
    const messages = (event as any).messages as any[] | undefined;

    const hasPendingChildren = runningChildrenCount() > 0;
    const shouldExit =
      !awaitingAnswer &&
      !hasPendingChildren &&
      autoExit &&
      shouldAutoExitOnAgentEnd(userTookOver, messages);

    if (shouldExit) {

      const errorInfo = findLatestAssistantError(messages);
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (errorInfo && sessionFile) {
        try {
          writeSidecar(
            `${sessionFile}.exit`,
            JSON.stringify({
              type: "error",
              errorMessage: errorInfo.errorMessage,
              stopReason: errorInfo.stopReason,
            }),
          );
        } catch {
          // Best effort — even without the sidecar, watcher's session-file
          // fallback can still recover the errorMessage.
        }
      }

      recorder.agentEndDone();
      ctx.shutdown();
      return;
    }

    recorder.agentEndWaiting();

    if (
      shouldWriteRoundSignal(memberMode, awaitingAnswer, runningChildrenCount()) &&
      process.env.PI_SUBAGENT_SESSION
    ) {
      memberRoundSeq += 1;
      try {
        writeRoundSignal(process.env.PI_SUBAGENT_SESSION, {
          name: subagentName || "member",
          seq: memberRoundSeq,
          at: Date.now(),
        });
      } catch {
        // 信号写失败不阻断 park;父侧会在进程死亡时兑出降级结果。
      }
    }
    if (autoExit) {

      userTookOver = false;
    }
  });

  pi.on("turn_start", (event) => {
    recorder.turnStart((event as any).turnIndex);
  });

  pi.on("turn_end", (event) => {
    recorder.turnEnd((event as any).turnIndex);
  });

  pi.on("before_provider_request", () => {
    recorder.beforeProviderRequest();
  });

  pi.on("after_provider_response", () => {
    recorder.afterProviderResponse();
  });

  pi.on("message_update", (event) => {
    recorder.messageUpdate((event as any).assistantMessageEvent?.type);
  });

  pi.on("tool_execution_start", (event) => {
    recorder.toolExecutionStart(event.toolCallId, event.toolName, event.parentToolCallId);
  });

  pi.on("tool_call", (event) => {
    recorder.toolCall(event.toolCallId, event.toolName, event.parentToolCallId);
  });

  pi.on("tool_execution_update", (event) => {
    recorder.toolExecutionUpdate(event.toolCallId, event.toolName, event.parentToolCallId);
  });

  pi.on("tool_result", (event) => {
    recorder.toolResult(event.toolCallId, event.toolName, event.parentToolCallId);
  });

  pi.on("tool_execution_end", (event) => {
    recorder.toolExecutionEnd(event.toolCallId, event.toolName, event.parentToolCallId);
  });

  pi.on("session_shutdown", (event) => {
    recorder.sessionShutdown((event as any).reason);
  });

  pi.registerShortcut("ctrl+alt+o", {
    description: "Toggle subagent tools widget",
    handler: (ctx) => {
      expanded = !expanded;
      renderWidget(ctx, null);
    },
  });

  const questionLifecycleHint = barrierMode
    ? "In autonomous barrier mode your session checkpoints and exits after sending the question; the orchestrator resumes it with the answer. "
    : "Your session stays open while you wait — the answer arrives as your next message, then you continue. ";

  pi.registerTool({
    name: "ask_question",
    label: "ask_question",
    description:
      "Ask the orchestrator (the parent agent that spawned you) a single question. " +
      "Use this when requirements are ambiguous, a decision would materially affect your work, you're blocked, " +
      "or you need information or confirmation only the orchestrator has. Prefer asking over guessing. " +
      questionLifecycleHint +
      "Ask exactly one question per call; make separate calls for unrelated questions.",
    promptSnippet:
      "Use this tool to ask the orchestrator one clarifying, missing-requirement, preference, or decision question before continuing — instead of guessing.",
    promptGuidelines: [
      "Ask exactly one question per tool call.",
      "If you need answers to multiple things, make separate ask_question calls instead of bundling them.",
      "Prefer this tool over guessing when requirements, preferences, or implementation choices are unclear.",
      "Use it when multiple valid paths exist and the right one depends on the orchestrator's intent.",
      "Give enough context in the question that the orchestrator can answer without re-reading your whole task.",
      "After asking, stop and wait — the reply will arrive as your next message.",
    ],
    parameters: Type.Object({
      question: Type.String({
        description:
          "The single freeform question to ask the orchestrator. Include enough context to answer it directly.",
      }),
    }),
    renderShell: "self",
    renderCall(args, theme, context) {
      return renderToolCardCall(
        {
          title: toolText("module.subagents.tool.ask_question.display"),
          object: compactRenderText((args as any).question) || "(question)",
        },
        theme,
        context,
      );
    },
    renderResult(result, options, theme, context) {
      const details = (result.details ?? {}) as {
        question?: unknown;
        checkpoint?: boolean;
        deferredExit?: boolean;
        pendingChildren?: number;
      };
      const question =
        compactRenderText(details.question) ||
        compactRenderText((context?.args as { question?: unknown } | undefined)?.question) ||
        "(question)";
      const text = toolCardText(result);
      const status = context?.isError
        ? collapsedReason(text)
        : details.deferredExit
          ? `checkpoint deferred (${details.pendingChildren ?? 0} in flight)`
          : details.checkpoint
            ? "checkpoint"
            : "waiting for reply";
      return renderToolCardResult(
        {
          title: toolText("module.subagents.tool.ask_question.display"),
          object: question,
          status,
          details: options.expanded ? text.split("\n") : [],
        },
        theme,
        options,
        context,
      );
    },
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (!sessionFile) {
        return {
          content: [{ type: "text", text: "ask_question is only available in subagent contexts. PI_SUBAGENT_SESSION environment variable is not set." }],
          details: { error: "subagent-session-unavailable" },
          isError: true,
        };
      }

      const checkpoint = autoExit && barrierMode;
      awaitingAnswer = !checkpoint;
      recorder.askQuestion();
      const askData = {
        name: process.env.PI_SUBAGENT_NAME ?? "subagent",
        agent: process.env.PI_SUBAGENT_AGENT ?? "",
        question: params.question,
      };
      writeSidecar(`${sessionFile}.ask`, JSON.stringify(askData));

      if (checkpoint) {

        const pendingChildren = runningChildrenCount();
        if (pendingChildren > 0) {
          return {
            content: [{
              type: "text",
              text:
                `Question sent to the orchestrator. This run still has ${pendingChildren} sub-agent(s) in flight; ` +
                `the session stays alive until they finish and will only then checkpoint and exit. ` +
                `The orchestrator has the question and will answer via send_message (or continue this session with followup_task) — keep waiting ` +
                `for your sub-agents and do not assume the question is answered yet.`,
            }],
            details: {
              question: params.question,
              checkpoint: true,
              deferredExit: true,
              pendingChildren,
            },
          };
        }
        _ctx.shutdown();
        return {
          content: [{
            type: "text",
            text:
              "Question sent to the orchestrator. This autonomous run is checkpointing and will exit; " +
              "the orchestrator should continue this session with followup_task after the answer is ready.",
          }],
          details: { question: params.question, checkpoint: true },
        };
      }

      return {
        content: [
          {
            type: "text",
            text:
              "Question sent to the orchestrator. Stop here and wait — do not continue working or " +
              "assume an answer. Their reply will arrive as your next message.",
          },
        ],
        details: { question: params.question },
      };
    },
  });

  if (memberMode) {
    pi.registerTool({
      name: "team_send",
      label: "team_send",
      description:
        "Send a FIRE-AND-FORGET note to another persistent team member (one-way, never blocking, no reply channel). " +
        "Allowed targets are limited by this member's profile `peer-send` ACL; offline or unknown targets are refused. " +
        "Delivery is best-effort: success only means the message was queued to the target's mailbox and will be injected " +
        "into its running process — do not wait for a reply and do not assume it was read. If you need a result, ask the " +
        "orchestrator to dispatch a round instead.",
      parameters: Type.Object({
        to: Type.String({ description: "Exact display name of the target team member (must be in this profile's peer-send ACL)." }),
        text: Type.String({ description: "The note text. Keep it short and self-contained; it arrives prefixed with your member name." }),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
        if (!teamDir) {
          return { content: [{ type: "text", text: "team_send requires PI_SUBAGENT_TEAM_DIR (member spawn must set it)." }], details: { error: "team-session-unavailable" }, isError: true };
        }
        const to = normalizeSubagentName(typeof params?.to === "string" ? params.to : "", "");
        const text = typeof params?.text === "string" ? params.text : "";
        if (!to) {
          return { content: [{ type: "text", text: "Provide the target member's `name`." }], details: { error: "missing-target" }, isError: true };
        }

        if (!text.trim()) {
          return { content: [{ type: "text", text: "Provide a non-empty `text`." }], details: { error: "missing-text", to }, isError: true };
        }
        if (peerSendAcl.length === 0 || !peerSendAcl.includes(to)) {
          return {
            content: [{
              type: "text",
              text:
                `Not allowed: "${to}" is not in this profile's peer-send ACL` +
                `${peerSendAcl.length > 0 ? ` (allowed: ${peerSendAcl.join(", ")})` : " (no peer-send declared)"}.`,
            }],
            details: { error: "acl-denied", to },
            isError: true,
          };
        }

        const target = readRoster(rosterPath(teamDir)).find(
          (entry) => entry.name === to,
        );
        if (!target) {
          return {
            content: [{ type: "text", text: `No team member named "${to}" is registered in this session's roster.` }],
            details: { error: "unknown-target", to },
            isError: true,
          };
        }
        if (target.status === "offline") {
          return {
            content: [{
              type: "text",
              text:
                `Team member "${to}" is OFFLINE (${target.offlineReason ?? "unknown"}). The message was NOT delivered — ` +
                `tell the orchestrator to restart it if this matters.`,
            }],
            details: { error: "target-offline", to },
            isError: true,
          };
        }
        postTeamMessage(teamDir, {
          from: subagentName || "member",
          to,
          text,
          sentAt: Date.now(),
        });
        return {
          content: [{
            type: "text",
            text:
              `Note queued to "${to}" (fire-and-forget). Do NOT wait for or assume a reply — it arrives in the ` +
              `target's conversation, not yours. Continue your own work.`,
          }],
          details: { to, queued: true },
        };
      },

      renderShell: "self",
      renderCall(args, theme, context) {
        return renderToolCardCall(
          {
            title: toolText("module.subagents.tool.team_send.display"),
            object: compactRenderText((args as any).to) || "(target)",
          },
          theme,
          context,
        );
      },
      renderResult(result, options, theme, context) {
        const details = (result.details ?? {}) as { to?: unknown; queued?: unknown; error?: unknown };
        const target =
          compactRenderText(details.to) ||
          compactRenderText((context?.args as { to?: unknown } | undefined)?.to) ||
          "(target)";
        const text = toolCardText(result);
        const status = context?.isError
          ? collapsedReason(text)
          : details.queued
            ? "queued"
            : details.error
              ? String(details.error)
              : undefined;
        return renderToolCardResult(
          {
            title: toolText("module.subagents.tool.team_send.display"),
            object: target,
            status,
            details: options.expanded ? text.split("\n") : [],
          },
          theme,
          options,
          context,
        );
      },
    });
  }
}
