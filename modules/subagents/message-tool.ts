import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { normalizeSubagentName } from "./names.ts";
import { routeExceptionFromResult } from "./route-error.ts";
import { announceCompletion, settleCompletionFromResult } from "./dependencies.ts";
import { validateTimeoutMs, waitForSubagentTerminal, type WaitRelease } from "./subagent-tool.ts";
import type { RuntimeRegistry } from "./registry.ts";
import type { ResumeStartedRun, SubagentStartup } from "./startup.ts";
import type { SubagentResult } from "./types.ts";

interface MessageContext {
  sessionManager: {
    getSessionId(): string;
    getSessionDir(): string;
  };
  /** Parent session cwd; needed when a legacy loadout did not persist cwd. */
  cwd?: string;
}

export interface SubagentMessageToolDeps {
  /** 启动事务：resume 的会话/授权校验、拼装、进程启动、登记与 watcher 启动。 */
  startup: SubagentStartup;
  /** 运行态登记表：运行中/保留中的路由查询与等待解除标记。 */
  registry: RuntimeRegistry;
  handleSubagentSteer: (params: { name?: string; message?: string }) => unknown;
  /** 结果提取（非启动职责：启动只负责把运行态与 watcher 交给调用方）。 */
  extractSubagentResult: (
    sessionFile: string,
    result: Pick<SubagentResult, "exitCode" | "summary" | "errorMessage">,
    afterLine?: number,
    fallbackPrefix?: string,
  ) => Promise<{ summary: string; stats: NonNullable<SubagentResult["stats"]> | null; sessionId: string | null }>;
  resolveResultPresentation: (
    result: SubagentResult,
    name: string,
    options?: { sessionPreserved?: boolean },
  ) => string;
  updateWidget: () => void;
}

