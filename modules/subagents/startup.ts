// 启动事务：子代理启动的唯一入口，覆盖三种模式。
//
//   fresh   首启（subagent 工具的 spawn 流程）：校验入参与解析运行类别/表面
//           （planSpawn），再拼装环境与 argv、启动进程、登记、启动 watcher
//           （spawn）。
//   resume  恢复（subagent_message 工具）：校验会话与授权（planResume），再
//           清理旧 sidecar、拼装环境与 argv、启动进程、登记、启动 watcher
//           （resume）。
//   recover 重连（宿主重载后的 session_start）：按磁盘运行记录重建运行态，
//           仍在运行的记录登记后挂 watcher；已退出的记录只回报结果来源，
//           提取与回注归调用方（结果提取与呈现是非启动职责）。
//
// 三模式共用的规则：
//   - 按运行类别（常驻成员 / 交互式 / 硬屏障）选择 watcher：member →
//     watchMemberRound，其余 → watchSubagent（watchSubagent 内部再按 kind
//     分 pane/headless）；waitMode 与 watcher 选择同源，不会漂移。
//   - 登记表写入（registry.add / track）与 abort 控制器、UI 刷新同段完成，
//     调用方拿到的一定是已登记且 watcher 已在跑的 StartedRun。
//   - 启动失败自清理：进程/表面、运行态与磁盘记录都由本模块回滚，调用方只
//     负责完成记录（依赖注册表）与名字保留的释放。
//
// 恢复会话的校验（锚定 loadout、会话文件、目标合法性）与清理动作（旧退出
// 标记、旧询问标记）与旧实现逐条一致；validateResumeTarget 一并搬入本模块。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { dirname, join, resolve, sep } from "node:path";
import { existsSync, mkdirSync, statSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  closeSurface,
  createSurface,
  readExitSidecar,
  sentinelSuffix,
  sendCommand,
  shellEscape,
} from "./surface.ts";
import {
  createSubagentLaunchEnv,
  formatHeadlessSurface,
  parseHeadlessSurface,
  spawnHeadlessPi,
  type HeadlessChild,
} from "./headless.ts";
import {
  countSessionEntryLines,
  diffSubagentLoadouts,
  getSessionId,
  readAnchoredLoadout,
  readNameRegistry,
  readSubagentLoadout,
  resolveNameInRegistry,
  seedSubagentSessionFile,
  writeAnchoredLoadout,
  writeSubagentLoadout,
  SUBAGENT_LOADOUT_VERSION,
  type AnchoredSubagentLoadout,
  type SubagentLoadout,
} from "./session.ts";
import {
  buildPiPromptArgs,
  buildSubagentToolAllowlist,
  getDefaultSessionDirFor,
  resolveEffectiveAutoExit,
  resolveEffectiveInteractive,
  resolveLaunchBehavior,
  resolveSubagentPaths,
  resolveSurfaceChoice,
  validateAgentLifecycleConfig,
} from "./launch-config.ts";
import { loadTierRouteConfig, normalizeTier, resolveTierForParams, type ModelTier, type TierRouteInjectedSource } from "./routing.ts";
import { getSubagentActivityFile } from "./activity.ts";
import { createStatusState } from "./status.ts";
import { normalizeSubagentName, sanitizeSubagentFileName } from "./names.ts";
import { normalizeCohortId, validateCohortId, type SubagentParams } from "./params.ts";
import { buildTeamRoundPrompt, findRosterMember, rosterPath, upsertRosterMember } from "./team.ts";
import type { RuntimeRecord, RuntimeRegistry } from "./registry.ts";
import type { RunningSubagent, SubagentResult } from "./types.ts";
import type { AgentDefaults } from "./agents.ts";
import { debugLog } from "./diagnostics.ts";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** timeoutMs 参数校验(信任边界:模型传参);返回错误文案或 null。 */
export function validateTimeoutMs(timeoutMs: unknown): string | null {
  if (timeoutMs == null) return null;
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 1000) {
    return `Invalid timeoutMs: must be an integer >= 1000 (milliseconds); got ${String(timeoutMs)}.`;
  }
  return null;
}

/** resume 的上下文（不需要父会话文件：目标会话由名字注册表解析）。 */
export interface ResumeContext {
  sessionManager: { getSessionId(): string; getSessionDir(): string };
  cwd?: string;
}

export interface SpawnContext {
  sessionManager: {
    getSessionFile(): string | null | undefined;
    getSessionId(): string;
    getSessionDir(): string;
  };
  cwd: string;
}

/** 启动后的句柄：已登记的运行态 + 已按运行类别启动的 watcher。 */
export interface StartedRun {
  running: RunningSubagent;
  /** watcher 的终止信号（与 running.abortController.signal 同一个）。 */
  signal: AbortSignal;
  /** 选中的 watcher；常驻成员的轮次 watcher 兑 void。 */
  watch: Promise<SubagentResult | void>;
}

/** resume 的等待与提取元数据（硬屏障终止路径需要）。 */
export interface ResumeStartedRun extends StartedRun {
  resumedSessionId: string;
  entryCountBefore: number;
}

/**
 * fresh 首启的第一阶段产物：校验已完成、运行类别与表面已解析。
 * 工具在拿到 plan 与 spawn 之间写回名字；plan.params 保持同一引用，
 * 因此启动时看到的是规范化后的 name / task。
 */
export interface SpawnPlan {
  params: typeof SubagentParams.static;
  cohortId: string | null;
  agentDefs: AgentDefaults | null;
  effectiveCwd: string | null;
  localAgentDir: string | null;
  effectiveAgentDir: string;
  targetCwdForSession: string;
  effectiveModel: string | null;
  effectiveTools: string | undefined;
  effectiveSkills: string | undefined;
  effectiveThinking: string | undefined;
  tier: ModelTier | null;
  effectiveAutoExit: boolean;
  /** 运行类别（启动与 watcher 选择的唯一依据）。 */
  interactive: boolean;
  member: boolean;
  useHeadless: boolean;
  sessionFile: string;
  sessionId: string;
  artifactDir: string;
  sessionDir: string;
  launchBehavior: ReturnType<typeof resolveLaunchBehavior>;
}

/** resume 的第一阶段产物：会话、授权与批次基线已校验。 */
export interface ResumePlan {
  name: string;
  message: string;
  timeoutMs?: number;
  sessionPath: string;
  resumedSessionId: string;
  entryCountBefore: number;
  effectiveLoadout: SubagentLoadout;
  cohortId: string | null;
  artifactDir: string;
}

export type PlanOutcome<T> =
  | { kind: "plan"; plan: T }
  | {
      kind: "error";
      error: string;
      /** 工具结果 details 的自定义覆盖（如 self-spawn 的分类码）。 */
      details?: Record<string, unknown>;
      /** 表面需要复用器而不可用：调用方呈现宿主给的 mux 提示。 */
      muxUnavailable?: boolean;
    };

/** resume 的规划结果：命中运行中的同会话子代理时交给调用方 steer。 */
export type ResumePlanOutcome = PlanOutcome<ResumePlan> | { kind: "steer"; name: string };

