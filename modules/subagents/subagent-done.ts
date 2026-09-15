/**
 * Extension loaded into sub-agents.
 * - Shows agent identity + available tools as a styled widget above the editor (toggle with Ctrl+Alt+O)
 * - Provides an `ask_question` tool for asking the parent orchestrator a question
 *
 * Subagents do NOT self-terminate via a tool. Auto-exit agents shut down
 * automatically when their agent loop ends (see the `agent_end` handler);
 * interactive agents end when the human exits the pane.
 *
 * `ask_question` keeps the session OPEN: it writes a `${sessionFile}.ask`
 * signal the parent's watcher picks up, parks the session in a "waiting" state
 * (auto-exit is suppressed for that turn via `awaitingAnswer`), and the parent
 * replies with subagent_message — which lands as the subagent's next turn.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { renameSync, writeFileSync } from "node:fs";

/** sidecar 协议文件(.exit/.ask)原子写:tmp+rename,避免部分写入被父侧读走。 */
function writeSidecar(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}
import { createSubagentActivityRecorder } from "./activity.ts";
import { postTeamMessage, readRoster, rosterPath, writeRoundSignal } from "./team.ts";
import { normalizeSubagentName } from "./names.ts";

export function shouldMarkUserTookOver(agentStarted: boolean): boolean {
  return agentStarted;
}

/**
 * Number of child subagents this session itself still has in flight.
 *
 * When this extension is loaded inside a subagent that can spawn its own
 * children (e.g. a worker delegating to plan/researcher), `index.ts` runs in
 * the same process and publishes a live count through a shared process-global
 * symbol. A subagent that spawns children and then writes a "waiting for
 * results" message would otherwise auto-exit the instant that turn ends —
 * killing the session before its children report back. Reading this count lets
 * `agent_end` keep the session open until every child has finished and its
 * result has been delivered.
 *
 * Returns 0 when the spawning tools aren't loaded (plan/researcher, or a
 * standalone session), so those agents auto-exit exactly as before.
 */
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
  // Manual input should not strand an auto-exit subagent. If the latest agent
  // turn completed normally, close the session. Escape/abort still leaves it
  // open for inspection or another prompt.
  //
  // stopReason: "error" (e.g. exhausted retries on a provider overload) also
  // returns true — we want to shut down so the parent is woken up — but we
  // pair this with findLatestAssistantError() so the parent learns it was an
  // error, not a clean completion.
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

/**
 * If the last assistant message in the turn ended with `stopReason: "error"`
 * (typically auto-retry exhausted on an overload / rate limit / server error),
 * return its error info so the parent orchestrator can surface a clear
 * failure instead of silently treating the run as completed.
 *
 * Returns `null` when the latest assistant turn completed normally or was
 * aborted by the user (handled separately by shouldAutoExitOnAgentEnd).
 */
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

/** 持久成员的轮次结束信号判定(纯函数):成员模式且本轮真正落定——
 *  无待答问题(ask 等待的 park 不是轮次完成)、无在途孙代理(它们的
 *  结果还没回来,提前宣布轮次完成会丢弃后续交付)。 */
export function shouldWriteRoundSignal(
  memberMode: boolean,
  awaitingAnswer: boolean,
  pendingChildren: number,
): boolean {
  return memberMode && !awaitingAnswer && pendingChildren === 0;
}