export function registerSubagentMessageTool(
  pi: ExtensionAPI,
  deps: SubagentMessageToolDeps,
): void {
  pi.registerTool({
    name: "subagent_message",
    label: "Message Subagent",
    description:
      "Send a message to a subagent by name. Names are unique within your session and persist after a subagent finishes, " +
      "so the SAME name works whether the subagent is running or finished: if it is still running, your message steers its live session; " +
      "if it has finished, your message resumes that session and continues it. " +
      "`name` and `message` are both required. " +
      "Steering a running subagent returns immediately with a local acknowledgement and does NOT, by itself, emit a new result. " +
      "For an idle persistent team member, a steer starts an untracked spontaneous run whose round result is not delivered; use team_dispatch for tracked work. " +
      "Resuming BLOCKS this call until the resumed sub-agent reaches a terminal state and returns its real result directly as the tool result; " +
      "aborting this call (Escape) only DETACHES the wait — the resumed sub-agent keeps running and its result arrives later as a steer message (once); it is NOT cancelled. " +
      "TIMEOUT (timeoutMs): optional wait bound in milliseconds (>= 1000) for the blocking resume wait. When it fires, the call returns a structured non-terminal `timed-out` result — the resumed sub-agent keeps running, nothing is killed or cleaned up, no summary is fabricated, and the real result arrives later as a single steer message. Omit it to wait indefinitely. Only applies when the message RESUMES a finished sub-agent; steering a running one returns immediately, so the timeout is not used there. " +
      "Use subagent_stop to actually terminate a running sub-agent early; a message's text is never interpreted as a stop command. " +
      "Sibling calls in the same assistant message run in parallel and all settle before the turn continues. " +
      "DO NOT poll, sleep, tail logs, or read session files to detect completion. If you need a deliberate one-time diagnostic snapshot, use subagent_inspect; do not call it repeatedly just to wait. " +
      "DO NOT fabricate or assume results. After calling, either end your turn or work on other independent tasks.",
    promptSnippet:
      "Message a subagent by name: steers it if running (returns immediately), resumes it if finished (blocks until terminal state and returns the real result). " +
      "`name` and `message` are required. Do not poll or fabricate results.",
    parameters: Type.Object({
      name: Type.String({
        description:
          "Exact display name of the subagent. Steers it if it is still running; resumes its session if it has finished.",
      }),
      message: Type.String({
        description:
          "The message to deliver: a follow-up instruction for a running subagent, or the next task for a resumed session.",
      }),
      timeoutMs: Type.Optional(
        Type.Integer({
          minimum: 1000,
          description:
            "Optional wait timeout in milliseconds (>= 1000) for the BLOCKING resume wait. When it fires, the call returns a " +
            "non-terminal `timed-out` result; the resumed sub-agent keeps running and its real result arrives later as a single " +
            "steer message. Omit to wait indefinitely. Ignored when the message steers a still-running sub-agent (that returns immediately).",
        }),
      ),
    }),

    renderCall(args, theme) {
      const target = args.name ?? "(unknown)";
      return new Text(
        "○ " + theme.fg("toolTitle", theme.bold(target)) + theme.fg("dim", " — message"),
        0,
        0,
      );
    },

    renderResult(result, _opts, theme) {
      const details = result.details as any;
      if (details?.status === "steered") {
        return new Text(
          theme.fg("success", "✓") + " " +
            theme.fg("toolTitle", theme.bold(details.name ?? "subagent")) +
            theme.fg("dim", " — message delivered"),
          0,
          0,
        );
      }
      if (details?.status === "started") {
        return new Text(
          theme.fg("accent", "⟳") + " " +
            theme.fg("toolTitle", theme.bold(details.name ?? "Resume")) +
            theme.fg("dim", " — resumed"),
          0,
          0,
        );
      }
      if (details?.status === "handed-off") {
        return new Text(
          theme.fg("accent", "⏳") + " " +
            theme.fg("toolTitle", theme.bold(details.name ?? "Resume")) +
            theme.fg("dim", " — handed off after reload"),
          0,
          0,
        );
      }
      // Escape 中止等待:非终态,子代理仍在运行,真实结果稍后迟到回注。
      if (details?.status === "detached") {
        return new Text(
          theme.fg("accent", "⇄") + " " +
            theme.fg("toolTitle", theme.bold(details.name ?? "Resume")) +
            theme.fg("dim", " — detached (still running; late result to follow)"),
          0,
          0,
        );
      }
      // 用户直接关闭 pane:稳定分类,不是 provider/agent 错误。
      if (details?.status === "user_closed") {
        return new Text(
          theme.fg("warning", "✕") + " " +
            theme.fg("toolTitle", theme.bold(details.name ?? "Resume")) +
            theme.fg("warning", " — closed by user"),
          0,
          0,
        );
      }
      // 等待超时:非终态,resumed 子代理仍在运行,真实结果稍后迟到回注。
      if (details?.status === "timed-out") {
        const bound = typeof details.timeoutMs === "number" ? ` after ${Math.round(details.timeoutMs / 1000)}s` : "";
        return new Text(
          theme.fg("warning", "⏱") + " " +
            theme.fg("toolTitle", theme.bold(details.name ?? "Resume")) +
            theme.fg("warning", ` — timed out${bound} (still running; late result to follow)`),
          0,
          0,
        );
      }
      // 硬屏障终态:自动 resume 的结果直接作为 tool result 返回,按状态渲染。
      if (details?.status === "completed" || details?.status === "failed" || details?.status === "cancelled") {
        const elapsed = typeof details.elapsed === "number" ? ` · ${details.elapsed}s` : "";
        const reason =
          details.status === "completed"
            ? theme.fg("dim", `completed${elapsed}`)
            : details.status === "cancelled"
              ? theme.fg("warning", `cancelled${elapsed}`)
              : theme.fg("error", `failed${elapsed}`);
        const icon = details.status === "completed" ? theme.fg("success", "✓") : theme.fg("error", "✗");
        return new Text(icon + " " + theme.fg("toolTitle", theme.bold(details.name ?? "Resume")) + " " + reason, 0, 0);
      }
      const content = result.content[0];
      const text = content && content.type === "text" ? content.text : "";
      return new Text(theme.fg("dim", text), 0, 0);
    },

    async execute(_toolCallId, params, signal, _onUpdate, ctx: MessageContext) {
      // 与 spawn 路径同規则 normalize:不改变已干净的名称,但多余空白/超长
      // 名称在 steer 与 resume 两条路径上的寻址行为一致。
      const requestedName = normalizeSubagentName(params.name?.trim() ?? "", "");
      if (!requestedName) {
        const error = "Provide the subagent's `name` to steer (if running) or resume (if finished).";
        return { content: [{ type: "text" as const, text: error }], details: { error } };
      }
      const message = params.message?.trim();
      if (!message) {
        const error = "Provide a non-empty `message` to steer or resume a subagent.";
        return { content: [{ type: "text" as const, text: error }], details: { error } };
      }
      // timeoutMs 校验(信任边界:模型传参);非法值在拉起任何进程前拒绝。
      const timeoutError = validateTimeoutMs(params.timeoutMs);
      if (timeoutError) {
        return { content: [{ type: "text" as const, text: timeoutError }], details: { error: timeoutError } };
      }
      const runningMatch = deps.registry.findByName(requestedName);
      if (runningMatch) {
        const steerResult = deps.handleSubagentSteer({ name: requestedName, message: params.message }) as
          | { content?: Array<{ type: string; text?: string }>; details?: Record<string, unknown> }
          | undefined;
        // 持久成员的 steer 不是一次性任务语义:新轮工作必须走 team_dispatch,
        // 轮次结果由 round watcher 回注——这里补充不误导的指引。
        if (runningMatch.member && !steerResult?.details?.error) {
          const base = Array.isArray(steerResult?.content) && steerResult.content[0]?.type === "text"
            ? (steerResult.content[0].text ?? "")
            : "";
          const guidance = runningMatch.dispatchedRound === false
            ? `Note: "${requestedName}" is a persistent team member and was idle. This steer starts a spontaneous run; its round signal is ` +
              `consumed internally and its result is NOT delivered as a tracked result. Use team_dispatch({ name: "${requestedName}", task: "…" }) ` +
              `for work whose real result must arrive later as a steer message, exactly once.`
            : `Note: "${requestedName}" is a persistent team member — this message steers its CURRENT run and does not start a separate one-shot task. ` +
              `Dispatch new rounds of work with team_dispatch({ name: "${requestedName}", task: "…" }); each dispatched round's real result ` +
              `arrives later as a steer message, exactly once.`;
          return {
            ...(steerResult ?? {}),
            content: [{ type: "text" as const, text: base ? `${base}\n\n${guidance}` : guidance }],
          };
        }
        return steerResult;
      }

      const name = requestedName;
      if (deps.registry.isNameReserved(name)) {
        const error = `Subagent "${name}" is already being launched or resumed. Wait for that operation to finish.`;
        return { content: [{ type: "text" as const, text: error }], details: { error } };
      }
      // 启动事务第一阶段（resume）：名字解析、会话文件存在性、锚定 loadout
      // 与目标合法性校验都在启动模块内完成；命中同会话的运行态交回工具 steer。
      const planned = deps.startup.planResume(
        { name, message, timeoutMs: params.timeoutMs },
        ctx,
      );
      if (planned.kind === "steer") {
        // handleSubagentSteer 的返回形状由宿主决定，与上面的运行中路由同一兑底。
        return deps.handleSubagentSteer({ name: planned.name, message: params.message }) as any;
      }
      if (planned.kind === "error") {
        return {
          content: [{ type: "text" as const, text: planned.error }],
          details: planned.details ?? { error: planned.error },
        };
      }
      const plan = planned.plan;
      const sessionPath = plan.sessionPath;
      const resumedSessionId = plan.resumedSessionId;
      const entryCountBefore = plan.entryCountBefore;
      const cohortDetails = plan.cohortId ? { cohortId: plan.cohortId } : {};

      deps.registry.reserveName(name);
      // resume 同样是依赖提供者:名字确定后、真正拉起进程前登记完成记录,
      // 下游 spawn 的 dependsOn 即可等待本次 resume 的终态。
      announceCompletion(name, { interactive: false });
      let started: ResumeStartedRun;
      try {
        // 启动事务第二阶段:清理旧 sidecar、拼装环境与 argv、启动进程、登记、
        // 按运行类别启动 watcher；失败自清理由启动模块负责。
        started = await deps.startup.resume(plan, ctx, pi);
      } catch (error) {
        // resume 启动失败也必须释放完成记录:等待者拿到明确失败,不永久挂起。
        settleCompletionFromResult(name, {
          exitCode: 1,
          errorMessage: error instanceof Error ? error.message : String(error),
        }, { source: "launch-failure" });
        deps.registry.releaseName(name);
        throw error;
      }
      const running = started.running;
      const watcherSignal = started.signal;

      // resume 默认是自动子代理(resolveResumeLaunchBehavior 恒为 interactive: false):
      // 硬等待终态,真实结果作为 tool result 返回;与 spawn 的硬屏障同语义,
      // pi 的 sibling 并行执行保证同 turn 内多个 spawn/resume 全部落定后 turn 才继续。
      // 若未来引入交互式 resume(interactive: true),保持异步立即返回 + steer 回注。
      //
      // 中止语义与 spawn 一致(Escape ≠ 取消):宿主中止等待不转发到 watcher,
      // 子代理继续运行,本调用返回 detached 非终态;真实结果由 watcher 终态
      // 时迟到回注一次(resume 无 retention,不清理工件)。
      if (!running.interactive) {
        const watchPromise = started.watch as Promise<SubagentResult>;
        running.watchPromise = watchPromise;
        // 三向竞速(watcher 终态 / Escape / 可选 timeoutMs)与 spawn 的硬屏障
        // 同源:等待解除只影响本调用,resumed 子代理继续运行,迟到回注一次。
        const raced = await waitForSubagentTerminal({ watchPromise, running, signal, timeoutMs: params.timeoutMs ?? undefined });
        if (typeof raced === "object" && "kind" in raced) {
          const released: WaitRelease = raced;
          running.waitReleased = released.kind;
          deps.registry.markWaitReleased(running.runtimeFile, running.id, released.kind);
          // 主工具等待被中止:resumed 子代理仍在运行,不 settle、不提取伪结果;
          // 迟到回注恰好一次(watcher promise 单次 resolve;handedOff 移交给
          // 恢复路径,不回注)。
          watchPromise
            .then(async (late) => {
              deps.updateWidget();
              // handed-off 的提取/回注归恢复路径;但等待者必须被唤醒。
              if (late.handedOff) {
                settleCompletionFromResult(name, late);
                return;
              }
              const extracted = await deps.extractSubagentResult(
                sessionPath,
                late,
                entryCountBefore,
                "Resumed session",
              );
              const finalResult: SubagentResult = {
                ...late,
                summary: extracted.summary,
                sessionFile: sessionPath,
                sessionId: resumedSessionId,
                ...cohortDetails,
              };
              settleCompletionFromResult(name, finalResult, {
                ...(finalResult.userClosed || finalResult.stopped ? { status: "cancelled" as const } : {}),
              });
              const presentation = finalResult.stopped
                ? `Sub-agent "${name}" was stopped explicitly (subagent_stop) after the wait had been detached — ` +
                  `no result was produced. Its session is preserved; resume it again if the task still matters.`
                : deps.resolveResultPresentation(finalResult, name);
              const routeException = finalResult.userClosed || finalResult.stopped
                ? undefined
                : routeExceptionFromResult(finalResult, running.model);
              pi.sendMessage(
                {
                  customType: "subagent_result",
                  content: presentation,
                  display: true,
                  details: {
                    name,
                    task: message,
                    ...cohortDetails,
                    exitCode: late.exitCode,
                    elapsed: late.elapsed,
                    sessionFile: sessionPath,
                    sessionId: resumedSessionId,
                    status: late.userClosed ? "user_closed" : late.stopped ? "cancelled" : late.exitCode !== 0 || late.errorMessage ? "failed" : "completed",
                    lateDelivery: "detached",
                    ...(late.userClosed ? { userClosed: true } : {}),
                    ...(late.errorMessage ? { errorMessage: late.errorMessage } : {}),
                    ...(late.stats ? { stats: late.stats } : {}),
                    ...(routeException ? { routeException } : {}),
                  },
                },
                { triggerTurn: true, deliverAs: "steer" },
              );
            })
            .catch((lateError: any) => {
              deps.updateWidget();
              settleCompletionFromResult(name, {
                exitCode: 1,
                errorMessage: lateError?.message ?? String(lateError),
                sessionFile: sessionPath,
              });
              pi.sendMessage(
                {
                  customType: "subagent_result",
                  content: `Resume error after detached wait: ${lateError?.message ?? String(lateError)}`,
                  display: true,
                  details: { name, ...cohortDetails, error: lateError?.message, lateDelivery: "detached" },
                },
                { triggerTurn: true, deliverAs: "steer" },
              );
            });
          deps.registry.releaseName(name);
          if (released.kind === "timeout") {
            return {
              content: [{
                type: "text",
                text:
                  `Resume of "${name}" wait timed out after ${Math.round((params.timeoutMs ?? 0) / 1000)}s (timeoutMs) — this is NOT a result. ` +
                  `The resumed sub-agent is STILL RUNNING and was NOT cancelled, and no summary exists yet — do not assume one. ` +
                  `Its real result will be delivered as a steer message when it finishes, exactly once. ` +
                  `Do not resume it again meanwhile; steer it with subagent_message if needed, or stop it with subagent_stop.`,
              }],
              details: {
                id: running.id,
                name,
                ...cohortDetails,
                sessionId: resumedSessionId,
                sessionFile: sessionPath,
                elapsed: Math.floor((Date.now() - running.startTime) / 1000),
                timeoutMs: params.timeoutMs ?? undefined,
                status: "timed-out",
              },
            };
          }
          return {
            content: [{
              type: "text",
              text:
                `Resume of "${name}" was DETACHED: your tool-call wait was aborted (Escape), but the resumed ` +
                `sub-agent is STILL RUNNING and was NOT cancelled — no result exists yet. ` +
                `Its real result will be delivered as a steer message when it finishes, exactly once. ` +
                `Do not resume it again; steer it with subagent_message if needed, or stop it with subagent_stop.`,
            }],
            details: {
              id: running.id,
              name,
              ...cohortDetails,
              sessionId: resumedSessionId,
              sessionFile: sessionPath,
              elapsed: Math.floor((Date.now() - running.startTime) / 1000),
              status: "detached",
            },
          };
        }

        const watcherResult: SubagentResult = raced;

        deps.updateWidget();
        // /reload 移交:显式 handed-off 语义,不提取伪结果、不报 failed;
        // 恢复路径会在子代理结束后经 steer 消息回注真实结果。
        if (watcherResult.handedOff) {
          // 等待者(如有)必须被唤醒:handed-off 也是注册表承认的终态。
          settleCompletionFromResult(name, watcherResult);
          deps.registry.releaseName(name);
          return {
            content: [{
              type: "text",
              text:
                `Resume of "${name}" was handed off to recovery because the host was reloaded (/reload). ` +
                `The resumed sub-agent is still running; its real result will be delivered as a steer message ` +
                `when it finishes. Do not treat this as a failure.`,
            }],
            details: {
              id: running.id,
              name,
              ...cohortDetails,
              sessionId: resumedSessionId,
              sessionFile: sessionPath,
              elapsed: watcherResult.elapsed,
              status: "handed-off",
            },
          };
        }
        const extracted = await deps.extractSubagentResult(
          sessionPath,
          watcherResult,
          entryCountBefore,
          "Resumed session",
        );
        const userClosed = !!watcherResult.userClosed;
        const cancelled = watcherSignal.aborted || userClosed || !!watcherResult.stopped;
        const finalResult: SubagentResult = {
          ...watcherResult,
          summary: extracted.summary,
          sessionFile: sessionPath,
          sessionId: resumedSessionId,
          ...cohortDetails,
        };
        const failed = finalResult.exitCode !== 0 || !!finalResult.errorMessage;
        const routeException = cancelled
          ? undefined
          : routeExceptionFromResult(finalResult, running.model);
        // 终态落定完成记录:取消(含用户关闭 pane)兑 cancelled,失败/成功
        // 按结果映射,摘要用 extract 后的真实回复文本。
        settleCompletionFromResult(name, finalResult, {
          ...(cancelled ? { status: "cancelled" as const } : {}),
        });
        deps.registry.releaseName(name);
        return {
          content: [{
            type: "text",
            text: userClosed
              ? `Resume of "${name}" ended because its pane was closed by the user — no result was produced. ` +
                `This is not a provider or agent error. Its session is preserved; resume it again if the task still matters.`
              : cancelled
              ? `Resume of "${name}" was stopped before finishing — no result was produced. ` +
                `Its session is preserved; resume again with subagent_message({ name: "${name}", message: "…" }) if needed.`
              : deps.resolveResultPresentation(finalResult, name),
          }],
          details: {
            id: running.id,
            name,
            ...cohortDetails,
            sessionId: resumedSessionId,
            sessionFile: sessionPath,
            exitCode: finalResult.exitCode,
            elapsed: finalResult.elapsed,
            status: userClosed ? "user_closed" : cancelled ? "cancelled" : failed ? "failed" : "completed",
            ...(userClosed ? { userClosed: true } : {}),
            ...(finalResult.errorMessage ? { errorMessage: finalResult.errorMessage } : {}),
            ...(finalResult.stats ? { stats: finalResult.stats } : {}),
            ...(routeException ? { routeException } : {}),
          },
        };
      }

      const interactiveWatch = started.watch as Promise<SubagentResult>;
      running.watchPromise = interactiveWatch;
      interactiveWatch
        .then(async (result) => {
          deps.updateWidget();
          settleCompletionFromResult(name, result, {
            ...(result.userClosed ? { status: "cancelled" as const } : {}),
          });
          // /reload 移交:恢复路径回注真实结果,这里跳过,避免伪造/重复结果。
          if (result.handedOff) return;
          const extracted = await deps.extractSubagentResult(
            sessionPath,
            result,
            entryCountBefore,
            "Resumed session",
          );
          const finalResult: SubagentResult = {
            ...result,
            summary: extracted.summary,
            sessionFile: sessionPath,
            sessionId: resumedSessionId,
            ...cohortDetails,
          };
          const presentation = deps.resolveResultPresentation(finalResult, name);
          const routeException = routeExceptionFromResult(finalResult, running.model);
          pi.sendMessage(
            {
              customType: "subagent_result",
              content: presentation,
              display: true,
              details: {
                name,
                task: message,
                ...cohortDetails,
                exitCode: result.exitCode,
                elapsed: result.elapsed,
                sessionFile: sessionPath,
                sessionId: resumedSessionId,
                status: result.userClosed ? "user_closed" : result.exitCode !== 0 || result.errorMessage ? "failed" : "completed",
                ...(result.userClosed ? { userClosed: true } : {}),
                ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
                ...(result.stats ? { stats: result.stats } : {}),
                ...(routeException ? { routeException } : {}),
              },
            },
            { triggerTurn: true, deliverAs: "steer" },
          );
        })
        .catch((error) => {
          deps.updateWidget();
          settleCompletionFromResult(name, { exitCode: 1, errorMessage: error?.message ?? String(error) });
          // watcher 正常不会 reject;万一 reject,真实上报错误信息。
          pi.sendMessage(
            {
              customType: "subagent_result",
              content: `Resume error: ${error?.message ?? String(error)}`,
              display: true,
              details: { name, ...cohortDetails, error: error?.message },
            },
            { triggerTurn: true, deliverAs: "steer" },
          );
        });

      deps.registry.releaseName(name);
      return {
        content: [{ type: "text", text: `Session "${name}" resumed.` }],
        details: {
          id: running.id,
          name,
          ...cohortDetails,
          sessionId: resumedSessionId,
          sessionFile: sessionPath,
          status: "started",
        },
      };
    },

  });
}