/** recover 的逐条结果：仍在跑的已登记挂 watcher，退出的交给调用方回注。 */
export type RecoveredRun =
  | { kind: "running"; recovered: "headless-degraded" | "pane"; run: StartedRun }
  | { kind: "exited"; record: RuntimeRecord; exit: { exitCode: number; errorMessage?: string } }
  | { kind: "member-offline"; name: string; reason: string };

/**
 * 启动模块的进程外依赖：宿主注入的配置读取与进程/表面替身。
 * 常驻成员与交互式的判别、argv/env 拼装都在模块内部完成，这里只收原语。
 */
export interface SubagentStartupDeps {
  registry: RuntimeRegistry;
  /** 宿主信任根（PI_CODING_AGENT_DIR 或 ~/.pi/agent）。 */
  getAgentConfigDir: () => string;
  /** agent profile 读取（含宿主注入的 pi-toolkit 配置链）。 */
  loadAgentDefaults: (agentName: string) => AgentDefaults | null;
  /** 宿主注入的 tier 层（不在宿主里声明 models 时不产生候选层）。 */
  resolveHostTierSources: () => TierRouteInjectedSource[];
  getArtifactDir: (sessionDir: string, sessionId: string) => string;
  /** 复用器可用性：pane 表面的前置条件（测试注入假表面层）。 */
  isMuxAvailable: () => boolean;
  /** 重连时接管既有 pane；无复用器环境返回 false（测试注入假表面层）。 */
  adoptSurface: (surface: string) => boolean;
  /** headless 进程存活探测（测试注入假进程表）。 */
  isPidAlive: (pid: number) => boolean;
  /** 终止 headless 进程树（测试注入假进程表，避免真实杀进程）。 */
  terminateHeadlessProcess: (pid: number) => void;
  /** resume 的信任校验（schema、containment、锚定副本交叉校验）。 */
  validateResumeTarget: (
    sessionPath: string,
    loadout: SubagentLoadout,
    agentDir: string,
    opts?: { anchored?: AnchoredSubagentLoadout | null; requireAnchored?: boolean },
  ) => string | null;
  /** loadout → argv 的沙箱应用（模型、身份、工具策略）。 */
  applySandboxToParts: (
    parts: string[],
    loadout: SubagentLoadout,
    options: { artifactDir: string; name: string },
    raw?: { escape?: (value: string) => string },
  ) => string[];
  /** resume 的启动行为（当前恒为 autoExit + 非交互）。 */
  resolveResumeLaunchBehavior: () => { autoExit: boolean; interactive: boolean };
  /** 本模块目录（`-e subagent-done.ts` 的定位根）。 */
  subagentsDir: string;
  /** headless 首轮 prompt 组装（技能展开需要宿主命令表，由宿主注入）。 */
  buildHeadlessPrompt: (effectiveSkills: string | undefined, task: string) => string;
  /** 新建 pane 后的 shell 就绪等待。 */
  getShellReadyDelayMs: () => number;
  /** headless 进程替身（测试注入内存实现）。 */
  spawnHeadlessPi: typeof spawnHeadlessPi;
  /** 表面层替身（测试注入内存实现）。 */
  createSurface: typeof createSurface;
  sendCommand: typeof sendCommand;
  closeSurface: typeof closeSurface;
  /** 登记后的刷新与按运行类别选择的 watcher。 */
  startWidgetRefresh: () => void;
  startStatusRefresh: (pi: ExtensionAPI) => void;
  watchSubagent: (running: RunningSubagent, signal: AbortSignal) => Promise<SubagentResult>;
  watchMemberRound: (running: RunningSubagent, signal: AbortSignal) => void | Promise<void>;
}

export interface SubagentStartup {
  /** fresh 第一阶段：校验入参与运行类别，产出启动计划（不启动进程）。 */
  planSpawn(params: typeof SubagentParams.static, ctx: SpawnContext): PlanOutcome<SpawnPlan>;
  /** fresh 第二阶段：拼装环境与 argv、启动进程、登记、启动 watcher。 */
  spawn(
    plan: SpawnPlan,
    ctx: SpawnContext,
    pi: ExtensionAPI,
    options?: { surface?: string },
  ): Promise<StartedRun>;
  /** resume 第一阶段：校验会话与授权，产出恢复计划（不启动进程）。 */
  planResume(request: { name: string; message: string; timeoutMs?: number }, ctx: ResumeContext): ResumePlanOutcome;
  /** resume 第二阶段：清理旧标记、启动进程、登记、启动 watcher。 */
  resume(plan: ResumePlan, ctx: ResumeContext, pi: ExtensionAPI): Promise<ResumeStartedRun>;
  /** 重连：宿主重载后按磁盘运行记录重建（进程启动不在这里）。 */
  recover(
    ctx: { sessionManager: { getSessionId(): string; getSessionDir(): string } },
    pi: ExtensionAPI,
  ): Promise<RecoveredRun[]>;
}

/**
 * resume 路径的信任校验:registry 与 .loadout.json 都是磁盘文件,可能被篡改
 * (子代理进程可写自己 session 目录下的 sidecar)。恢复前强制验证:
 *   1. loadout 字段合法(枚举值/类型),agentDir 存在且为目录;
 *   2. session containment 只锚定父侧可信根,绝不由 loadout.agentDir 自己
 *      决定:新快照(有锚定副本)要求 session 路径与锚定副本记录的
 *      sessionFile 精确匹配;旧快照(无锚定副本,兼容路径)固定用宿主
 *      agentDir(getAgentConfigDir,宿主环境可信)的 sessions 根,外加按
 *      spawn 时的推导规则从 loadout.cwd 重新推导出的项目本地
 *      .pi/agent sessions 根——除此之外的 agentDir 不再作为 containment 根;
 *   3. 锚定副本存在时,session sidecar 必须与它逐字段一致(只收窄不放宽:
 *      任何安全字段被改动都拒绝 resume,而不是静默接受更宽的授权)。
 * 诚实边界:同用户恶意进程可同时改写两份副本,这里不做绝对隔离承诺;
 * 目标是堵死“只改 session sidecar 即可扩权”的路径,并让篡改可检测。
 */