export default function (pi: ExtensionAPI) {
  let toolNames: string[] = [];
  let denied: string[] = [];
  let expanded = false;

  // Read subagent identity from env vars (set by parent orchestrator)
  const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
  const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";
  const deniedToolsValue = process.env.PI_DENY_TOOLS;
  const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";
  // A blocking parent tool cannot wait forever while an autonomous child parks
  // for input: the parent's turn is still busy, so it cannot call
  // subagent_message to answer. In barrier mode, ask_question therefore acts
  // as a durable checkpoint: notify the parent, request a graceful exit, and
  // let the parent resume this session with the answer. Interactive/demo panes
  // keep the original live waiting behavior.
  const barrierMode = process.env.PI_SUBAGENT_BARRIER === "1";
  // 持久团队成员:常驻进程(无 barrier/无 auto-exit),轮次结束写 .round;
  // 拥有受限的成员间直信工具 team_send(peer-send ACL)。
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
        const box = new Box(1, 0, (text: string) => theme.bg("toolSuccessBg", text));

        const label = subagentAgent || subagentName;
        const agentTag = label ? theme.bold(theme.fg("accent", `[${label}]`)) : "";

        if (expanded) {
          // Expanded: full tool list + denied
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
            `${agentTag}${countInfo}${hint}\n${toolList}${deniedLine}`,
            0,
            0,
          );
          box.addChild(content);
        } else {
          // Collapsed: one-line summary
          const countInfo = theme.fg("dim", ` — ${toolNames.length} tools`);
          const deniedInfo =
            denied.length > 0
              ? theme.fg("dim", " · ") + theme.fg("error", `${denied.length} denied`)
              : "";
          const hint = theme.fg("muted", "  (Ctrl+Alt+O to expand)");

          const content = new Text(`${agentTag}${countInfo}${deniedInfo}${hint}`, 0, 0);
          box.addChild(content);
        }

        return box;
      },
      { placement: "aboveEditor" },
    );
  }

  let userTookOver = false;
  let agentStarted = false;
  // Set when ask_question is called; suppresses auto-exit so the session stays
  // open while it waits for the orchestrator's reply. Cleared when the reply
  // lands — on `input` (covers a reply steered into the current run) and on
  // `agent_start` (covers a reply that starts a fresh turn after parking).
  let awaitingAnswer = false;

  // Show widget + status bar on session start
  pi.on("session_start", (_event, ctx) => {
    recorder.sessionStart();
    const tools = pi.getAllTools();
    toolNames = tools.map((t) => t.name).sort();
    denied = parseDeniedTools(deniedToolsValue);

    renderWidget(ctx, null);
  });

  pi.on("input", () => {
    recorder.input();
    // A submitted message is the orchestrator's (or a human's) reply — the
    // pending ask_question has been answered, however it was delivered. Clear
    // here, not only on agent_start, because a reply steered in *mid-run* is
    // absorbed into the current run (pi's `steer` behavior injects it before
    // the next LLM call): no new agent_start fires, so without this the flag
    // would stay set and agent_end would park the session as `waiting` even
    // though the answer already arrived and was consumed. (The `input` event
    // fires for mid-run steers because prompt() emits it before queueing.)
    awaitingAnswer = false;
    // Ignore the initial task message that starts an autonomous subagent.
    // Only inputs after the first agent run has started count as user takeover.
    if (!shouldMarkUserTookOver(agentStarted)) return;
    userTookOver = true;
  });

  pi.on("before_agent_start", () => {
    recorder.beforeAgentStart();
  });

  pi.on("agent_start", () => {
    agentStarted = true;
    // A new turn is starting — any pending ask_question has now been answered
    // (or superseded), so let auto-exit resume normally when this turn ends.
    awaitingAnswer = false;
    recorder.agentStart();
  });

  pi.on("agent_end", (event, ctx) => {
    const messages = (event as any).messages as any[] | undefined;
    // Never shut down while this session still has work in flight:
    //  - awaitingAnswer: an ask_question is pending the orchestrator's reply.
    //  - runningChildrenCount(): this subagent spawned its own children and is
    //    waiting for their results (delivered as steered turns). Exiting now
    //    would strand those children and drop their results.
    // In both cases the session parks as `waiting` and resumes when the next
    // turn lands.
    const hasPendingChildren = runningChildrenCount() > 0;
    const shouldExit =
      !awaitingAnswer &&
      !hasPendingChildren &&
      autoExit &&
      shouldAutoExitOnAgentEnd(userTookOver, messages);

    if (shouldExit) {
      // Surface stopReason: "error" turns (auto-retry exhausted, provider
      // overload, etc.) to the parent via the .exit sidecar so the watcher
      // can report a clear failure with the underlying error message.
      // Without this the parent would only see exit code 0 and a stale
      // assistant message, mistaking the crash for a successful completion.
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
    // 持久成员:本轮真正落定(无待答问题、无在途孙代理)时写轮次结束
    // 信号;父侧 round watcher 认领后恰好回注一次。"进程仍存活"是成员的
    // 常态,轮次终态以 .round 为准。
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
      // Reset any recorded manual input marker. Auto-exit is decided by whether
      // the latest agent turn completed normally, not by who initiated it.
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
    recorder.toolExecutionStart((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_call", (event) => {
    recorder.toolCall((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_update", (event) => {
    recorder.toolExecutionUpdate((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_result", (event) => {
    recorder.toolResult((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_end", (event) => {
    recorder.toolExecutionEnd((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("session_shutdown", (event) => {
    recorder.sessionShutdown((event as any).reason);
  });

  // Toggle expand/collapse with Ctrl+Alt+O
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
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (!sessionFile) {
        throw new Error(
          "ask_question is only available in subagent contexts. " +
            "PI_SUBAGENT_SESSION environment variable is not set.",
        );
      }

      // Interactive/demo panes can remain live while the parent answers. An
      // autonomous child is awaited by a blocking parent tool, so parking it
      // would deadlock that parent; barrier mode turns the question into a
      // checkpoint that is resumed by subagent_message after this process exits.
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
        // ctx.shutdown() is graceful: the current tool result and session
        // entries are flushed, then subagent-done's agent_end handler permits
        // the auto-exit. The parent receives the .ask notification and can
        // resume this durable session with the answer once this tool settles.
        //
        // 但绝不能在本会话自身仍有在途孙代理时 shutdown——那会把孙代理一并
        // 终止并丢失它们的结果。此时采用延迟退出:.ask 已写入、父侧收到通知;
        // agent_end 的 runningChildrenCount 抑制自动退出,会话停留 waiting,
        // 孙代理全部交付后的最终 agent_end 自然 checkpoint 退出(此时父侧
        // 无论 steer 还是 resume 都能送达答案)。
        const pendingChildren = runningChildrenCount();
        if (pendingChildren > 0) {
          return {
            content: [{
              type: "text",
              text:
                `Question sent to the orchestrator. This run still has ${pendingChildren} sub-agent(s) in flight; ` +
                `the session stays alive until they finish and will only then checkpoint and exit. ` +
                `The orchestrator has the question and will answer via subagent_message — keep waiting ` +
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
              "the orchestrator should resume this session with the answer via subagent_message.",
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

    renderCall(args, theme) {
      const text =
        theme.fg("toolTitle", theme.bold("ask_question ")) +
        theme.fg("muted", String((args as any).question ?? ""));
      return new Text(text, 0, 0);
    },
  });

  // ── 持久成员间直信(仅 member 模式注册)──────────────────────────
  // fire-and-forget:写入目标成员 mailbox 后立即返回;父侧 round watcher
  // 认领并经 RPC steer 注入。无阻塞 request/response——不存在互等死锁。
  // ACL:仅 profile 的 peer-send 列出的成员名可投递;发送方身份取自父
  // 进程注入的 env(成员无法冒名——它只能用自己的 PI_SUBAGENT_NAME)。
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
          throw new Error("team_send requires PI_SUBAGENT_TEAM_DIR (member spawn must set it).");
        }
        const to = normalizeSubagentName(typeof params?.to === "string" ? params.to : "", "");
        const text = typeof params?.text === "string" ? params.text : "";
        if (!to) {
          return { content: [{ type: "text", text: "Provide the target member's `name`." }], details: { error: "missing-target" } };
        }
        // 空白校验用 trim,但投递保留原文(fire-and-forget 忠实传递)。
        if (!text.trim()) {
          return { content: [{ type: "text", text: "Provide a non-empty `text`." }], details: { error: "missing-text", to } };
        }
        if (peerSendAcl.length === 0 || !peerSendAcl.includes(to)) {
          return {
            content: [{
              type: "text",
              text:
                `Not allowed: "${to}" is not in this profile's peer-send ACL` +
                `${peerSendAcl.length > 0 ? ` (allowed: ${peerSendAcl.join(", ")})` : " (no peer-send declared)"}. ` +
                `Ask the orchestrator to relay the information instead.`,
            }],
            details: { error: "acl-denied", to },
          };
        }
        // 目标状态核验(成员只读 roster):offline/未知目标明确拒绝,不伪称在线。
        const target = readRoster(rosterPath(teamDir)).find(
          (entry) => entry.name === to,
        );
        if (!target) {
          return {
            content: [{ type: "text", text: `No team member named "${to}" is registered in this session's roster.` }],
            details: { error: "unknown-target", to },
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

      renderCall(args, theme) {
        const to = String((args as any).to ?? "?");
        return new Text(
          theme.fg("toolTitle", theme.bold("team_send → ")) + theme.fg("muted", to),
          0,
          0,
        );
      },
    });
  }
}
