import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  countSessionEntryLines,
  getSessionId,
  readNameRegistry,
  readSubagentLoadout,
  resolveNameInRegistry,
  type AnchoredSubagentLoadout,
  type SubagentLoadout,
} from "./session.ts";
import { getSubagentActivityFile } from "./activity.ts";
import { createStatusState } from "./status.ts";
import { normalizeSubagentName, sanitizeSubagentFileName } from "./names.ts";
import { routeExceptionFromResult } from "./route-error.ts";
import { announceCompletion, settleCompletionFromResult } from "./dependencies.ts";
import { normalizeCohortId } from "./params.ts";
import { sentinelSuffix } from "./surface.ts";
import {
  createSubagentLaunchEnv,
  formatHeadlessSurface,
  spawnHeadlessPi,
  type HeadlessChild,
} from "./headless.ts";
import { debugLog } from "./diagnostics.ts";
import { createRuntimeRecord, markRuntimeWaitReleased } from "./runtime-registry.ts";
import { validateTimeoutMs, waitForSubagentTerminal, type WaitRelease } from "./subagent-tool.ts";
import type { RunningSubagent, SubagentResult } from "./types.ts";

interface MessageContext {
  sessionManager: {
    getSessionId(): string;
    getSessionDir(): string;
  };
  /** Parent session cwd; needed when a legacy loadout did not persist cwd. */
  cwd?: string;
}

export interface SubagentMessageToolDeps {
  isMuxAvailable: () => boolean;
  muxUnavailableResult: () => any;
  /** 表面选择:resume 恒为自动任务,auto 默认即 headless;仅 pane 需要 mux。 */
  resolveSurfaceChoice: (params: { surface?: string }) => { choice: "headless" | "pane" } | { error: string };
  spawnHeadlessPi: typeof spawnHeadlessPi;
  runningSubagents: Map<string, RunningSubagent>;
  reservedNames: Set<string>;
  handleSubagentSteer: (params: { name?: string; message?: string }) => unknown;
  getArtifactDir: (sessionDir: string, sessionId: string) => string;
  readNameRegistry: typeof readNameRegistry;
  resolveNameInRegistry: typeof resolveNameInRegistry;
  getSessionId: typeof getSessionId;
  readSubagentLoadout: typeof readSubagentLoadout;
  /** 父侧锚定 loadout 副本读取(resume 授权单一真源;legacy 快照返回 null)。 */
  readAnchoredLoadout: (artifactDir: string, sessionFile: string) => AnchoredSubagentLoadout | null;
  getAgentConfigDir: () => string;
  validateResumeTarget: (
    sessionPath: string,
    loadout: SubagentLoadout,
    agentDir: string,
    opts?: { anchored?: AnchoredSubagentLoadout | null; requireAnchored?: boolean },
  ) => string | null;
  countSessionEntryLines: typeof countSessionEntryLines;
  getSubagentActivityFile: typeof getSubagentActivityFile;
  createSurface: (name: string, options?: { cwd?: string; env?: Record<string, string> }) => string;
  shellEscape: (value: string) => string;
  subagentsDir: string;
  applySandboxToParts: (
    parts: string[],
    loadout: SubagentLoadout,
    options: { artifactDir: string; name: string },
    raw?: { escape?: (value: string) => string },
  ) => void;
  getShellReadyDelayMs: () => number;
  sendCommand: (surface: string, command: string) => void;
  closeSurface: (surface: string) => void;
  resolveResumeLaunchBehavior: () => { autoExit: boolean; interactive: boolean };
  runtimeRegistryPath: (artifactDir: string) => string;
  upsertRuntimeRecord: (path: string, record: Parameters<typeof import("./runtime-registry.ts").upsertRuntimeRecord>[1]) => void;
  removeRuntimeRecord: (path: string, id: string) => void;
  startWidgetRefresh: () => void;
  startStatusRefresh: (pi: ExtensionAPI) => void;
  watchSubagent: (running: RunningSubagent, signal: AbortSignal) => Promise<SubagentResult>;
  updateWidget: () => void;
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
      // 表面选择只算一次:resume 恒为自动任务(auto → headless),无复用器时
      // 仍可后台运行;仅当选中 pane 而 mux 不可用时才拒绝。
      const surfaceChoice = deps.resolveSurfaceChoice({});
      const choiceIsHeadless = "choice" in surfaceChoice && surfaceChoice.choice === "headless";
      if (!deps.isMuxAvailable() && !choiceIsHeadless) {
        return deps.muxUnavailableResult();
      }