export function validateResumeTarget(
  sessionPath: string,
  loadout: SubagentLoadout,
  agentDir: string,
  opts?: { anchored?: AnchoredSubagentLoadout | null; requireAnchored?: boolean },
): string | null {
  const anchored = opts?.anchored ?? null;
  const snapshotVersion = loadout.snapshotVersion;
  if (
    snapshotVersion !== undefined &&
    (typeof snapshotVersion !== "number" ||
      !Number.isInteger(snapshotVersion) ||
      snapshotVersion !== SUBAGENT_LOADOUT_VERSION)
  ) {
    return `unsupported loadout snapshot version: ${String(snapshotVersion)}`;
  }
  // 新版快照自身携带强制锚定标记;即使 registry 的 anchored 字段被删除,
  // 也不能把新快照静默降级为 legacy 校验。
  const requiresAnchored = opts?.requireAnchored === true || snapshotVersion === SUBAGENT_LOADOUT_VERSION;
  if (requiresAnchored && !anchored) {
    return "parent-anchored loadout snapshot is missing or unreadable; refusing to fall back to legacy resume validation";
  }
  const resolvedSession = resolve(sessionPath);
  // 先校验会参与路径推导的字段,避免恶意快照用非字符串触发 resolve
  // 异常并绕过后续的结构化拒绝。
  if (loadout.agentDir !== undefined && loadout.agentDir !== null && typeof loadout.agentDir !== "string") {
    return "loadout agentDir must be a string or null";
  }
  if (loadout.cwd !== undefined && loadout.cwd !== null && typeof loadout.cwd !== "string") {
    return "loadout cwd must be a string or null";
  }
  if (anchored) {
    // 锚定副本精确匹配:父进程自己登记过这个路径,containment 即成立。
    if (resolve(anchored.sessionFile) !== resolvedSession) {
      return `session path does not match the parent-anchored snapshot: ${sessionPath} (anchored: ${anchored.sessionFile})`;
    }
  } else {
    // 旧快照兼容:containment 根固定为宿主 agentDir 的 sessions 根;项目
    // 本地 .pi/agent 只有在能从 loadout.cwd 按 spawn 推导规则复算出同一
    // agentDir 时才可作为根(localAgentDir = <cwd>/.pi/agent,存在才生效)。
    // loadout.agentDir 本身不再单独决定 containment 根,只作被校验后的
    // 运行配置。
    const trustedRoots = [resolve(join(agentDir, "sessions"))];
    if (loadout.cwd && loadout.agentDir) {
      const derivedLocal = join(resolve(loadout.cwd), ".pi", "agent");
      if (resolve(loadout.agentDir) === derivedLocal) {
        trustedRoots.push(resolve(join(derivedLocal, "sessions")));
      }
    }
    if (!trustedRoots.some((root) => resolvedSession.startsWith(root + sep))) {
      return `session file escapes the sessions directory: ${sessionPath}`;
    }
  }
  if (!resolvedSession.endsWith(".jsonl") || !existsSync(resolvedSession)) {
    return `session file missing or not a .jsonl session: ${sessionPath}`;
  }
  // 锚定副本交叉校验优先于字段存在性检查:篡改场景应报告“被改动”而不是
  // 改动后的字段自身的次要错误。
  if (anchored) {
    const diff = diffSubagentLoadouts(anchored, loadout);
    if (diff.length > 0) {
      return (
        `loadout snapshot was modified after spawn (fields: ${diff.join(", ")}); ` +
        `refusing to resume with an altered authorization. ` +
        `Re-run the task as a fresh subagent instead.`
      );
    }
  }
  if (loadout.agentDir) {
    const ad = resolve(loadout.agentDir);
    try {
      if (!statSync(ad).isDirectory()) return `loadout agentDir is not a directory: ${loadout.agentDir}`;
    } catch {
      return `loadout agentDir does not exist: ${loadout.agentDir}`;
    }
  }
  if (loadout.thinking != null && !THINKING_LEVELS.has(loadout.thinking)) {
    return `loadout thinking level invalid: ${loadout.thinking}`;
  }
  if (loadout.thinkingOverride != null && !THINKING_LEVELS.has(loadout.thinkingOverride)) {
    return `loadout thinkingOverride invalid: ${loadout.thinkingOverride}`;
  }
  if (
    loadout.systemPromptMode != null &&
    loadout.systemPromptMode !== "append" &&
    loadout.systemPromptMode !== "replace"
  ) {
    return `loadout systemPromptMode invalid: ${loadout.systemPromptMode}`;
  }
  if (loadout.toolAllowlist !== undefined && loadout.toolAllowlist !== null && typeof loadout.toolAllowlist !== "string") {
    return "loadout toolAllowlist must be a string or null";
  }
  if (loadout.model !== undefined && loadout.model !== null && typeof loadout.model !== "string") {
    return "loadout model must be a string or null";
  }
  if (loadout.tier != null && (typeof loadout.tier !== "string" || normalizeTier(loadout.tier) === null)) {
    return `loadout tier invalid: ${loadout.tier}`;
  }
  if (loadout.cohortId != null) {
    const cohortError = validateCohortId(loadout.cohortId);
    if (cohortError) return `loadout cohortId invalid: ${cohortError}`;
  }
  if (loadout.agent !== undefined && loadout.agent !== null && typeof loadout.agent !== "string") {
    return "loadout agent must be a string or null";
  }
  if (loadout.identity !== undefined && loadout.identity !== null && typeof loadout.identity !== "string") {
    return "loadout identity must be a string or null";
  }
  if (loadout.spawnable != null && (!Array.isArray(loadout.spawnable) || loadout.spawnable.some((item) => typeof item !== "string"))) {
    return "loadout spawnable must be an array of agent names or null";
  }
  if (loadout.autoExit !== undefined && typeof loadout.autoExit !== "boolean") {
    return "loadout autoExit must be a boolean";
  }
  return null;
}

