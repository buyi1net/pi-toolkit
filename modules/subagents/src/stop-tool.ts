import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import { debugLog } from "./diagnostics.ts";
import type { RunningSubagent, SubagentResult } from "./types.ts";

export interface SubagentStopToolDeps {
  /** 按名字解析本会话运行中的子代理(含空名/未知名/重名的明确错误)。 */
  resolveRunningByName: (name: string) => { running: RunningSubagent } | { error: string };
  /** 关闭 pane(内部 assertOwned 白名单护栏:只关本扩展创建/接管的 pane)。 */
  closeSurface: (surface: string) => void;
  updateWidget: () => void;
  /** 等待落定上限(毫秒),缺省 STOP_SETTLE_TIMEOUT_MS;测试可注入短时限。 */
  settleTimeoutMs?: number;
  /** 持久成员终止(成员 watcher 不兑终态,由这里直接 kill + roster offline)。 */
  stopMember?: (running: RunningSubagent) => void;
}

/**
 * 等待停止落定的上限:watcher 轮询 tick 为 1s,10s 足够宽裕;超时不伪造
 * "已停止",如实报告 stop-requested(停止信号已发出,落定稍后自行完成)。
 */
const STOP_SETTLE_TIMEOUT_MS = 10_000;

/**
 * `subagent_stop`:唯一的显式停止入口。
 *
 * 生命周期契约(与 Escape/detached 语义严格分离):
 * - 主工具等待被 Escape 中止只会让工具调用返回 detached——子代理继续运行,
 *   不会被杀、不会被记成 cancelled;真正终止子代理只发生在本工具。
 * - 普通的 subagent_message 文本不是停止命令,绝不解析为隐式指令。
 * - 只允许操作本会话内由本插件登记、且仍在运行的子代理;已结束的子代理
 *   没有可停止的进程,明确报错引导(subagents_list 查看)。
 *
 * 执行路径:置 stopRequested 标志(让 watcher 把停止后的 pane 消失按显式
 * cancelled 落定,不误分类 user_closed)→ 交互式 pane 在此直接关闭(自动
 * pane/headless 由 watcher 的 cancelled 分支统一终止)→ abort watcher →
 * 等 watcher 兑出终态(幂等:watcher promise 单次 resolve,结果回注仍由
 * 原有路径——阻塞中的工具调用或 detached 迟到回注——恰好各一次)。
 */
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
        "○ " + theme.fg("toolTitle", theme.bold(target)) + theme.fg("dim", " — stop"),
        0,
        0,
      );
    },

    renderResult(result, _opts, theme) {
      const details = result.details as any;
      const name = details?.name ?? "subagent";
      if (details?.status === "stopped") {
        return new Text(
          theme.fg("error", "■") + " " + theme.fg("toolTitle", theme.bold(name)) +
            theme.fg("warning", " — stopped"),
          0,
          0,
        );
      }
      if (details?.status === "stop-requested") {
        return new Text(
          theme.fg("warning", "■") + " " + theme.fg("toolTitle", theme.bold(name)) +
            theme.fg("dim", " — stop requested (settling)"),
          0,
          0,
        );
      }
      const content = result.content[0];
      const text = content && content.type === "text" ? content.text : "";
      return new Text(theme.fg("dim", text), 0, 0);
    },

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const rawName = typeof params?.name === "string" ? params.name.trim() : "";
      if (!rawName) {
        const error = "Provide the exact `name` of the running subagent to stop.";
        return { content: [{ type: "text", text: error }], details: { error } };
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
        };
      }

      const running = resolved.running;
      // 持久成员:watcher 是常驻轮询(不兑终态 promise),停止由专用入口
      // 直接终止进程 + roster offline,同步返回 stopped(不等待 watcher 轮次)。
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
      // 标记先于 abort:watcher 观察到停止后的 pane 消失时按显式 cancelled
      // 落定,不会误分类为 user_closed(用户直接关闭)。
      running.stopRequested = true;
      // 交互式 pane 归用户驱动,watcher 的取消分支不会关它——显式停止时在
      // 此直接关闭(closeSurface 内 assertOwned 白名单护栏只放行本插件
      // 创建/接管的 pane)。已死 pane 报错忽略,watcher 会按停止终态落定。
      if (running.interactive && running.kind !== "headless") {
        try {
          deps.closeSurface(running.surface);
        } catch (error) {
          debugLog(`Could not close interactive pane ${running.surface} during stop`, error);
        }
      }
      // 中止 watcher 等待循环:watcher 判定 cancelled(显式 stop)后终止
      // headless 进程/关闭自动 pane、移除 runtime record、兑 cancelled 终态。
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
          // watcher reject(正常不发生):停止已发出,如实报告错误。
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

      // 无 watchPromise(旧 mock/极端竞态):停止信号已发出,不伪造完成。
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