      const runningMatch = Array.from(deps.runningSubagents.values())
        .find((running) => running.name === requestedName);
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
      if (deps.reservedNames.has(name)) {
        const error = `Subagent "${name}" is already being launched or resumed. Wait for that operation to finish.`;
        return { content: [{ type: "text" as const, text: error }], details: { error } };
      }
      const { autoExit, interactive } = deps.resolveResumeLaunchBehavior();
      const startTime = Date.now();
      const id = Math.random().toString(16).slice(2, 10);
      const sentinelToken = `__PI_SUBAGENT_DONE_${randomUUID()}__`;
      const parentArtifactDir = deps.getArtifactDir(
        ctx.sessionManager.getSessionDir(),
        ctx.sessionManager.getSessionId(),
      );
      const entry = deps.resolveNameInRegistry(parentArtifactDir, requestedName);
      if (!entry) {
        const known = Object.keys(deps.readNameRegistry(parentArtifactDir));
        const error =
          `No subagent named "${requestedName}" in this session. ` +
          (known.length > 0 ? `Known subagents: ${known.join(", ")}.` : "No subagents have been spawned in this session yet.");
        return { content: [{ type: "text" as const, text: error }], details: { error } };
      }

      const sessionPath = entry.sessionFile;
      if (!sessionPath || !existsSync(sessionPath)) {
        const error =
          `Subagent "${requestedName}" is registered but its session file is gone ` +
          `(${sessionPath}). It cannot be resumed. Spawn a fresh subagent instead.`;
        return { content: [{ type: "text" as const, text: error }], details: { error } };
      }

      for (const running of deps.runningSubagents.values()) {
        if (resolve(running.sessionFile) === resolve(sessionPath)) {
          return deps.handleSubagentSteer({ name: running.name, message: params.message });
        }
      }

      const loadout = deps.readSubagentLoadout(sessionPath);
      if (!loadout) {
        const error =
          `Cannot safely resume "${requestedName}": no sandbox snapshot found for this session ` +
          `(it predates sandboxed resume, or its .loadout.json sidecar was removed). ` +
          `Resuming would lose the original tool policy and could change the subagent's capabilities, so this is refused. ` +
          `Re-run the task as a fresh subagent instead.`;
        return { content: [{ type: "text" as const, text: error }], details: { error } };
      }

      // 锚定副本(父侧 artifactDir,子代理不可直接寻址):resume 授权的
      // 单一真源。新 spawn 的 registry 标记要求副本必须存在;只有旧
      // registry 条目才允许走 legacy 校验路径。
      const anchored = deps.readAnchoredLoadout(parentArtifactDir, sessionPath);
      const trustError = deps.validateResumeTarget(
        sessionPath,
        loadout,
        deps.getAgentConfigDir(),
        { anchored, requireAnchored: entry.anchored === true },
      );
      if (trustError) {
        const error = `Cannot safely resume "${requestedName}": ${trustError}`;
        return { content: [{ type: "text" as const, text: error }], details: { error } };
      }
      // 锚定副本是运行配置的单一真源(与 sidecar 已校验一致);只有旧快照
      // 或锚定写入失败的 registry 条目才会退回 sidecar 本身(legacy 授权,
      // containment 已按可信根校验)。Trust decisions live in Pi's global
      // agent directory; getAgentConfigDir() stays the trust root here regardless
      // of the loadout's agentDir.
      const effectiveLoadout: SubagentLoadout = anchored ?? loadout;
      const cohortId = normalizeCohortId(effectiveLoadout.cohortId ?? entry.cohortId);
      const cohortDetails = cohortId ? { cohortId } : {};
      const resumedSessionId = entry.sessionId ?? deps.getSessionId(sessionPath) ?? requestedName;
      const entryCountBefore = deps.countSessionEntryLines(sessionPath);
      const artifactDir = deps.getArtifactDir(
        ctx.sessionManager.getSessionDir(),
        ctx.sessionManager.getSessionId(),
      );
      const activityFile = deps.getSubagentActivityFile(artifactDir, id);
      mkdirSync(dirname(activityFile), { recursive: true });

      const resumeEnv: Record<string, string> = createSubagentLaunchEnv();
      const resumeAgentDir = effectiveLoadout.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? null;
      if (resumeAgentDir) resumeEnv.PI_CODING_AGENT_DIR = resumeAgentDir;
      if (effectiveLoadout.spawnable && effectiveLoadout.spawnable.length > 0) {
        resumeEnv.PI_SUBAGENT_ALLOWED = effectiveLoadout.spawnable.join(",");
      }
      if (effectiveLoadout.agent) resumeEnv.PI_SUBAGENT_AGENT = effectiveLoadout.agent;
      resumeEnv.PI_SUBAGENT_NAME = name;
      resumeEnv.PI_SUBAGENT_SESSION = sessionPath;
      resumeEnv.PI_SUBAGENT_ID = id;
      resumeEnv.PI_SUBAGENT_ACTIVITY_FILE = activityFile;
      if (autoExit) resumeEnv.PI_SUBAGENT_AUTO_EXIT = "1";
      // Resume is always an autonomous blocking operation; keep ask_question
      // checkpoint semantics aligned with initial launches so a resumed child
      // cannot park forever while this tool is awaiting its terminal result.
      if (!interactive) resumeEnv.PI_SUBAGENT_BARRIER = "1";