export function createSubagentStartup(deps: SubagentStartupDeps): SubagentStartup {
  /** 按运行类别选择 watcher：成员轮 / 其余（watchSubagent 内部再分 pane/headless）。
   *  pi 传入时同段启动状态刷新（工具路径；recover 在循环后统一启动）。 */
  function startWatcher(running: RunningSubagent, pi?: ExtensionAPI): StartedRun {
    const watcherAbort = new AbortController();
    running.abortController = watcherAbort;
    deps.startWidgetRefresh();
    if (pi) deps.startStatusRefresh(pi);
    const watch = running.member
      ? Promise.resolve(deps.watchMemberRound(running, watcherAbort.signal))
      : deps.watchSubagent(running, watcherAbort.signal);
    return { running, signal: watcherAbort.signal, watch };
  }

  function planSpawn(
    params: typeof SubagentParams.static,
    ctx: SpawnContext,
  ): PlanOutcome<SpawnPlan> {
    const cohortError = validateCohortId(params.cohortId);
    if (cohortError) return { kind: "error", error: cohortError };
    const cohortId = normalizeCohortId(params.cohortId);
    if (cohortId) params.cohortId = cohortId;
    else delete params.cohortId;

    const currentAgent = process.env.PI_SUBAGENT_AGENT;
    if (params.agent && currentAgent && params.agent === currentAgent) {
      return {
        kind: "error",
        error:
          `You are the ${currentAgent} agent — do not start another ${currentAgent}. ` +
          `You were spawned to do this work yourself. Complete the task directly.`,
        details: { error: "self-spawn blocked" },
      };
    }

    const agentDefs = params.agent ? deps.loadAgentDefaults(params.agent) : null;
    // Resolve the target before tier lookup so a project-local
    // .pi/agent/pi-subagents.json is honored when the caller selected a
    // different cwd. The concrete model is then captured in the loadout below,
    // so resume does not drift if the tier configuration changes later.
    const { effectiveCwd, localAgentDir, effectiveAgentDir } = resolveSubagentPaths(
      params,
      agentDefs,
      deps.getAgentConfigDir,
    );
    const targetCwdForSession = effectiveCwd ?? ctx.cwd;

    // tier 解析先于 loadout 写入:显式 params.model 优先 tier;tier 无法归一化
    // 或缺映射时直接拒绝启动,绝不静默换模型。loadout.model 存具体模型,
    // tier 仅作记录,resume 不随配置漂移。
    const tierResolution = resolveTierForParams(params, () =>
      loadTierRouteConfig({
        cwd: targetCwdForSession,
        agentConfigDir: effectiveAgentDir,
        injected: deps.resolveHostTierSources(),
      }));
    if ("error" in tierResolution) return { kind: "error", error: tierResolution.error };
    const effectiveModel = params.model ?? tierResolution.model ?? agentDefs?.model;
    const effectiveThinking = params.thinking ?? agentDefs?.thinking;
    if (effectiveThinking != null && !THINKING_LEVELS.has(effectiveThinking)) {
      return {
        kind: "error",
        error: `Invalid thinking level "${effectiveThinking}". Use: ${[...THINKING_LEVELS].join(", ")}.`,
      };
    }
    const lifecycleError = validateAgentLifecycleConfig(agentDefs);
    if (lifecycleError) return { kind: "error", error: lifecycleError };
    const timeoutError = validateTimeoutMs(params.timeoutMs);
    if (timeoutError) return { kind: "error", error: timeoutError };
    const effectiveInteractive = resolveEffectiveInteractive(params, agentDefs);
    const effectiveAutoExit = resolveEffectiveAutoExit(agentDefs);
    // 持久团队成员(member):常驻 headless 进程,不走 auto-exit/barrier。
    // 工具层已拒绝 pane/interactive/discard/timeoutMs/dependsOn 组合;这里
    // 强制 headless 表面,不改变非 member 的任何默认行为。
    const memberMode = params.member === true;

    // timeoutMs 适用性检查(在创建任何 pane/进程之前):交互式(演示)spawn
    // 立即返回、没有可设上限的等待,显式拒绝而不是静默忽略。
    if (params.timeoutMs != null && effectiveInteractive) {
      return {
        kind: "error",
        error:
          `timeoutMs does not apply to interactive (demo) sub-agents: their spawn returns immediately and ` +
          `there is no blocking wait to bound. Drop timeoutMs for this spawn.`,
      };
    }
    // ── 持久团队成员(member)约束(全部在创建任何进程之前拒绝)──
    // member 是独立生命周期,与硬屏障/依赖/保留策略/超时/pane 语义互斥;
    // 显式拒绝而非静默降级,不偷偷改变现有自动任务与演示 pane 的默认行为。
    if (memberMode) {
      const violations: string[] = [];
      if (params.surface === "pane") violations.push('surface "pane" (members are headless-only)');
      if (effectiveInteractive) violations.push("interactive (demo) agents cannot be members");
      if (params.retention === "discard") violations.push('retention "discard" (member sessions are always preserved)');
      if (params.timeoutMs != null) violations.push("timeoutMs (members are non-blocking; there is no wait to bound)");
      if (params.dependsOn?.length) violations.push("dependsOn (members have no process-level terminal state to wait for)");
      if (violations.length > 0) {
        const error =
          `member: true cannot be combined with: ${violations.join("; ")}. ` +
          `Drop the conflicting options or spawn a regular one-shot sub-agent instead.`;
        return { kind: "error", error, details: { error, violations } };
      }
    }

    // 表面选择:pane(现有 herdr/tmux 路径)或 headless(独立后台 pi 进程)。
    // interactive 请求 background 在此直接报错,不静默建 pane。
    const surfaceChoice = resolveSurfaceChoice(
      memberMode ? "background" : params.surface,
      memberMode ? false : effectiveInteractive,
    );
    if ("error" in surfaceChoice) return { kind: "error", error: surfaceChoice.error };
    const useHeadless = surfaceChoice.choice === "headless";
    // 仅 pane 需要复用器；headless 在无 herdr/tmux 的环境也能运行。拒绝理由由
    // 调用方呈现（宿主给的 mux 安装提示）。
    if (!useHeadless && !deps.isMuxAvailable()) {
      return {
        kind: "error",
        error: "Sub-agents in a visible pane require herdr or tmux.",
        muxUnavailable: true,
      };
    }

    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) {
      return {
        kind: "error",
        error: "Error: no session file. Start pi with a persistent session to use subagents.",
        details: { error: "no session file" },
      };
    }
    const sessionId = ctx.sessionManager.getSessionId();
    const artifactDir = deps.getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId);

    // fork 模式拦截必须先于 createSurface/spawnHeadless(否则被拒绝的 spawn 会
    // 泄漏 pane 或进程)。fork 的任务文本直传 argv,在 Windows pane 的
    // PowerShell 引号规则下无法安全转义,pane 表面不支持;standalone/
    // lineage-only 的任务走 @artifact 文件,不受影响。
    const launchBehavior = resolveLaunchBehavior(params, agentDefs);
    if (launchBehavior.inheritsConversationContext) {
      return {
        kind: "error",
        error: 'session-mode: fork is not supported by this extension. Use "standalone" or "lineage-only".',
      };
    }

    const sessionDir = getDefaultSessionDirFor(targetCwdForSession, effectiveAgentDir);

    return {
      kind: "plan",
      plan: {
        params,
        cohortId: cohortId ?? null,
        agentDefs,
        effectiveCwd,
        localAgentDir,
        effectiveAgentDir,
        targetCwdForSession,
        effectiveModel: effectiveModel ?? null,
        effectiveTools: agentDefs?.tools,
        effectiveSkills: agentDefs?.skills,
        effectiveThinking,
        tier: tierResolution.tier,
        effectiveAutoExit,
        interactive: effectiveInteractive,
        member: memberMode,
        useHeadless,
        sessionFile,
        sessionId,
        artifactDir,
        sessionDir,
        launchBehavior,
      },
    };
  }

  async function spawn(
    plan: SpawnPlan,
    ctx: SpawnContext,
    pi: ExtensionAPI,
    options?: { surface?: string },
  ): Promise<StartedRun> {
    const {
      params,
      cohortId,
      agentDefs,
      effectiveCwd,
      localAgentDir,
      targetCwdForSession,
      effectiveModel,
      effectiveTools,
      effectiveSkills,
      effectiveAutoExit,
      interactive: effectiveInteractive,
      member: memberMode,
      useHeadless,
      artifactDir,
      sessionDir,
      launchBehavior,
    } = plan;
    const startTime = Date.now();
    const id = Math.random().toString(16).slice(2, 10);
    const sentinelToken = `__PI_SUBAGENT_DONE_${randomUUID()}__`;

    // Generate a deterministic session file path for this subagent.
    // This eliminates race conditions when multiple agents launch simultaneously —
    // each agent knows exactly which file is theirs.
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23) + "Z";
    const uuid = [
      id,
      Math.random().toString(16).slice(2, 10),
      Math.random().toString(16).slice(2, 10),
      Math.random().toString(16).slice(2, 6),
    ].join("-");
    const subagentSessionFile = join(sessionDir, `${timestamp}_${uuid}.jsonl`);
    const sessionFile = plan.sessionFile;

    // Use pre-created surface (parallel mode) or create a new one.
    // For new surfaces, pause briefly so the shell is ready before sending the command.
    const surfacePreCreated = !!options?.surface;
    // 与 steer/resume 的寻址规则一致:入口处统一 normalize,保证 pane、widget、
    // registry 与运行态 map 里的名称同源(幂等,已干净的名称不变)。
    const surfaceName = normalizeSubagentName(params.name ?? params.agent ?? "subagent");
    const activityFile = getSubagentActivityFile(artifactDir, id);
    mkdirSync(dirname(activityFile), { recursive: true });
    // An agent with a non-empty subagent_agents list is granted the spawning
    // toolset and may only spawn the listed agents (enforced via PI_SUBAGENT_ALLOWED).
    const grantSpawning = !!(agentDefs?.subagentAgents && agentDefs.subagentAgents.length > 0);
    // Resolve the config dir the child sees: a target-local .pi/agent/ wins,
    // else the propagated global dir. Captured once so the launch env and the
    // resume snapshot agree.
    const resolvedAgentDir =
      localAgentDir && existsSync(localAgentDir)
        ? localAgentDir
        : process.env.PI_CODING_AGENT_DIR ?? null;
    // herdr 版:环境变量在 split 时注入(pane split --env),因此 splitEnv 的构造
    // 必须在 createSurface 之前;pane id 相关变量不再注入(子进程自带 HERDR_PANE_ID)。
    const splitEnv: Record<string, string> = createSubagentLaunchEnv();
    if (resolvedAgentDir) {
      splitEnv.PI_CODING_AGENT_DIR = resolvedAgentDir;
    }
    if (grantSpawning && agentDefs?.subagentAgents) {
      splitEnv.PI_SUBAGENT_ALLOWED = agentDefs.subagentAgents.join(",");
    }
    splitEnv.PI_SUBAGENT_NAME = surfaceName;
    if (params.agent) {
      splitEnv.PI_SUBAGENT_AGENT = params.agent;
    }
    if (effectiveAutoExit && !memberMode) {
      splitEnv.PI_SUBAGENT_AUTO_EXIT = "1";
    }
    // Automatic subagent tool calls are hard barriers. If such a child needs
    // input, subagent-done converts ask_question into a durable checkpoint and
    // exits so the parent can resume it; leaving the old live-parking behavior
    // here would deadlock the blocking tool call.
    // member 例外:无 barrier——ask_question 保持可回复的实时等待(成员常驻,
    // 父侧 watcher 轮询 .ask 并即时投递)。
    if (!effectiveInteractive && !memberMode) {
      splitEnv.PI_SUBAGENT_BARRIER = "1";
    }
    if (memberMode) {
      // 成员身份与团队协议目录:team_send 只写 mailbox,roster 父侧独写。
      splitEnv.PI_SUBAGENT_MEMBER = "1";
      splitEnv.PI_SUBAGENT_TEAM_DIR = artifactDir;
      if (agentDefs?.peerSend?.length) {
        splitEnv.PI_SUBAGENT_PEER_SEND = agentDefs.peerSend.join(",");
      }
    }
    splitEnv.PI_SUBAGENT_SESSION = subagentSessionFile;
    splitEnv.PI_SUBAGENT_ID = id;
    splitEnv.PI_SUBAGENT_ACTIVITY_FILE = activityFile;
    if (launchBehavior.seededSessionMode) {
      seedSubagentSessionFile({
        mode: launchBehavior.seededSessionMode,
        parentSessionFile: sessionFile,
        childSessionFile: subagentSessionFile,
        childCwd: targetCwdForSession,
      });
    }

    const { inheritsConversationContext } = launchBehavior;

    // Build the task message
    // Only full-context fork mode inherits prior conversation state.
    // Blank-session modes need the wrapper instructions and artifact-backed handoff.
    const modeHint = memberMode
      ? "You are a PERSISTENT TEAM MEMBER running your CURRENT round. Complete this round autonomously, then simply stop — your process stays alive for the next dispatched round (never call shutdown yourself). Follow-up work arrives as new messages; teammate fire-and-forget notes arrive prefixed with [team message from …]."
      : effectiveAutoExit
      ? "Complete your task autonomously. When you are finished, simply stop — your session ends automatically."
      : "Complete your task. The user can interact with you at any time, and the session ends when the user exits the pane.";
    const summaryInstruction = memberMode
      ? "Your FINAL assistant message of THIS round is delivered to the orchestrator as the round's result — make it a complete, self-contained summary."
      : effectiveAutoExit
      ? "Your FINAL assistant message should summarize what you accomplished."
      : "Your FINAL assistant message (before the user exits) should summarize what you accomplished.";
    const identity = agentDefs?.body ?? null;
    const systemPromptMode = agentDefs?.systemPromptMode;
    const identityInSystemPrompt = systemPromptMode && identity;
    const roleBlock = identity && !identityInSystemPrompt ? `\n\n${identity}` : "";
    const fullTask = inheritsConversationContext
      ? params.task
      : `${roleBlock}\n\n${modeHint}\n\n${params.task}\n\n${summaryInstruction}`;

    // Build pi command
    // pane 路径参数要过 pane 内 shell,统一 shellEscape;headless 路径用纯 argv
    // 直传子进程,同一数组但 esc 为恒等——两条路径共用同一参数构造,不漂移。
    const esc = useHeadless ? (value: string) => value : shellEscape;
    const parts: string[] = ["pi"];
    parts.push("--session", esc(subagentSessionFile));
    // Load subagent-done extension so the agent can self-terminate if needed
    parts.push("-e", esc(join(deps.subagentsDir, "subagent-done.ts")));

    // Keep the profile's tool allowlist while allowing Pi to discover the same
    // configured extensions as the parent. The loadout still records the
    // resolved tool policy so resume does not widen callable tools.
    // member 注入 team_send(profile 不能靠 tools 自授,同 spawning 的授权模型)。
    const toolAllowlist = buildSubagentToolAllowlist(effectiveTools, {
      grantSpawning,
      ...(memberMode ? { grantTeamSend: true } : {}),
    });

    // Snapshot the fully-resolved sandbox beside the session file so a later
    // `subagent_message({ name })` resume can replay the same tool policy,
    // model, identity, and spawn permissions.
    const loadout: SubagentLoadout = {
      snapshotVersion: SUBAGENT_LOADOUT_VERSION,
      agent: params.agent ?? null,
      toolAllowlist,
      model: effectiveModel,
      thinking: agentDefs?.thinking ?? null,
      thinkingOverride: params.thinking ?? null,
      tier: plan.tier,
      ...(cohortId ? { cohortId } : {}),
      systemPromptMode: systemPromptMode ?? null,
      identity: identityInSystemPrompt ? identity : null,
      spawnable: agentDefs?.subagentAgents ?? null,
      autoExit: memberMode ? false : effectiveAutoExit,
      ...(memberMode ? { member: true } : {}),
      // Store the actual cwd used by the child. For an omitted `cwd`, this is
      // the parent session cwd rather than the extension host's process.cwd();
      // resume/headless launches must reproduce that directory exactly.
      cwd: targetCwdForSession,
      agentDir: resolvedAgentDir,
    };
    writeSubagentLoadout(subagentSessionFile, loadout);
    // 父侧锚定副本:resume 授权的单一真源(见 session.ts AnchoredSubagentLoadout)。
    // 写失败不阻断本次 spawn;但新版快照带强制锚定标记,后续 resume 会拒绝
    // 缺失的父侧副本,不会静默退回 legacy;路径计入 contextFiles,随 retention
    // 清理一起回收。
    let anchoredLoadoutFile: string | null = null;
    try {
      anchoredLoadoutFile = writeAnchoredLoadout(artifactDir, subagentSessionFile, loadout);
    } catch (error) {
      debugLog(`Could not persist anchored loadout for ${surfaceName}`, error);
    }

    // Apply model, identity, and the tool policy via the shared helper (same
    // code path resume uses — they can't drift).
    // 返回值是写入 context/ 的文件路径,记入 running.contextFiles 供 retention
    // 清理;resume 路径不消费返回值。
    const contextFiles: string[] = deps.applySandboxToParts(
      parts,
      loadout,
      { artifactDir, name: surfaceName },
      { escape: esc },
    );
    if (anchoredLoadoutFile) contextFiles.push(anchoredLoadoutFile);

    // 环境变量已在 createSurface 时经 pane split --env 注入(splitEnv),不再拼
    // shell 前缀;PI_SUBAGENT_SURFACE 不再注入:子进程在 herdr pane 内,自带
    // HERDR_PANE_ID。

    // Pass task and skill prompts to the sub-agent.
    // Only full-context fork mode gets a direct task argument because it already
    // inherits the parent conversation. Blank-session modes use artifact-backed
    // handoff so the wrapper instructions arrive as the initial user message.
    // RPC/headless mode cannot accept positional file arguments, so the prompt
    // arguments are kept separate from the base argv and are delivered over
    // stdin below.
    const basePartsLength = parts.length;
    let taskArg: string;
    if (launchBehavior.taskDelivery === "direct") {
      taskArg = fullTask;
    } else {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const safeName = sanitizeSubagentFileName(surfaceName);
      const artifactName = `context/${safeName || "subagent"}-${timestamp}.md`;
      const artifactPath = join(artifactDir, artifactName);
      mkdirSync(dirname(artifactPath), { recursive: true });
      writeFileSync(artifactPath, fullTask, "utf8");
      contextFiles.push(artifactPath);
      taskArg = `@${artifactPath}`;
    }

    for (const promptArg of buildPiPromptArgs({
      effectiveSkills,
      taskDelivery: launchBehavior.taskDelivery,
      taskArg,
    })) {
      parts.push(esc(promptArg));
    }

    // 创建 pane / 启动 headless 进程延后到所有 session、artifact 和启动参数准备
    // 完成之后,避免准备阶段失败时留下无法管理的孤儿 pane 或孤儿进程。
    // 持久成员首轮关联 nonce:初始 prompt 带 marker,首轮 .round 的关联判定
    // 与后续 team_dispatch 轮同一套语义(见 watchMemberRound)。
    const memberFirstRoundId = memberMode ? randomUUID() : null;
    let child: HeadlessChild | null = null;
    let surface: string;
    if (useHeadless) {
      // RPC argv:参数数组直传子进程,不经 shell拼接;初始任务经 stdin prompt
      // 投递(下方),不进 argv。--mode rpc 必须在最前。
      // Do not pass buildPiPromptArgs() output here: RPC mode rejects positional
      // file arguments (including the pane path's @artifact.md handoff). The
      // complete task and skill prompts are sent as the first stdin prompt below.
      const rpcArgs = ["--mode", "rpc", ...parts.slice(1, basePartsLength)];
      const initialPromptId = `initial-${id}`;
      let initialPromptPending = true;
      child = deps.spawnHeadlessPi(
        { args: rpcArgs, cwd: targetCwdForSession, env: splitEnv },
        (event) => {
          // Only the first prompt is a launch preflight. A later prompt may
          // legitimately fail after a steer/reply and must not make the watcher
          // kill an otherwise live child with a misleading "initial" error.
          if (
            initialPromptPending &&
            event.type === "response" &&
            event.command === "prompt" &&
            (event.id === initialPromptId || event.id == null)
          ) {
            initialPromptPending = false;
            if (event.success === false) {
              child!.promptError = typeof event.error === "string" && event.error
                ? event.error
                : "sub-agent rejected its initial prompt";
            }
          }
        },
      );
      if (child.pid == null) {
        child.kill();
        throw new Error("Failed to spawn headless sub-agent process (check PI_SUBAGENT_PI_ENTRY / pi installation).");
      }
      surface = formatHeadlessSurface(child.pid);
      // headless 初始 prompt:skill 前缀 + 任务全文直接经 stdin 投递。
      // artifact 文件仍写盘(与 pane 路径一致的 handoff 审计),但 RPC prompt
      // 不再用 @file 引用——stdin 无 shell 转义问题,发全文更可靠。
      child.send({
        id: initialPromptId,
        type: "prompt",
        message: memberFirstRoundId
          ? buildTeamRoundPrompt(memberFirstRoundId, deps.buildHeadlessPrompt(effectiveSkills, fullTask))
          : deps.buildHeadlessPrompt(effectiveSkills, fullTask),
      });
    } else {
      surface = options?.surface ?? deps.createSurface(surfaceName, { cwd: effectiveCwd ?? undefined, env: splitEnv });
      if (!surfacePreCreated) {
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, deps.getShellReadyDelayMs()));
      }

      // herdr:整行命令直发 pane 内 shell。任务与身份都走文件参数,命令行仅含
      // 固定 flag 与路径,长度可控;cwd 已由 pane split --cwd 设定。sentinel 由
      // surface.ts 按 pane shell 语法生成(Windows/herdr=PowerShell $LASTEXITCODE,
      // POSIX=tmux 及 herdr on Linux/macOS 用 $?)。
      const command = `${parts.join(" ")}${sentinelSuffix(sentinelToken)}`;
      try {
        deps.sendCommand(surface, command);
      } catch (err) {
        // 命令未能送达:pane 留着只会成为孤儿,关闭并上抛
        try {
          deps.closeSurface(surface);
        } catch (closeError) {
          debugLog(`Could not close failed launch pane ${surface}`, closeError);
        }
        throw err;
      }
    }

    // 进程/表面已创建:尾段失败(登记或 watcher 启动)必须回滚,口径与 resume
    // 完全一致——登记(内存与磁盘记录)与进程/表面都在本模块处理,调用方只
    // 负责完成记录与名字保留的释放。异常原样上抛,不吞错。
    const runtimeFile = deps.registry.pathFor(artifactDir);
    try {
      const running: RunningSubagent = {
        id,
        name: surfaceName,
        task: params.task,
        ...(cohortId ? { cohortId } : {}),
        agent: params.agent,
        model: effectiveModel,
        parentId: process.env.PI_SUBAGENT_ID ?? null,
        ...(params.timeoutMs != null ? { timeoutMs: params.timeoutMs } : {}),
        waitMode: memberMode ? "member-round" : effectiveInteractive ? "interactive" : "hard-barrier",
        surface,
        startTime,
        sessionFile: subagentSessionFile,
        activityFile,
        interactive: effectiveInteractive,
        sentinelToken,
        runtimeFile,
        statusState: createStatusState({
          source: "pi",
          startTimeMs: startTime,
        }),
        kind: useHeadless ? "headless" : "pane",
        ...(anchoredLoadoutFile ? { anchoredLoadout: true } : {}),
        contextFiles,
        ...(memberMode ? { member: true, rosterFile: rosterPath(artifactDir), dispatchedRoundId: memberFirstRoundId! } : {}),
        ...(child && child.pid != null ? { pid: child.pid, headlessChild: child } : {}),
      };

      deps.registry.add(running);
      // member 名册登记:首轮即第一个在途轮次。父进程是 roster 唯一写者。
      if (memberMode) {
        try {
          upsertRosterMember(running.rosterFile!, {
            name: running.name,
            ...(running.agent ? { agent: running.agent } : {}),
            sessionFile: running.sessionFile,
            ...(running.pid != null ? { pid: running.pid } : {}),
            status: "dispatched",
            dispatchedAt: Date.now(),
          });
        } catch (error) {
          debugLog(`Could not register team member ${running.name} in roster`, error);
        }
      }
      return startWatcher(running, pi);
    } catch (error) {
      if (deps.registry.get(id)?.surface === surface) {
        deps.registry.remove(id);
      } else {
        deps.registry.removeRecord(runtimeFile, id);
      }
      if (child) {
        try { child.kill(); } catch (closeError) {
          debugLog(`Could not kill failed spawn child ${surface}`, closeError);
        }
      } else {
        try { deps.closeSurface(surface); } catch (closeError) {
          debugLog(`Could not close failed spawn pane ${surface}`, closeError);
        }
      }
      throw error;
    }
  }

  function planResume(
    request: { name: string; message: string; timeoutMs?: number },
    ctx: ResumeContext,
  ): ResumePlanOutcome {
    const { name, message } = request;
    const parentArtifactDir = deps.getArtifactDir(
      ctx.sessionManager.getSessionDir(),
      ctx.sessionManager.getSessionId(),
    );
    const sessionPath = resolveResumeTargetSession(name, parentArtifactDir);
    if ("error" in sessionPath) return { kind: "error", error: sessionPath.error };

    // 仍有一条运行态占用同一会话文件:这是 steer 场景,不是 resume。
    const runningBySession = deps.registry.findBySessionFile(sessionPath.path);
    if (runningBySession) return { kind: "steer", name: runningBySession.name };

    const loadout = readSubagentLoadout(sessionPath.path);
    if (!loadout) {
      return {
        kind: "error",
        error:
          `Cannot safely resume "${name}": no sandbox snapshot found for this session ` +
          `(it predates sandboxed resume, or its .loadout.json sidecar was removed). ` +
          `Resuming would lose the original tool policy and could change the subagent's capabilities, so this is refused. ` +
          `Re-run the task as a fresh subagent instead.`,
      };
    }

    // 锚定副本(父侧 artifactDir,子代理不可直接寻址):resume 授权的
    // 单一真源。新 spawn 的 registry 标记要求副本必须存在;只有旧
    // registry 条目才允许走 legacy 校验路径。
    const anchored = readAnchoredLoadout(parentArtifactDir, sessionPath.path);
    const trustError = deps.validateResumeTarget(
      sessionPath.path,
      loadout,
      deps.getAgentConfigDir(),
      { anchored, requireAnchored: sessionPath.anchored },
    );
    if (trustError) {
      return { kind: "error", error: `Cannot safely resume "${name}": ${trustError}` };
    }
    // 锚定副本是运行配置的单一真源(与 sidecar 已校验一致);只有旧快照
    // 或锚定写入失败的 registry 条目才会退回 sidecar 本身(legacy 授权,
    // containment 已按可信根校验)。Trust decisions live in Pi's global
    // agent directory; getAgentConfigDir() stays the trust root here regardless
    // of the loadout's agentDir.
    const effectiveLoadout: SubagentLoadout = anchored ?? loadout;
    const cohortId = normalizeCohortId(effectiveLoadout.cohortId ?? sessionPath.cohortId);
    const resumedSessionId =
      sessionPath.sessionId ?? getSessionId(sessionPath.path) ?? name;
    const entryCountBefore = countSessionEntryLines(sessionPath.path);
    const artifactDir = parentArtifactDir;

    return {
      kind: "plan",
      plan: {
        name,
        message,
        ...(request.timeoutMs != null ? { timeoutMs: request.timeoutMs } : {}),
        sessionPath: sessionPath.path,
        resumedSessionId,
        entryCountBefore,
        effectiveLoadout,
        cohortId: cohortId ?? null,
        artifactDir,
      },
    };
  }

  async function resume(
    plan: ResumePlan,
    ctx: ResumeContext,
    pi: ExtensionAPI,
  ): Promise<ResumeStartedRun> {
    const { name, message, sessionPath, effectiveLoadout, cohortId, artifactDir } = plan;
    const { autoExit, interactive } = deps.resolveResumeLaunchBehavior();
    const startTime = Date.now();
    const id = Math.random().toString(16).slice(2, 10);
    const sentinelToken = `__PI_SUBAGENT_DONE_${randomUUID()}__`;
    const activityFile = getSubagentActivityFile(artifactDir, id);
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

    // resume 复用既有 session 文件:清掉上一轮遗留的 .exit/.ask sidecar,
    // 避免旧错误/旧问题污染本次 resume(watcher 会把旧 .exit 当本次失败、
    // 旧 .ask 当新问题投递)。写入方用 tmp+rename,直接删除安全。
    try { rmSync(`${sessionPath}.exit`, { force: true }); } catch {}
    try { rmSync(`${sessionPath}.ask`, { force: true }); } catch {}

    // resume 默认走 headless(自动任务,auto → headless):独立 RPC 进程,
    // 不建 pane。
    const surfaceChoice = resolveSurfaceChoice(undefined, false);
    const useHeadless = "choice" in surfaceChoice && surfaceChoice.choice === "headless";
    const runtimeFile = deps.registry.pathFor(artifactDir);
    let createdSurface: string | null = null;
    let child: HeadlessChild | null = null;
    try {
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
        const parts = ["pi", "--session", shellEscape(sessionPath)];
        parts.push("-e", shellEscape(join(deps.subagentsDir, "subagent-done.ts")));
        deps.applySandboxToParts(parts, effectiveLoadout, { artifactDir, name });

        if (message) {
          const msgTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
          const safeName = sanitizeSubagentFileName(name, "resume");
          const resumeMsgFile = join(artifactDir, "subagent-resume", `${safeName}-${msgTimestamp}.md`);
          mkdirSync(dirname(resumeMsgFile), { recursive: true });
          writeFileSync(resumeMsgFile, message, "utf8");
          parts.push(shellEscape(`@${resumeMsgFile}`));
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
        ...(plan.timeoutMs != null ? { timeoutMs: plan.timeoutMs } : {}),
        waitMode: "hard-barrier",
        surface: createdSurface as string,
        startTime,
        sessionFile: sessionPath,
        activityFile,
        interactive,
        sentinelToken,
        runtimeFile,
        statusState: createStatusState({ source: "pi", startTimeMs: startTime }),
        kind: useHeadless ? "headless" : "pane",
        ...(child && child.pid != null ? { pid: child.pid, headlessChild: child } : {}),
      };
      deps.registry.add(running);
      return {
        ...startWatcher(running, pi),
        resumedSessionId: plan.resumedSessionId,
        entryCountBefore: plan.entryCountBefore,
      };
    } catch (error) {
      // 启动失败自清理:运行态/磁盘记录与进程、表面都在本模块回滚,调用方
      // 只处理完成记录与名字保留。
      if (deps.registry.get(id)?.surface === createdSurface) {
        deps.registry.remove(id);
      } else {
        deps.registry.removeRecord(runtimeFile, id);
      }
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
  }

  async function recover(
    ctx: { sessionManager: { getSessionId(): string; getSessionDir(): string } },
    pi: ExtensionAPI,
  ): Promise<RecoveredRun[]> {
    const runtimeFile = deps.registry.pathFor(
      deps.getArtifactDir(ctx.sessionManager.getSessionDir(), ctx.sessionManager.getSessionId()),
    );
    const recovered: RecoveredRun[] = [];
    for (const record of deps.registry.recoverableRecords(runtimeFile)) {
      // 单条隔离:某条记录恢复失败(如 pane adoptSurface 在无复用器环境下
      // 抛错、或会话文件损坏)只跳过该记录,不中断后续记录的恢复。
      try {
        if ((record.kind ?? "pane") === "headless") {
          // headless 恢复:/reload 后 RPC stdin 已丢失,无法重新接管——这是显式
          // 降级边界。进程已退出:交由调用方提取结果回注;仍在运行:标记
          // stdinLost,watcher 轮询 PID 直到进程消失,期间 steer 与 ask 回复
          // 不可达(报错提示)。
          const pid = record.pid ?? parseHeadlessSurface(record.surface);
          // 持久成员:stdin 无法重接(常驻进程不退出,PID 轮询会永久空转)——
          // 诚实降级:终止进程、移除运行态、roster 标记 offline,session 保留
          // 供显式 resume(subagent_message)或重新 spawn(member: true)。
          if (record.member) {
            if (pid != null && deps.isPidAlive(pid)) {
              deps.terminateHeadlessProcess(pid);
            }
            let offlineReason = "host-reload";
            try {
              const memberRosterFile = rosterPath(dirname(runtimeFile));
              const existingRoster = findRosterMember(memberRosterFile, record.name);
              offlineReason =
                existingRoster?.status === "offline" &&
                existingRoster.sessionFile === record.sessionFile &&
                existingRoster.offlineReason
                  ? existingRoster.offlineReason
                  : "host-reload";
              upsertRosterMember(memberRosterFile, {
                name: record.name,
                ...(record.agent ? { agent: record.agent } : {}),
                sessionFile: record.sessionFile,
                ...(pid != null ? { pid } : {}),
                status: "offline",
                offlineReason,
              });
            } catch (error) {
              debugLog(`Could not mark recovered member ${record.name} offline`, error);
            }
            deps.registry.removeRecord(runtimeFile, record.id);
            recovered.push({ kind: "member-offline", name: record.name, reason: offlineReason });
            continue;
          }
          if (pid == null || !deps.isPidAlive(pid)) {
            deps.registry.removeRecord(runtimeFile, record.id);
            const exit = readExitSidecar(record.sessionFile) ?? { reason: "done" as const, exitCode: 0 };
            recovered.push({
              kind: "exited",
              record,
              exit: {
                exitCode: exit.exitCode,
                ...(exit.errorMessage ? { errorMessage: exit.errorMessage } : {}),
              },
            });
            continue;
          }
          const running: RunningSubagent = {
            id: record.id,
            name: record.name,
            task: record.task,
            ...(record.cohortId ? { cohortId: record.cohortId } : {}),
            agent: record.agent,
            model: readSubagentLoadout(record.sessionFile)?.model ?? null,
            parentId: record.parentId ?? null,
            ...(record.timeoutMs != null ? { timeoutMs: record.timeoutMs } : {}),
            ...(record.waitReleased ? { waitReleased: record.waitReleased } : {}),
            waitMode: "recovered",
            surface: record.surface,
            startTime: record.startTime,
            sessionFile: record.sessionFile,
            activityFile: record.activityFile ?? getSubagentActivityFile(dirname(runtimeFile), record.id),
            interactive: record.interactive,
            sentinelToken: record.sentinelToken,
            runtimeFile,
            statusState: createStatusState({ source: "pi", startTimeMs: record.startTime }),
            kind: "headless",
            pid,
            stdinLost: true,
          };
          deps.registry.track(running);
          recovered.push({ kind: "running", recovered: "headless-degraded", run: startWatcher(running) });
          continue;
        }

        if (!deps.adoptSurface(record.surface)) {
          deps.registry.removeRecord(runtimeFile, record.id);
          continue;
        }
        const running: RunningSubagent = {
          id: record.id,
          name: record.name,
          task: record.task,
          ...(record.cohortId ? { cohortId: record.cohortId } : {}),
          agent: record.agent,
          model: readSubagentLoadout(record.sessionFile)?.model ?? null,
          parentId: record.parentId ?? null,
          ...(record.timeoutMs != null ? { timeoutMs: record.timeoutMs } : {}),
          ...(record.waitReleased ? { waitReleased: record.waitReleased } : {}),
          waitMode: "recovered",
          surface: record.surface,
          startTime: record.startTime,
          sessionFile: record.sessionFile,
          activityFile: record.activityFile ?? getSubagentActivityFile(dirname(runtimeFile), record.id),
          interactive: record.interactive,
          sentinelToken: record.sentinelToken,
          runtimeFile,
          statusState: createStatusState({ source: "pi", startTimeMs: record.startTime }),
        };
        deps.registry.track(running);
        recovered.push({ kind: "running", recovered: "pane", run: startWatcher(running) });
      } catch (error) {
        // 单条隔离兑底:该记录的恢复失败被记录并跳过,循环继续处理后续记录。
        // startWatcher 失败时已 track 的内存条目要撤掉,但磁盘记录按 keepRecord
        // 保留:进程/pane 可能仍在跑正式任务,不做销毁性动作,留给下次宿主
        // 重载重试。只有确实登记过的 id 才移除。
        if (deps.registry.has(record.id)) {
          deps.registry.remove(record.id, { keepRecord: true });
        }
        debugLog(`Could not recover runtime subagent record ${record.id} (${record.name})`, error);
      }
    }
    if (deps.registry.list().length > 0) {
      deps.startWidgetRefresh();
      deps.startStatusRefresh(pi);
    }
    return recovered;
  }

  /** 名字已登记？未登记/会话文件消失都在这里拒绝（resume 的寻址与存在性校验）。 */
  function resolveResumeTargetSession(
    name: string,
    parentArtifactDir: string,
  ):
    | { path: string; anchored: boolean; sessionId: string | null; cohortId: string | null }
    | { error: string } {
    const entry = resolveNameInRegistry(parentArtifactDir, name);
    if (!entry) {
      const known = Object.keys(readNameRegistry(parentArtifactDir));
      return {
        error:
          `No subagent named "${name}" in this session. ` +
          (known.length > 0
            ? `Known subagents: ${known.join(", ")}.`
            : "No subagents have been spawned in this session yet."),
      };
    }
    const sessionPath = entry.sessionFile;
    if (!sessionPath || !existsSync(sessionPath)) {
      return {
        error:
          `Subagent "${name}" is registered but its session file is gone ` +
          `(${sessionPath}). It cannot be resumed. Spawn a fresh subagent instead.`,
      };
    }
    return {
      path: sessionPath,
      anchored: entry.anchored === true,
      sessionId: entry.sessionId ?? null,
      cohortId: entry.cohortId ?? null,
    };
  }

  return { planSpawn, spawn, planResume, resume, recover };
}