      deps.reservedNames.add(name);
      // resume 同样是依赖提供者:名字确定后、真正拉起进程前登记完成记录,
      // 下游 spawn 的 dependsOn 即可等待本次 resume 的终态。
      const ownRecord = announceCompletion(name, { interactive: false });
      // resume 复用既有 session 文件:清掉上一轮遗留的 .exit/.ask sidecar,
      // 避免旧错误/旧问题污染本次 resume(watcher 会把旧 .exit 当本次失败、
      // 旧 .ask 当新问题投递)。写入方用 tmp+rename,直接删除安全。
      try { rmSync(`${sessionPath}.exit`, { force: true }); } catch {}
      try { rmSync(`${sessionPath}.ask`, { force: true }); } catch {}
      let createdSurface: string | null = null;
      let child: HeadlessChild | null = null;
      try {
        // resume 默认走 headless(自动任务,auto → headless):独立 RPC 进程,
        // 不建 pane。surface=pane 或 headless 不可用时回退 pane 路径。
        const useHeadless = choiceIsHeadless;
        if (useHeadless) {
          // RPC argv:参数数组直传子进程,不经 shell 拼接;resume 消息经 stdin 投递。
          const rpcArgs = [
            "--mode",
            "rpc",
            "--session",
            sessionPath,
            "-e",
            join(deps.subagentsDir, "subagent-done.ts"),
          ];
          deps.applySandboxToParts(rpcArgs, effectiveLoadout, { artifactDir, name }, { escape: (value) => value });
          const resumePromptId = `resume-${id}`;
          let resumePromptPending = true;
          child = deps.spawnHeadlessPi(
            {
              args: rpcArgs,
              // New loadouts persist the exact child cwd. Fall back to the
              // parent session cwd for older snapshots instead of silently
              // resuming in the extension host's process.cwd().
              cwd: effectiveLoadout.cwd ?? ctx.cwd ?? process.cwd(),
              env: resumeEnv,
            },
            (event) => {
              if (
                resumePromptPending &&
                event.type === "response" &&
                event.command === "prompt" &&
                event.id === resumePromptId
              ) {
                resumePromptPending = false;
                if (event.success === false) {
                  child!.promptError = typeof event.error === "string" && event.error
                    ? event.error
                    : "resumed sub-agent rejected its prompt";
                }
              }
            },
          );
          if (child.pid == null) {
            child.kill();
            throw new Error("Failed to spawn headless resume process (check PI_SUBAGENT_PI_ENTRY / pi installation).");
          }
          createdSurface = formatHeadlessSurface(child.pid);
          child.send({ id: resumePromptId, type: "prompt", message });
        } else {
          const parts = ["pi", "--session", deps.shellEscape(sessionPath)];
          parts.push("-e", deps.shellEscape(join(deps.subagentsDir, "subagent-done.ts")));
          deps.applySandboxToParts(parts, effectiveLoadout, { artifactDir, name });

          if (params.message) {
            const msgTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
            const safeName = sanitizeSubagentFileName(name, "resume");
            const resumeMsgFile = join(artifactDir, "subagent-resume", `${safeName}-${msgTimestamp}.md`);
            mkdirSync(dirname(resumeMsgFile), { recursive: true });
            writeFileSync(resumeMsgFile, message, "utf8");
            parts.push(deps.shellEscape(`@${resumeMsgFile}`));
          }

          const command = `${parts.join(" ")}${sentinelSuffix(sentinelToken)}`;
          const surface = deps.createSurface(name, { cwd: effectiveLoadout.cwd ?? undefined, env: resumeEnv });
          createdSurface = surface;
          await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, deps.getShellReadyDelayMs()));
          deps.sendCommand(surface, command);
        }

        const running: RunningSubagent = {
          id,
          name,
          task: message,
          ...(cohortId ? { cohortId } : {}),
          // resume 使用 loadout 里的具体 model(tier 已在首次 launch 时解析),
          // 不重新读配置,不随配置改变漂移。
          model: effectiveLoadout.model ?? null,
          parentId: process.env.PI_SUBAGENT_ID ?? null,
          ...(params.timeoutMs != null ? { timeoutMs: params.timeoutMs } : {}),
          waitMode: "hard-barrier",
          surface: createdSurface as string,
          startTime,
          sessionFile: sessionPath,
          activityFile,
          interactive,
          sentinelToken,
          runtimeFile: deps.runtimeRegistryPath(artifactDir),
          statusState: createStatusState({ source: "pi", startTimeMs: startTime }),
          kind: useHeadless ? "headless" : "pane",
          ...(child && child.pid != null ? { pid: child.pid, headlessChild: child } : {}),
        };
        deps.runningSubagents.set(id, running);
        try {
          deps.upsertRuntimeRecord(running.runtimeFile, createRuntimeRecord(running));
        } catch (error) {
          debugLog(`Could not persist resumed runtime record for ${name}`, error);
        }
        deps.startWidgetRefresh();
        deps.startStatusRefresh(pi);
        const watcherAbort = new AbortController();
        running.abortController = watcherAbort;

        // resume 默认是自动子代理(resolveResumeLaunchBehavior 恒为 interactive: false):
        // 硬等待终态,真实结果作为 tool result 返回;与 spawn 的硬屏障同语义,
        // pi 的 sibling 并行执行保证同 turn 内多个 spawn/resume 全部落定后 turn 才继续。
        // 若未来引入交互式 resume(interactive: true),保持异步立即返回 + steer 回注。
        //
        // 中止语义与 spawn 一致(Escape ≠ 取消):宿主中止等待不转发到 watcher,
        // 子代理继续运行,本调用返回 detached 非终态;真实结果由 watcher 终态
        // 时迟到回注一次(resume 无 retention,不清理工件)。
        if (!running.interactive) {
          const watchPromise = deps.watchSubagent(running, watcherAbort.signal);
          running.watchPromise = watchPromise;
          // 三向竞速(watcher 终态 / Escape / 可选 timeoutMs)与 spawn 的硬屏障
          // 同源:等待解除只影响本调用,resumed 子代理继续运行,迟到回注一次。
          const raced = await waitForSubagentTerminal({ watchPromise, running, signal, timeoutMs: params.timeoutMs ?? undefined });
          if (typeof raced === "object" && "kind" in raced) {
            const released: WaitRelease = raced;
            running.waitReleased = released.kind;
            markRuntimeWaitReleased(running.runtimeFile, running.id, released.kind);
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
                  : routeExceptionFromResult(finalResult, effectiveLoadout.model);
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
            deps.reservedNames.delete(name);
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
                  id,
                  name,
                  ...cohortDetails,
                  sessionId: resumedSessionId,
                  sessionFile: sessionPath,
                  elapsed: Math.floor((Date.now() - startTime) / 1000),
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
                id,
                name,
                ...cohortDetails,
                sessionId: resumedSessionId,
                sessionFile: sessionPath,
                elapsed: Math.floor((Date.now() - startTime) / 1000),
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
            deps.reservedNames.delete(name);
            return {
              content: [{
                type: "text",
                text:
                  `Resume of "${name}" was handed off to recovery because the host was reloaded (/reload). ` +
                  `The resumed sub-agent is still running; its real result will be delivered as a steer message ` +
                  `when it finishes. Do not treat this as a failure.`,
              }],
              details: {
                id,
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
          const cancelled = watcherAbort.signal.aborted || userClosed || !!watcherResult.stopped;
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
            : routeExceptionFromResult(finalResult, effectiveLoadout.model);
          // 终态落定完成记录:取消(含用户关闭 pane)兑 cancelled,失败/成功
          // 按结果映射,摘要用 extract 后的真实回复文本。
          settleCompletionFromResult(name, finalResult, {
            ...(cancelled ? { status: "cancelled" as const } : {}),
          });
          deps.reservedNames.delete(name);
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
              id,
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

        const interactiveWatch = deps.watchSubagent(running, watcherAbort.signal);
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
            const routeException = routeExceptionFromResult(finalResult, effectiveLoadout.model);
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

        deps.reservedNames.delete(name);
        return {
          content: [{ type: "text", text: `Session "${name}" resumed.` }],
          details: {
            id,
            name,
            ...cohortDetails,
            sessionId: resumedSessionId,
            sessionFile: sessionPath,
            status: "started",
          },
        };
      } catch (error) {
        // resume 启动失败也必须释放完成记录:等待者拿到明确失败,不永久挂起。
        settleCompletionFromResult(name, {
          exitCode: 1,
          errorMessage: error instanceof Error ? error.message : String(error),
        }, { source: "launch-failure" });
        deps.reservedNames.delete(name);
        if (deps.runningSubagents.get(id)?.surface === createdSurface) {
          deps.runningSubagents.delete(id);
        }
        deps.removeRuntimeRecord(deps.runtimeRegistryPath(artifactDir), id);
        if (child) {
          try { child.kill(); } catch (closeError) {
            debugLog(`Could not kill failed resume child ${createdSurface}`, closeError);
          }
        } else if (createdSurface) {
          try { deps.closeSurface(createdSurface); } catch (closeError) {
            debugLog(`Could not close failed resume pane ${createdSurface}`, closeError);
          }
        }
        throw error;
      }
    },
  });
}
