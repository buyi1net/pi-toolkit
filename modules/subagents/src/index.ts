import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  isMuxAvailable,
  muxSetupHint,
  createSurface,
  detectSurface,
  sendCommand,
  pollForExit,
  closeSurface,
  shellEscape,
  sentinelSuffix,
  adoptSurface,
  probeSurface,
  readExitSidecar,
  type PollResult,
} from "./surface.ts";
import {
  formatHeadlessSurface,
  isPidAlive,
  parseHeadlessSurface,
  spawnHeadlessPi,
  createSubagentLaunchEnv,
  terminateHeadlessProcess,
  type HeadlessChild,
} from "./headless.ts";

import {
  countSessionEntryLines,
  getSessionId,
  getNewEntries,
  readNameRegistry,
  readSubagentLoadout,
  registerName,
  resolveNameInRegistry,
  seedSubagentSessionFile,
  writeSubagentLoadout,
  writeAnchoredLoadout,
  readAnchoredLoadout,
  diffSubagentLoadouts,
  SUBAGENT_LOADOUT_VERSION,
  type AnchoredSubagentLoadout,
  type MessageEntry,
  type SubagentLoadout,
} from "./session.ts";
import {
  type StatusSnapshot,
  advanceStatusState,
  capStatusLines,
  classifyStatus,
  createStatusState,
  forceStatusAfterInterrupt,
  formatStatusAggregate,
  formatTransitionLine,
  observeStatus,
  loadStatusConfig,
} from "./status.ts";
import {
  getSubagentActivityFile,
  readSubagentActivityFile,
  type ActivityReadResult,
  type SubagentActivityState,
} from "./activity.ts";
import {
  discoverAgentDefinitions as discoverAgents,
  loadAgentDefaults as loadAgentDefaultsFrom,
  type AgentDefaults,
} from "./agents.ts";
import { normalizeSubagentName, sanitizeSubagentFileName } from "./names.ts";
import { loadTierRouteConfig, resolveTierForParams, normalizeTier, type TierRouteInjectedSource } from "./routing.ts";
import { routeExceptionFromResult } from "./route-error.ts";
import { settleCompletionFromResult } from "./dependencies.ts";
import { extractSubagentResult } from "./result.ts";
import { registerSubagentRenderers } from "./renderers.ts";
import { registerSubagentsListTool } from "./list-tool.ts";
import { registerSubagentInspectTool } from "./inspect-tool.ts";
import { registerSubagentCommand } from "./command.ts";
import { registerSubagentTool } from "./subagent-tool.ts";
import { registerSubagentMessageTool } from "./message-tool.ts";
import { registerSubagentStopTool } from "./stop-tool.ts";
import { registerTeamDispatchTool } from "./team-dispatch-tool.ts";
import { claimRoundSignal, claimTeamMessages, buildTeamRoundPrompt, findRosterMember, rosterPath, teamRoundMarker, upsertRosterMember } from "./team.ts";
import { normalizeCohortId, SubagentParams, validateCohortId } from "./params.ts";
import type { RunningSubagent, SubagentResult } from "./types.ts";
import {
  buildPiPromptArgs,
  buildSubagentToolAllowlist,
  getDefaultSessionDirFor,
  resolveEffectiveAutoExit,
  resolveEffectiveInteractive,
  resolveEffectiveSessionMode,
  resolveLaunchBehavior,
  resolveSubagentPaths,
  resolveSurfaceChoice,
  validateAgentLifecycleConfig,
  SPAWNING_TOOLS,
} from "./launch-config.ts";
import {
  borderBottom,
  borderLine,
  borderTop,
  contextWindowFor,
  formatContextUsage,
  formatElapsed,
  formatTokens,
  formatUsageSegments,
  widgetIcon,
} from "./display.ts";
import { debugLog } from "./diagnostics.ts";
import {
  createRuntimeRecord,
  readRuntimeRecords,
  removeRuntimeRecord,
  runtimeRegistryPath,
  upsertRuntimeRecord,
} from "./runtime-registry.ts";

/** Absolute path to the source directory. https://github.com/nodejs/node/issues/37845 */
const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url));

// Survive /reload: clear timers and abort poll loops from the previous module load.
// /reload re-imports this file, giving fresh module-level state, but closures from
// the old module keep running. See https://github.com/HazAT/pi-interactive-subagents/issues/5
const WIDGET_INTERVAL_KEY = Symbol.for("pi-subagents/widget-interval");
const STATUS_INTERVAL_KEY = Symbol.for("pi-subagents/status-interval");
const POLL_ABORT_KEY = Symbol.for("pi-subagents/poll-abort-controller");
const MODULE_INSTANCE_KEY = Symbol.for("pi-subagents/module-instance");
const moduleInstanceId = randomUUID();
(globalThis as any)[MODULE_INSTANCE_KEY] = moduleInstanceId;

{
  const prevInterval = (globalThis as any)[WIDGET_INTERVAL_KEY];
  if (prevInterval) {
    clearInterval(prevInterval);
    (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
  }
  const prevStatusInterval = (globalThis as any)[STATUS_INTERVAL_KEY];
  if (prevStatusInterval) {
    clearInterval(prevStatusInterval);
    (globalThis as any)[STATUS_INTERVAL_KEY] = null;
  }
  const prevAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
  if (prevAbort) prevAbort.abort();
  (globalThis as any)[POLL_ABORT_KEY] = new AbortController();
}

function getModuleAbortSignal(): AbortSignal {
  return ((globalThis as any)[POLL_ABORT_KEY] as AbortController).signal;
}

// ── 宿主(pi-toolkit)配置注入 ──────────────────────────────────────────
// 本文件既作为 pi-toolkit 的子代理模块被装配，也作为子进程 `-e` 的独立扩展
// 被直接加载。独立加载时没有宿主，配置完全按原 pi-subagents 的读取链走；
// 被 pi-toolkit 装配时由宿主注入 `subagents` 节（pi-toolkit.json 的
// `modules.subagents`），用于 tier 路由与 status 开关的取值覆盖。

/** 宿主注入的 subagents 节：`source` 仅用于错误提示定位 */
export interface SubagentsHostSection {
  readonly source: string;
  readonly section: Record<string, unknown>;
}

export interface SubagentsExtensionOptions {
  /** 注册旧 `/subagent` 命令；合并后产品不再注册（决策 5），默认关闭 */
  registerCommand?: boolean;
  /** 读 pi-toolkit.json 的 subagents 节（同步、实时）；未装配宿主时省略 */
  readHostSection?: () => SubagentsHostSection | null;
}

let hostOptions: SubagentsExtensionOptions = {};

/** 设置宿主注入；幂等，重复调用以最后一次为准（/reload 后重新装配） */
export function configureSubagentsExtension(options: SubagentsExtensionOptions): void {
  hostOptions = options;
}

/** 读宿主 subagents 节；读取失败或不合法一律当作“没配置”，不拖垮启动 */
function hostSection(): SubagentsHostSection | null {
  try {
    return hostOptions.readHostSection?.() ?? null;
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 宿主 tier 层的注入候选。只有宿主节真的声明了 `models` 对象时才算一个候选层：
 * 否则（用户没在菜单里配过 tier）就让链继续落到包内 config.json / example 兜底。
 */
export function resolveHostTierSources(): TierRouteInjectedSource[] {
  const host = hostSection();
  if (!host) return [];
  const models = host.section.models;
  if (!isPlainObject(models) || Object.keys(models).length === 0) return [];
  return [{ source: host.source, raw: { models } }];
}

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

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
function validateResumeTarget(
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

/** Built-in tools pi provides natively — no extension needs to be loaded. */
const BUILTIN_TOOLS = new Set(["read", "write", "edit", "bash", "grep", "find", "ls"]);

/** Resolve the global agent config directory, respecting PI_CODING_AGENT_DIR. */
export function getAgentConfigDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

// ── Runtime tool-extension registration ─────────────────────────────────────
// `getToolExtensionPath` otherwise only knows a closed set of tool names. Other
// pi extensions that bundle a tool for subagents (e.g. a project-local
// extension exposing a bespoke tool) register its name → extension-file path
// here at load/session_start time so a child process can receive an explicit
// `-e <path>` even when that extension is outside the child's discovery root.
// Mirrors the legacy `subagents` extension's `registerToolExtension` hook.
const EXTRA_TOOL_EXTENSIONS = new Map<string, string>();

/** Register (or re-register) a custom tool's backing extension file. */
export function registerToolExtension(name: string, extensionPath: string): void {
  if (BUILTIN_TOOLS.has(name)) {
    throw new Error(`Cannot register custom tool "${name}": shadows a built-in pi tool`);
  }
  if ((SPAWNING_TOOLS as readonly string[]).includes(name)) {
    throw new Error(`Cannot register custom tool "${name}": shadows a spawning tool`);
  }
  const existing = EXTRA_TOOL_EXTENSIONS.get(name);
  if (existing === extensionPath) return; // idempotent / reload-safe
  if (existing !== undefined) {
    throw new Error(
      `Tool extension already registered for "${name}": ${existing} (refusing to overwrite with ${extensionPath})`,
    );
  }
  EXTRA_TOOL_EXTENSIONS.set(name, extensionPath);
}

// Expose registration on a process-global so project-local extensions loaded
// via jiti (separate module instances) can reach this shared map. Set at module
// load so it's available before any `session_start` listener runs.
(globalThis as any).__pi_interactive_subagents = {
  registerToolExtension,
};

/**
 * Map a custom (non-built-in) tool name to the pi-extension file that
 * registers it. Explicitly passing a backing extension keeps parent-registered
 * custom tools available even when the child has a different discovery root.
 * Returns undefined for built-in tools and for unknown names.
 */
function getToolExtensionPath(tool: string): string | undefined {
  if (BUILTIN_TOOLS.has(tool)) return undefined;
  // The four spawning tools are registered by THIS extension.
  if ((SPAWNING_TOOLS as readonly string[]).includes(tool)) {
    return fileURLToPath(import.meta.url);
  }
  const extBase = join(getAgentConfigDir(), "extensions");
  const map: Record<string, string> = {
    web_search: join(extBase, "web-search", "index.ts"),
    web_fetch: join(extBase, "web-fetch", "index.ts"),
    video_extract: join(extBase, "video-extract", "index.ts"),
    youtube_search: join(extBase, "youtube-search", "index.ts"),
    google_image_search: join(extBase, "google-image-search", "index.ts"),
    safe_bash: join(SUBAGENTS_DIR, "tools", "safe-bash.ts"),
  };
  // Prefer the built-in path, but fall back to a runtime-registered extension
  // when that path no longer exists on disk (e.g. a built-in tool extension
  // was disabled/removed but a project-local extension re-registered it).
  const builtin = map[tool];
  if (builtin && existsSync(builtin)) return builtin;
  return EXTRA_TOOL_EXTENSIONS.get(tool);
}

/**
 * When this process was spawned as a restricted subagent, the parent pins the
 * set of agents it may itself spawn via PI_SUBAGENT_ALLOWED. `null` means no
 * restriction (top-level session, or an unrestricted child).
 */
// PI_SUBAGENT_ALLOWED 语义:env 未设置 → null(顶层会话,无限制);
// 设置了(即使为空串)→ 受限模式,空列表 = 禁止一切繁衍。
// 不能把空列表当作“无限制”——那会让受限子代理清空 env 即可绕过繁衍白名单。
const SUBAGENT_ALLOWLIST: Set<string> | null = (() => {
  const raw = process.env.PI_SUBAGENT_ALLOWED;
  if (raw === undefined) return null;
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
})();

function getBundledAgentsDir(): string {
  return join(SUBAGENTS_DIR, "../agents");
}

function agentDiscoveryOptions() {
  return {
    bundledDir: getBundledAgentsDir(),
    configDir: getAgentConfigDir(),
    projectDir: process.cwd(),
    allowlist: SUBAGENT_ALLOWLIST,
  };
}

function discoverAgentDefinitions() {
  return discoverAgents(agentDiscoveryOptions());
}

function loadAgentDefaults(agentName: string): AgentDefaults | null {
  return loadAgentDefaultsFrom(agentName, agentDiscoveryOptions());
}

/**
 * Wait long enough for a freshly created pane to finish shell startup.
 *
 * Some environments do extra shell-init work before the prompt is ready
 * (for example direnv/devenv), so the delay is configurable for users who hit
 * dropped commands. Keep the historical default at 500ms.
 */
function getShellReadyDelayMs(): number {
  const raw = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 500;
}

function muxUnavailableResult() {
  return {
    content: [
      {
        type: "text" as const,
        text:
          `Sub-agents in a visible pane require herdr or tmux. ${muxSetupHint()} ` +
          `Autonomous sub-agents can also run headless in the background without a multiplexer ` +
          `(surface "background", or the default "auto" for auto-exit agents).`,
      },
    ],
    details: { error: "supported multiplexer not available" },
  };
}

/**
 * Build the internal artifact directory path for the current session.
 * Used by the subagents extension to stash task files, system prompts, and
 * launch scripts for sub-agents. Path convention:
 *   <sessionDir>/artifacts/<session-id>/
 */
function getArtifactDir(sessionDir: string, sessionId: string): string {
  return join(sessionDir, "artifacts", sessionId);
}

const statusConfig = loadStatusConfig();

/**
 * 生效的状态显示开关：pi-toolkit.json 的 `subagents.status.enabled` 优先，
 * 包内 config.json（→ config.json.example）只作兜底默认。运行时实时读取，
 * 菜单里改完立即生效，不需要重启。
 */
function isStatusEnabled(): boolean {
  const status = hostSection()?.section.status;
  if (isPlainObject(status) && typeof status.enabled === "boolean") return status.enabled;
  return statusConfig.enabled;
}

function formatWidgetRightLabel(snapshot: StatusSnapshot): string {
  if (snapshot.kind === "starting") return " starting… ";
  if (snapshot.kind === "running") return ` running ${snapshot.elapsedText} `;
  if (snapshot.kind === "active") {
    const label = snapshot.activityLabel ?? snapshot.activeScope;
    const duration = snapshot.activeDurationText ? ` ${snapshot.activeDurationText}` : "";
    return label ? ` active · ${label}${duration} ` : " active ";
  }
  if (snapshot.kind === "waiting") {
    const duration = snapshot.waitingDurationText ? ` ${snapshot.waitingDurationText}` : "";
    const detail = snapshot.statusLabel ? ` · ${snapshot.statusLabel}` : "";
    return ` waiting${duration}${detail} `;
  }

  const detail = snapshot.statusLabel ? ` · ${snapshot.statusLabel}` : "";
  const duration = snapshot.snapshotProblemText ? ` ${snapshot.snapshotProblemText}` : "";
  return ` stalled${detail}${duration} `;
}

function resolveResultPresentation(
  result: Pick<
    SubagentResult,
    "exitCode" | "elapsed" | "summary" | "sessionFile" | "sessionId" | "errorMessage"
  >,
  name: string,
  options?: { sessionPreserved?: boolean },
): string {
  // 终止引导(重要):结果消息曾以 "Follow up with subagent_message…" 结尾,
  // 实测会诱导主模型在无新指令时反复 message 已完成的子代理,auto-exit 后
  // 结果再回注,形成无限 resume 循环。现在改为明确的终止语义。
  const sessionNote = options?.sessionPreserved === false
    ? `\n\nThis sub-agent's session artifacts were cleaned up by the retention policy; ` +
      `the session cannot be resumed. If the task goal is achieved, simply continue ` +
      `with your work — do NOT message it again unless you have a genuinely NEW instruction.`
    : `\n\nThis sub-agent has finished and its session is preserved. If the task goal is ` +
      `achieved, simply continue with your work — do NOT message it again unless you have ` +
      `a genuinely NEW instruction (repeated messaging after auto-exit creates an infinite loop).`;

  if (result.errorMessage) {
    // Auto-retry exhausted or other agent-loop error. The subagent did not
    // produce a usable result — surface the underlying provider/network
    // failure so the orchestrator can decide whether to retry, resume, or
    // change approach instead of silently treating the run as completed.
    const recoveryHint = options?.sessionPreserved === false
      ? "spawn a new subagent with a corrected route or task"
      : "spawn a new subagent or resume the session with subagent_message";
    return (
      `Sub-agent "${name}" failed after ${formatElapsed(result.elapsed)} ` +
      `(provider/agent error — auto-retry exhausted).\n\n` +
      `Error: ${result.errorMessage}\n\n` +
      `The subagent did not produce a result. If a retry is genuinely warranted, ` +
      `${recoveryHint}.${sessionNote}`
    );
  }

  return result.exitCode !== 0
    ? `Sub-agent "${name}" failed (exit code ${result.exitCode}).\n\n${result.summary}${sessionNote}`
    : `Sub-agent "${name}" completed (${formatElapsed(result.elapsed)}).\n\n${result.summary}${sessionNote}`;
}

// ── 结果回注 ───────────────────────────────────────────────────────────────
// 自动子代理(subagent 工具与 subagent_message resume)的 execute 内硬等待
// 子代理终态,真实结果直接作为 tool result 返回;pi 对同一条 assistant 消息
// 中的 sibling tool calls 默认并行执行(agent-core executeToolCallsParallel →
// Promise.all),turn_end 在全部工具调用完成后才发出,因此同一 turn 并行
// spawn 的自动子代理全部结束后编排者才继续,无需批次聚合、无额外唤醒。
// 交互式子代理的 pane 归用户驱动,保持异步:watcher 终态后经 steer 消息
// 回注。ask_question 与 stalled/recovered 状态通知也保持即时通道。
/**
 * Result from running a single subagent.
 */
/** All currently running subagents, keyed by id. */
const runningSubagents = new Map<string, RunningSubagent>();

/**
 * 运行中的子代理快照（服务注册表句柄 `subagents.running` 用）。
 * 与状态 widget 同源：同一份进程内 Map。
 */
export function listRunningSubagents(): readonly RunningSubagent[] {
  return Array.from(runningSubagents.values());
}

/**
 * 会话作用域的运行态登记文件路径（沿用 runtime-registry 的既有布局：
 * <sessionDir>/artifacts/<sessionId>/subagent-runtime.json）。
 */
export function runtimeRegistryPathForSession(sessionDir: string, sessionId: string): string {
  return runtimeRegistryPath(getArtifactDir(sessionDir, sessionId));
}

// When this extension is loaded inside a subagent that itself spawns children
// (e.g. a worker delegating to scout/researcher), `subagent-done.ts` runs in the
// same process and needs to know whether this session still has children in
// flight — so it can suppress auto-exit and keep the session open until they all
// report back. Expose a live count through a process-global symbol that both
// modules share. (subagent-done.ts reads it; if absent it assumes zero.)
const RUNNING_CHILDREN_COUNT_KEY = Symbol.for("pi-subagents/running-children-count");
(globalThis as any)[RUNNING_CHILDREN_COUNT_KEY] = () => runningSubagents.size;

// ── Widget management ──

/** Latest ExtensionContext from session_start, used for widget updates. */
let latestCtx: ExtensionContext | null = null;
/** Latest ExtensionAPI, used to deliver ask_question notifications from the watcher. */
let latestPi: ExtensionAPI | null = null;

/**
 * Expand every profile skill for a headless RPC prompt.
 *
 * Pane launches can pass several `/skill:name` positional messages and let the
 * CLI expand them independently. RPC accepts one JSON prompt, and Pi treats
 * everything after the first skill command as that command's arguments. Read
 * the same skill files here and emit Pi's normal `<skill>` blocks instead of
 * silently making the second and later skills arguments to the first one.
 *
 * The resolver is injectable for tests and for hosts that expose a resource
 * registry. In the normal extension host, `getCommands()` carries each skill's
 * canonical source path, so no ad-hoc filesystem scan is needed.
 */
export function buildHeadlessPrompt(
  effectiveSkills: string | undefined,
  task: string,
  resolveSkill: (name: string) => { path: string } | null = (name) => {
    try {
      const command = latestPi?.getCommands().find(
        (candidate) => candidate.source === "skill" && candidate.name === `skill:${name}`,
      );
      const path = command?.sourceInfo?.path;
      return typeof path === "string" && existsSync(path) ? { path } : null;
    } catch (error) {
      debugLog(`Could not resolve skill ${name} for headless prompt`, error);
      return null;
    }
  },
): string {
  const names = (effectiveSkills ?? "")
    .split(",")
    .map((name) => name.trim().replace(/^\/skill:/, ""))
    .filter(Boolean);
  const blocks: string[] = [];
  const unresolved: string[] = [];

  for (const name of names) {
    const resolved = resolveSkill(name);
    if (!resolved) {
      unresolved.push(name);
      continue;
    }
    try {
      const raw = readFileSync(resolved.path, "utf8");
      const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, "").trim();
      if (!body) {
        unresolved.push(name);
        continue;
      }
      blocks.push(
        `<skill name="${name}" location="${resolved.path}">\n` +
          `References are relative to ${dirname(resolved.path)}.\n\n` +
          `${body}\n</skill>`,
      );
    } catch (error) {
      unresolved.push(name);
      debugLog(`Could not read skill ${name} at ${resolved.path}`, error);
    }
  }

  if (unresolved.length > 0) {
    // Do not put unresolved `/skill:` commands into a multi-skill prompt: Pi
    // would interpret the remainder as arguments to the first command. The
    // child still receives its normal available-skills system section and can
    // read these named files itself, while the omission remains explicit.
    blocks.push(
      `The following configured skills could not be expanded by the orchestrator: ` +
        `${unresolved.join(", ")}. Before acting, locate and read each skill's ` +
        `SKILL.md from the available skills list if it is present.`,
    );
  }

  return [...blocks, task].filter((part) => part.length > 0).join("\n\n");
}

/** Interval timer for widget re-renders. */
let widgetInterval: ReturnType<typeof setInterval> | null = null;

/** Interval timer for status transition checks. */
let statusInterval: ReturnType<typeof setInterval> | null = null;

function formatElapsedMMSS(startTime: number): string {
  const seconds = Math.floor((Date.now() - startTime) / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function renderSubagentWidgetLines(agents: RunningSubagent[], width: number): string[] {
  const count = agents.length;
  const title = "Subagents";
  const info = `${count} running`;

  const lines: string[] = [borderTop(title, info, width)];

  for (const agent of agents) {
    const elapsed = formatElapsedMMSS(agent.startTime);
    const agentTag = agent.agent ? ` (${agent.agent})` : "";
    const snapshot = classifyStatus(agent.statusState, Date.now());
    const icon = widgetIcon(snapshot.kind);
    const left = ` ${icon} ${elapsed}  ${agent.name}${agentTag} `;
    const right = isStatusEnabled()
      ? formatWidgetRightLabel(snapshot)
      : " starting… ";

    lines.push(borderLine(left, right, width));
  }

  lines.push(borderBottom(width));
  return lines;
}

function updateWidget() {
  if (!latestCtx?.hasUI) return;

  if (runningSubagents.size === 0) {
    latestCtx.ui.setWidget("subagent-status", undefined);
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
      (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
    }
    return;
  }

  latestCtx.ui.setWidget(
    "subagent-status",
    (_tui: any, _theme: any) => {
      return {
        invalidate() {},
        render(width: number) {
          return renderSubagentWidgetLines(Array.from(runningSubagents.values()), width);
        },
      };
    },
    { placement: "aboveEditor" },
  );
}

/** 统一路径形态供包含判定:Windows 大小写不敏感,统一小写;POSIX 下仅极端目录名受影响且偏向保守跳过。 */
function normalizeForContains(path: string): string {
  return resolve(path).replace(/[\\/]+/g, "/").toLowerCase();
}

function isWithin(path: string, root: string): boolean {
  const p = normalizeForContains(path);
  const r = normalizeForContains(root);
  return p === r || p.startsWith(r + "/");
}

/** 本扩展的完整包名(@scope/name 或 name),从自身 package.json 读取,发布树与开发树同源。 */
function ownPackageName(): string | null {
  try {
    const pkg: unknown = JSON.parse(readFileSync(join(SUBAGENTS_DIR, "..", "..", "..", "package.json"), "utf8"));
    const name = (pkg as { name?: unknown } | null)?.name;
    return typeof name === "string" && name ? name : null;
  } catch {
    return null;
  }
}

/**
 * 从 packages 条目解析包名(去版本/ref):
 * npm:@scope/name@1.2.3 → @scope/name(全名,保留 scope 供精确比对);
 * git:host/path#ref → path 末段;绝对路径 → 末段目录名。
 */
function entryPackageName(entry: string): string | null {
  if (entry.startsWith("npm:")) {
    let spec = entry.slice("npm:".length);
    if (spec.startsWith("@")) {
      // scoped 包:首个 @ 是 scope 分隔,版本从第二个 @ 起
      const rest = spec.slice(1);
      const at = rest.indexOf("@");
      spec = at >= 0 ? `@${rest.slice(0, at)}` : `@${rest}`;
    } else {
      const at = spec.indexOf("@");
      if (at >= 0) spec = spec.slice(0, at);
    }
    return spec;
  }
  if (entry.startsWith("git:")) {
    const pathPart = entry.split("#")[0].replace(/^git:(https?:\/\/)?/, "");
    return pathPart.split("/").filter(Boolean).pop() ?? null;
  }
  if (isAbsolute(entry)) {
    return entry.split(/[\\/]/).filter(Boolean).pop() ?? null;
  }
  return null;
}

/**
 * 判定子进程的扩展发现是否会注册与本模块同批的工具(spawning 工具):
 * 读子进程 agentDir 的 settings.json,packages 里任一条目是本包,或绝对
 * 路径条目的安装根覆盖 SUBAGENTS_DIR(本地测试包场景),即成立。
 * 与“是否同一份拷贝”无关:任何一份 pi-toolkit 被发现都会注册同批工具,
 * 再注入本模块必致工具名冲突。读不到或格式异常按不成立处理(保守保留注入)。
 * 匹配精度:npm 条目带 scope,全名精确匹配;git/绝对路径没有 scope 对应
 * 关系只能末段名匹配——误命中面仅限“同时装着同名异主的 git 仓/目录”,
 * 后果是少注入一次(工具由那份同名包提供,仍可用),可接受。
 */
function childDiscoversOwnPackage(agentDir: string | null): boolean {
  const dir = agentDir ?? join(homedir(), ".pi", "agent");
  const target = resolve(SUBAGENTS_DIR);
  const own = ownPackageName();
  try {
    const settings: unknown = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
    const packages = (settings as { packages?: unknown } | null)?.packages;
    if (!Array.isArray(packages)) return false;
    for (const raw of packages) {
      // 字符串条目是实证形态;对象形态(source/id 字段)未经证实但兼容成本极低,
      // 防御性保留,真出现对象条目时也不至于静默漏判
      const entry = typeof raw === "string"
        ? raw
        : raw && typeof raw === "object"
          ? [((raw as { source?: unknown }).source), ((raw as { id?: unknown }).id)].find(
              (value): value is string => typeof value === "string",
            ) ?? null
          : null;
      if (!entry) continue;
      const name = entryPackageName(entry);
      if (own && name === own) return true;
      if (own && !entry.startsWith("npm:") && name === own.split("/").pop()) return true;
      if (isAbsolute(entry) && isWithin(target, entry)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Apply a loadout snapshot's sandbox to a pi command's `parts` array: model,
 * identity (system prompt), and the profile's tool restriction. Pi's normal
 * extension discovery remains enabled so the child inherits configured plugins.
 *
 * This is the single source of truth for reconstructing a subagent's sandbox,
 * used both by the initial `launchSubagent` and by the `subagent_message`
 * resume path so the two can never drift. Env vars (PI_SUBAGENT_AGENT /
 * PI_SUBAGENT_ALLOWED / PI_CODING_AGENT_DIR) and cwd are the caller's
 * responsibility since they differ slightly between launch and resume.
 */
function applySandboxToParts(
  parts: string[],
  loadout: SubagentLoadout,
  opts: { artifactDir: string; name: string },
  /** headless 路径传恒等函数:参数走 argv 不经 shell,不做 shellEscape。 */
  options?: { escape?: (value: string) => string },
): string[] {
  const escape = options?.escape ?? shellEscape;
  // 本次调用写入 artifactDir/context/ 的文件路径,返回给调用方记入
  // running.contextFiles(retention 清理用);resume 路径忽略返回值。
  if (loadout.model) {
    // 思考等级优先级:thinkingOverride(spawn 显式参数)> model 自带 ":level" 后缀 >
    // frontmatter thinking。不无条件追加,避免 "model:max" + frontmatter "low"
    // 拼成 ":max:low" 导致 max 被覆盖。
    let model = loadout.model;
    const suffixMatch = /^(.+):([a-z]+)$/.exec(model);
    const modelThinking = suffixMatch && THINKING_LEVELS.has(suffixMatch[2]) ? suffixMatch[2] : null;
    if (loadout.thinkingOverride) {
      model = (modelThinking ? suffixMatch![1] : model) + ":" + loadout.thinkingOverride;
    } else if (!modelThinking && loadout.thinking) {
      model = model + ":" + loadout.thinking;
    }
    parts.push("--model", escape(model));
  }

  const contextArtifacts: string[] = [];
  if (loadout.identity) {
    const flag = loadout.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt";
    const spTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const spSafeName = sanitizeSubagentFileName(opts.name);
    const spPath = join(opts.artifactDir, `context/${spSafeName || "subagent"}-sysprompt-${spTimestamp}.md`);
    mkdirSync(dirname(spPath), { recursive: true });
    writeFileSync(spPath, loadout.identity, "utf8");
    contextArtifacts.push(spPath);
    parts.push(flag, escape(spPath));
  }

  // Keep the profile's tool allowlist, but leave Pi's normal extension
  // discovery enabled so the child inherits the parent's configured plugins.
  // Explicit backing paths below preserve custom tool extensions that are not
  // discoverable from the child's cwd/config directory.
  // An empty string is an intentional empty allowlist and must not be treated
  // like null. Using a truthiness check here would silently widen a restricted
  // profile back to Pi's default tool set during resume.
  if (typeof loadout.toolAllowlist === "string") {
    parts.push("--tools", escape(loadout.toolAllowlist));

    const extPaths = new Set<string>();
    for (const tool of loadout.toolAllowlist.split(",")) {
      const extPath = getToolExtensionPath(tool);
      if (extPath && existsSync(extPath)) extPaths.add(extPath);
    }
    // -e 注入的路径 containment:只允许插件自身目录与宿主 extensions 目录下的
    // 扩展被回装,防止注册表被注入任意路径后把不可信代码带进子代理沙箱。
    const trustedRoots = [resolve(SUBAGENTS_DIR), resolve(join(getAgentConfigDir(), "extensions"))];
    // 子进程保留扩展发现:当子进程 agentDir 的 packages 已注册覆盖本模块
    // 目录的包时,再 -e 注入本模块会把同一批工具注册两次,子进程以工具名
    // 冲突拒绝启动(exit 1)。此时跳过本模块的注入,工具由发现路径提供;
    // 仅当发现路径给不出本模块(-e 开发版启动且未装包)才注入。
    const skipSelfInjection = childDiscoversOwnPackage(loadout.agentDir);
    for (const extPath of extPaths) {
      const resolved = resolve(extPath);
      if (!trustedRoots.some((root) => resolved === root || resolved.startsWith(root + sep))) continue;
      // 注入候选只可能来自本模块树(spawning 工具映射 index.ts、safe_bash 映射
      // tools/safe-bash.ts),所以按 SUBAGENTS_DIR 树判定落点即可,与包根无关。
      if (skipSelfInjection && isWithin(resolved, SUBAGENTS_DIR)) continue;
      parts.push("-e", escape(resolved));
    }
  }

  // Normal extension discovery is intentionally preserved, but delegation is
  // a separate capability. When the profile did not explicitly grant
  // subagent_agents, exclude all three control tools even if the child has no
  // `--tools` allowlist (or a stale loadout tried to include one).
  const canSpawnChildren = Array.isArray(loadout.spawnable) && loadout.spawnable.length > 0;
  if (!canSpawnChildren) {
    parts.push("--exclude-tools", escape(SPAWNING_TOOLS.join(",")));
  }
  return contextArtifacts;
}

function activityLabel(activity: SubagentActivityState): string | undefined {
  if (activity.phase !== "active") return undefined;
  if (activity.activeScope === "tool") return activity.toolName ?? "tool";
  if (activity.activeScope === "provider") return "provider";
  if (activity.activeScope === "streaming") return "streaming";
  return activity.activeScope;
}

function observeRunningSubagent(running: RunningSubagent, observedAt = Date.now()) {
  const activityFile = running.activityFile;
  const read: ActivityReadResult = activityFile
    ? readSubagentActivityFile(activityFile, running.id)
    : { ok: false, reason: "missing" };

  running.activityRead = read.ok
    ? { ok: true }
    : { ok: false, reason: read.reason, error: read.error };

  if (read.ok) {
    running.activity = read.activity;
    running.statusState = observeStatus(running.statusState, {
      snapshot: "present",
      updatedAt: read.activity.updatedAt,
      sequence: read.activity.sequence,
      phase: read.activity.phase,
      active: read.activity.phase === "active",
      activeScope: read.activity.activeScope,
      activeSince: read.activity.activeSince,
      waitingSince: read.activity.waitingSince,
      latestEvent: read.activity.latestEvent,
      activityLabel: activityLabel(read.activity),
    }, observedAt);
    return;
  }

  running.statusState = observeStatus(running.statusState, {
    snapshot: read.reason,
    snapshotError: read.error,
  }, observedAt);
}

/**
 * Names claimed by spawns that are mid-launch but not yet registered in
 * `runningSubagents`. Parallel `subagent` tool calls run their synchronous
 * prefix (name defaulting) before any of them finishes `launchSubagent` and
 * registers, so without this they'd all see an empty map and pick the same
 * name. Reserved synchronously when a default name is chosen and released once
 * the subagent registers (or its launch fails).
 */
const reservedNames = new Set<string>();

/**
 * Return `base`, or `base-2`, `base-3`, … so the result is unique within this
 * spawner session. Considers (a) currently-running subagents, (b) names
 * reserved by parallel in-flight spawns, and (c) every name already recorded in
 * the spawner's persistent registry — so a defaulted name never collides with a
 * finished subagent either. This lets `subagent_message({ name })` address any
 * subagent of this session unambiguously, running or finished.
 *
 * `registryNames` is the set of names already taken in the registry (empty when
 * there is no session file / artifact dir yet).
 */
function uniqueRunningName(base: string, registryNames?: Set<string>): string {
  const taken = new Set(Array.from(runningSubagents.values()).map((r) => r.name));
  for (const reserved of reservedNames) taken.add(reserved);
  if (registryNames) for (const n of registryNames) taken.add(n);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

function resolveRunningByName(name: string):
  | { running: RunningSubagent }
  | { error: string } {
  // 与 spawn/resume 同規则 normalize,多余空白/大小写差异不再导致寻址失败;
  // 空名仍报错(fallback 传空串,不默认成 "subagent")。
  const requestedName = normalizeSubagentName(name, "");
  if (!requestedName) {
    return { error: "Provide the exact display name of a running subagent." };
  }

  const matches = Array.from(runningSubagents.values()).filter((running) => running.name === requestedName);
  if (matches.length === 1) return { running: matches[0] };
  if (matches.length === 0) {
    const names = Array.from(runningSubagents.values()).map((r) => r.name);
    const hint = names.length
      ? ` Currently running: ${[...new Set(names)].join(", ")}.`
      : " No subagents are currently running.";
    return { error: `No running subagent named "${requestedName}".${hint}` };
  }

  const candidates = matches.map((running) => `${running.name} [${running.id}]`).join(", ");
  return { error: `Ambiguous subagent name "${requestedName}". Matches: ${candidates}` };
}

/**
 * Type a follow-up message into a running subagent's live pane. Newlines are
 * collapsed to spaces because each newline submits a turn in the child's TUI
 * editor; a multi-line message would otherwise fire as several partial turns.
 */
function steerSubagent(
  running: RunningSubagent,
  message: string,
  send: (surface: string, command: string) => void = sendCommand,
): { ok: true } | { error: string } {
  const flattened = message.replace(/\s*\n\s*/g, " ").trim();
  // headless 子代理:消息经 RPC stdin 投递(prompt + streamingBehavior:steer,
  // 运行中排队、空闲开启新 run),不经 pane 键入。
  if (running.kind === "headless") {
    if (running.stdinLost) {
      return {
        error:
          `Cannot deliver message to headless sub-agent "${running.name}": the host was ` +
          `reloaded and its stdin can no longer be reached. Its result will still be ` +
          `delivered when the process exits; spawn a fresh sub-agent if you need to steer it now.`,
      };
    }
    const child = running.headlessChild;
    if (!child) {
      return { error: `Headless sub-agent "${running.name}" has no live process handle.` };
    }
    if (child.exited) {
      return {
        error:
          `Headless sub-agent "${running.name}" has already exited; its result is being delivered. ` +
          `Use subagent_message again after the result arrives to resume its session.`,
      };
    }
    child.steer(flattened);
    return { ok: true };
  }
  try {
    send(running.surface, flattened);
    return { ok: true };
  } catch (error: any) {
    // 表面可能是 herdr 或 tmux,错误文案按实际检测结果命名,不写死 herdr。
    const muxLabel = detectSurface() === "tmux" ? "tmux" : detectSurface() === "herdr" ? "herdr" : "terminal multiplexer";
    return {
      error:
        `Failed to deliver message to subagent "${running.name}" via ${muxLabel}: ` +
        `${error?.message ?? String(error)}`,
    };
  }
}

function handleSubagentSteer(
  params: { name?: string; message?: string },
  send: (surface: string, command: string) => void = sendCommand,
) {
  const message = params.message?.trim();
  if (!message) {
    const err = "`message` is required to steer a running subagent.";
    return { content: [{ type: "text" as const, text: err }], details: { error: err } };
  }

  const resolved = resolveRunningByName(params.name ?? "");
  if ("error" in resolved) {
    return {
      content: [{ type: "text" as const, text: resolved.error }],
      details: { error: resolved.error },
    };
  }

  const running = resolved.running;
  const now = Date.now();
  observeRunningSubagent(running, now);

  const steer = steerSubagent(running, message, send);
  if ("error" in steer) {
    return {
      content: [{ type: "text" as const, text: steer.error }],
      details: {
        error: steer.error,
        id: running.id,
        name: running.name,
        ...(running.cohortId ? { cohortId: running.cohortId } : {}),
      },
    };
  }

  running.statusState = forceStatusAfterInterrupt(running.statusState, now);
  updateWidget();

  return {
    content: [{
      type: "text" as const,
      text:
        `Message delivered to running subagent "${running.name}". It picks this up at its next ` +
        `turn boundary. If it exits, its result still arrives as a steer message.`,
    }],
    details: {
      id: running.id,
      name: running.name,
      ...(running.cohortId ? { cohortId: running.cohortId } : {}),
      status: "steered",
    },
  };
}

function startStatusRefresh(pi: ExtensionAPI) {
  if (!isStatusEnabled() || statusInterval) return;

  statusInterval = setInterval(() => {
    if (runningSubagents.size === 0) {
      if (statusInterval) {
        clearInterval(statusInterval);
        statusInterval = null;
        (globalThis as any)[STATUS_INTERVAL_KEY] = null;
      }
      return;
    }

    const transitionLines: string[] = [];
    const now = Date.now();
    let shouldRefreshWidget = false;

    for (const running of runningSubagents.values()) {
      observeRunningSubagent(running, now);
      const { nextState, snapshot, transition } = advanceStatusState(running.statusState, now);
      if (nextState.currentKind !== running.statusState.currentKind) {
        shouldRefreshWidget = true;
      }
      running.statusState = nextState;

      // Interactive subagents (long-running, user-driven) intentionally don't
      // wake the parent session on stalled/recovered transitions — the user is
      // working in the subagent's pane, and a steer message here would burn an
      // orchestrator turn on a no-op "still waiting" ping. Widget still updates.
      if (transition && !running.interactive) {
        transitionLines.push(formatTransitionLine(running.name, snapshot, transition));
      }
    }

    if (shouldRefreshWidget) updateWidget();

    if (transitionLines.length > 0) {
      const capped = capStatusLines(transitionLines, statusConfig.lineLimit);
      pi.sendMessage(
        {
          customType: "subagent_status",
          content: formatStatusAggregate(transitionLines, statusConfig.lineLimit),
          display: true,
          details: { lines: capped.visibleLines, overflow: capped.overflow },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    }
  }, 1000);

  (globalThis as any)[STATUS_INTERVAL_KEY] = statusInterval;
}

// Resuming a finished session is always autonomous: the relaunched agent runs
// its follow-up task to completion and the result is returned directly from
// the blocking subagent_message tool call. An interactive resume would park
// the pane waiting for the user, contradicting that result-delivery model.
function resolveResumeLaunchBehavior(): { autoExit: boolean; interactive: boolean } {
  return { autoExit: true, interactive: false };
}

export const __test__ = {
  borderLine,
  isStatusEnabled,
  getShellReadyDelayMs,
  renderSubagentWidgetLines,
  loadAgentDefaults,
  discoverAgentDefinitions,
  validateResumeTarget,
  resolveEffectiveSessionMode,
  resolveLaunchBehavior,
  resolveEffectiveAutoExit,
  resolveEffectiveInteractive,
  resolveSurfaceChoice,
  validateAgentLifecycleConfig,
  buildSubagentToolAllowlist,
  applySandboxToParts,
  buildPiPromptArgs,
  formatWidgetRightLabel,
  observeRunningSubagent,
  getToolExtensionPath,
  resolveRunningByName,
  uniqueRunningName,
  reservedNames,
  steerSubagent,
  handleSubagentSteer,
  classifyWatcherFailure,
  watchMemberRound,
  dispatchMarkerInSession,
  canReuseMemberName,
  markMemberOffline,
  drainMemberMailbox,
  resolveResultPresentation,
  resolveResumeLaunchBehavior,
  buildHeadlessPrompt,
  runningSubagents,
  watchSubagent,
  waitForHeadlessExit,
  watchHeadlessSubagent,
  formatElapsed,
  formatTokens,
  formatContextUsage,
  contextWindowFor,
  formatUsageSegments,
  widgetIcon,
};

function startWidgetRefresh() {
  if (widgetInterval) return;
  updateWidget(); // immediate first render
  widgetInterval = setInterval(() => {
    updateWidget();
  }, 1000);
  (globalThis as any)[WIDGET_INTERVAL_KEY] = widgetInterval;
}

/**
 * Launch a subagent: creates the multiplexer pane, builds the command, and
 * sends it. Returns a RunningSubagent — does NOT poll.
 *
 * Call watchSubagent() on the returned object to observe completion.
 */
async function launchSubagent(
  params: typeof SubagentParams.static,
  ctx: { sessionManager: { getSessionFile(): string | null | undefined; getSessionId(): string; getSessionDir(): string }; cwd: string },
  options?: { surface?: string },
): Promise<RunningSubagent> {
  const startTime = Date.now();
  const id = Math.random().toString(16).slice(2, 10);
  const sentinelToken = `__PI_SUBAGENT_DONE_${randomUUID()}__`;
  const cohortError = validateCohortId(params.cohortId);
  if (cohortError) throw new Error(cohortError);
  const cohortId = normalizeCohortId(params.cohortId);

  const agentDefs = params.agent ? loadAgentDefaults(params.agent) : null;
  // Resolve the target before tier lookup so a project-local
  // .pi/agent/pi-subagents.json is honored when the caller selected a
  // different cwd. The concrete model is then captured in the loadout below,
  // so resume does not drift if the tier configuration changes later.
  const { effectiveCwd, localAgentDir, effectiveAgentDir } = resolveSubagentPaths(
    params,
    agentDefs,
    getAgentConfigDir,
  );
  const targetCwdForSession = effectiveCwd ?? ctx.cwd;

  // tier 解析先于 loadout 写入:显式 params.model 优先 tier;tier 无法归一化
  // 或缺映射时直接抛错拒绝启动,绝不静默换模型。loadout.model 存具体模型,
  // tier 仅作记录,resume 不随配置漂移。
  const tierResolution = resolveTierForParams(params, () =>
    loadTierRouteConfig({
      cwd: targetCwdForSession,
      agentConfigDir: effectiveAgentDir,
      injected: resolveHostTierSources(),
    }));
  if ("error" in tierResolution) throw new Error(tierResolution.error);
  const effectiveModel = params.model ?? tierResolution.model ?? agentDefs?.model;
  const effectiveTools = agentDefs?.tools;
  const effectiveSkills = agentDefs?.skills;
  const effectiveThinking = params.thinking ?? agentDefs?.thinking;
  if (effectiveThinking != null && !THINKING_LEVELS.has(effectiveThinking)) {
    throw new Error(
      `Invalid thinking level "${effectiveThinking}". Use: ${[...THINKING_LEVELS].join(", ")}.`,
    );
  }
  const lifecycleError = validateAgentLifecycleConfig(agentDefs);
  if (lifecycleError) throw new Error(lifecycleError);
  const effectiveInteractive = resolveEffectiveInteractive(params, agentDefs);
  const effectiveAutoExit = resolveEffectiveAutoExit(agentDefs);
  // 持久团队成员(member):常驻 headless 进程,不走 auto-exit/barrier。
  // 工具层已拒绝 pane/interactive/discard/timeoutMs/dependsOn 组合;这里
  // 强制 headless 表面,不改变非 member 的任何默认行为。
  const memberMode = params.member === true;

  // 表面选择:pane(现有 herdr/tmux 路径)或 headless(独立后台 pi 进程)。
  // interactive 请求 background 在此直接报错,不静默建 pane。
  const surfaceChoice = resolveSurfaceChoice(
    memberMode ? "background" : params.surface,
    memberMode ? false : effectiveInteractive,
  );
  if ("error" in surfaceChoice) throw new Error(surfaceChoice.error);
  const useHeadless = surfaceChoice.choice === "headless";

  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) throw new Error("No session file");
  const sessionId = ctx.sessionManager.getSessionId();
  const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId);

  // fork 模式拦截必须先于 createSurface/spawnHeadless(否则被拒绝的 spawn 会泄漏 pane 或进程)。
  // fork 的任务文本直传 argv,在 Windows pane 的 PowerShell 引号规则下无法安全
  // 转义,pane 表面不支持;standalone/lineage-only 的任务走 @artifact 文件,不受影响。
  const launchBehavior = resolveLaunchBehavior(params, agentDefs);
  if (launchBehavior.inheritsConversationContext) {
    throw new Error(
      'session-mode: fork is not supported by this extension. Use "standalone" or "lineage-only".',
    );
  }

  const sessionDir = getDefaultSessionDirFor(targetCwdForSession, effectiveAgentDir);

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
  // (activityFile / grantSpawning / resolvedAgentDir 的声明相应提前到此处。)
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
  // ── Pi CLI path ──

  // Build pi command
  // pane 路径参数要过 pane 内 shell,统一 shellEscape;headless 路径用纯 argv
  // 直传子进程,同一数组但 esc 为恒等——两条路径共用同一参数构造,不漂移。
  const esc = useHeadless ? (value: string) => value : shellEscape;
  const parts: string[] = ["pi"];
  parts.push("--session", esc(subagentSessionFile));

  // Load subagent-done extension so the agent can self-terminate if needed
  const subagentDonePath = join(SUBAGENTS_DIR, "subagent-done.ts");
  parts.push("-e", esc(subagentDonePath));

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
    model: effectiveModel ?? null,
    thinking: agentDefs?.thinking ?? null,
    thinkingOverride: params.thinking ?? null,
    tier: tierResolution.tier,
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
  const contextFiles: string[] = applySandboxToParts(
    parts,
    loadout,
    { artifactDir, name: surfaceName },
    { escape: esc },
  );
  if (anchoredLoadoutFile) contextFiles.push(anchoredLoadoutFile);

  // applySandboxToParts(parts, loadout, ...);
  // 环境变量已在 createSurface 时经 pane split --env 注入(splitEnv),不再拼 shell 前缀;
  // PI_SUBAGENT_SURFACE 不再注入:子进程在 herdr pane 内,自带 HERDR_PANE_ID。

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
    child = spawnHeadlessPi(
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
        ? buildTeamRoundPrompt(memberFirstRoundId, buildHeadlessPrompt(effectiveSkills, fullTask))
        : buildHeadlessPrompt(effectiveSkills, fullTask),
    });
  } else {
    surface = options?.surface ?? createSurface(surfaceName, { cwd: effectiveCwd ?? undefined, env: splitEnv });
    if (!surfacePreCreated) {
      await new Promise<void>((resolve) => setTimeout(resolve, getShellReadyDelayMs()));
    }

    // herdr:整行命令直发 pane 内 shell。任务与身份都走文件参数,命令行仅含
    // 固定 flag 与路径,长度可控;cwd 已由 pane split --cwd 设定。sentinel 由
    // surface.ts 按 pane shell 语法生成(Windows/herdr=PowerShell $LASTEXITCODE,
    // POSIX=tmux 及 herdr on Linux/macOS 用 $?)。
    const command = `${parts.join(" ")}${sentinelSuffix(sentinelToken)}`;
    try {
      sendCommand(surface, command);
    } catch (err) {
      // 命令未能送达:pane 留着只会成为孤儿,关闭并上抛
      try { closeSurface(surface); } catch (closeError) {
        debugLog(`Could not close failed launch pane ${surface}`, closeError);
      }
      throw err;
    }
  }

  const running: RunningSubagent = {
    id,
    name: surfaceName,
    task: params.task,
    ...(cohortId ? { cohortId } : {}),
    agent: params.agent,
    model: effectiveModel ?? null,
    parentId: process.env.PI_SUBAGENT_ID ?? null,
    ...(params.timeoutMs != null ? { timeoutMs: params.timeoutMs } : {}),
    waitMode: memberMode ? "member-round" : effectiveInteractive ? "interactive" : "hard-barrier",
    surface,
    startTime,
    sessionFile: subagentSessionFile,
    activityFile,
    interactive: effectiveInteractive,
    sentinelToken,
    runtimeFile: runtimeRegistryPath(artifactDir),
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

  runningSubagents.set(id, running);
  try {
    upsertRuntimeRecord(running.runtimeFile, createRuntimeRecord(running));
  } catch (error) {
    // 运行态记录失败不应撤销已经启动的子代理；watcher 仍负责当前进程。
    debugLog(`Could not persist runtime record for ${running.name}`, error);
  }
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
  return running;
}

/**
 * Watch a launched subagent until it exits. Polls for completion, extracts
 * the summary from the session file, cleans up the surface,
 * and removes the entry from runningSubagents.
 */

/**
 * Detect an `ask_question` signal from a still-running subagent and notify the
 * orchestrator without ending the subagent. Each subagent has its own
 * `${sessionFile}.ask` file and its own watcher, so parallel questions from
 * multiple subagents are delivered independently. The file is deleted after
 * delivery so it fires once per question (a subagent may ask again later).
 */
interface PendingQuestion {
  question?: unknown;
  name?: unknown;
  agent?: unknown;
}

// ── 持久团队成员的父侧生命周期 ─────────────────────────────────────

/** 终止成员进程(有句柄用句柄,否则按 PID 树杀;Windows 兼容 killHeadlessProcessTree)。 */
function killMemberProcess(running: RunningSubagent): void {
  const child = running.headlessChild;
  try {
    if (child) {
      if (!child.exited) child.abort();
      child.kill();
    } else if (running.pid != null) {
      terminateHeadlessProcess(running.pid);
    }
  } catch (error) {
    debugLog(`Could not terminate team member ${running.name}`, error);
  }
}

/** 同名重建判定:仅当名字属于 roster 中 offline 的成员且当前无同名运行中/
 * 保留中的子代理时,member spawn 可安全复用该名字(覆盖 registry 登记,
 * 与 team_dispatch/subagent_stop 的重启指引一致;旧 session 文件仍在磁盘,
 * 但不再按该名字寻址)。非 member spawn 一律不复用。 */
function canReuseMemberName(name: string, artifactDir: string): boolean {
  const normalized = normalizeSubagentName(name, "");
  if (!normalized) return false;
  try {
    const roster = findRosterMember(rosterPath(artifactDir), normalized);
    if (!roster || roster.status !== "offline") return false;
  } catch (error) {
    debugLog(`Could not read team roster for member name reuse of ${normalized}`, error);
    return false;
  }
  if (Array.from(runningSubagents.values()).some((running) => running.name === normalized)) {
    return false;
  }
  if (reservedNames.has(normalized)) return false;
  return true;
}

/** roster 标记 offline(幂等:重复 upsert 同一 offline 状态无害)。 */
function markMemberOffline(running: RunningSubagent, reason: string): void {
  if (!running.rosterFile) return;
  try {
    upsertRosterMember(running.rosterFile, {
      name: running.name,
      ...(running.agent ? { agent: running.agent } : {}),
      sessionFile: running.sessionFile,
      ...(running.pid != null ? { pid: running.pid } : {}),
      status: "offline",
      offlineReason: reason,
    });
  } catch (error) {
    debugLog(`Could not mark team member ${running.name} offline`, error);
  }
}

/** 认领并注入成员间消息(fire-and-forget;注入文案带来源,不可冒名)。 */
function drainMemberMailbox(running: RunningSubagent): void {
  if (!running.rosterFile) return;
  const teamDir = dirname(running.rosterFile);
  const child = running.headlessChild;
  if (!child || child.exited) return;
  for (const message of claimTeamMessages(teamDir, running.name)) {
    // 防御:mailbox 目录名即目标;to 与成员名不符的残留文件直接丢弃。
    if (normalizeSubagentName(message.to, "") !== normalizeSubagentName(running.name, "")) continue;
    try {
      child.steer(`[team message from "${message.from}"] ${message.text}`);
    } catch (error) {
      debugLog(`Could not inject team message to ${running.name}`, error);
    }
  }
}

/** 轮次终态回注恰好一次(由 .round 认领/进程死亡互斥保证)。 */async function deliverMemberRoundResult(
  running: RunningSubagent,
  outcome: { exitCode: number; errorMessage?: string; roundSeq?: number },
): Promise<void> {
  const pi = latestPi;
  if (!pi) return;
  const elapsed = Math.floor((Date.now() - running.startTime) / 1000);
  let summary = "";
  let stats: NonNullable<SubagentResult["stats"]> | undefined;
  let sessionId: string | null = null;
  try {
    const extracted = await extractSubagentResult(
      running.sessionFile,
      { exitCode: outcome.exitCode, ...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}) },
      running.roundEntryBaseline ?? 0,
      "Team member round",
    );
    summary = extracted.summary;
    stats = extracted.stats ?? undefined;
    sessionId = extracted.sessionId;
  } catch (error) {
    debugLog(`Could not extract team member round result for ${running.name}`, error);
    summary = outcome.errorMessage ?? `Team member "${running.name}" finished its round (no extractable summary).`;
  }
  const failed = outcome.exitCode !== 0 || !!outcome.errorMessage;
  const routeException = failed ? routeExceptionFromResult({ errorMessage: outcome.errorMessage }, running.model) : undefined;
  pi.sendMessage(
    {
      customType: "subagent_result",
      content:
        `Team member "${running.name}" finished a round:\n\n${summary}`,
      display: true,
      details: {
        name: running.name,
        task: "(team member round)",
        agent: running.agent,
        exitCode: outcome.exitCode,
        elapsed,
        sessionFile: running.sessionFile,
        ...(sessionId ? { sessionId } : {}),
        status: failed ? "failed" : "completed",
        roundDelivery: "member-round",
        ...(outcome.roundSeq != null ? { roundSeq: outcome.roundSeq } : {}),
        ...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
        ...(stats ? { stats } : {}),
        ...(routeException ? { routeException } : {}),
        ...(running.cohortId ? { cohortId: running.cohortId } : {}),
      },
    },
    { triggerTurn: true, deliverAs: "steer" },
  );
}

type DispatchMarkerAssociation = "matched" | "absent" | "unreadable";
type MemberRoundConsumption = "delivered" | "not-associated" | "association-error";

/** 连续读不到会话 marker 时的最后兜底次数;到达后明确终止成员。 */
const MAX_ROUND_ASSOCIATION_RETRIES = 3;

/**
 * 读取派单 marker。将 JSON 解析失败与“没有 marker”分开,避免 atomic
 * claim 后把暂时不可读的 .round 当成自发轮而永久留下 busy 状态。
 */
function readDispatchMarkerAssociation(
  sessionFile: string,
  baseline: number,
  roundId: string,
): DispatchMarkerAssociation {
  const marker = teamRoundMarker(roundId);
  try {
    return getNewEntries(sessionFile, baseline).some((entry) => {
      if (entry.type !== "message") return false;
      const msg = (entry as MessageEntry).message;
      if (!msg || msg.role !== "user") return false;
      return (msg.content ?? []).some(
        (block) => typeof block.text === "string" && block.text.includes(marker),
      );
    }) ? "matched" : "absent";
  } catch (error) {
    debugLog(`Could not read session entries for round association of ${sessionFile}`, error);
    return "unreadable";
  }
}

/** 成员启动/轮次关联失败时统一清理并回注明确失败,不留下永久 busy。 */
async function finalizeMemberFailure(
  running: RunningSubagent,
  reason: string,
  errorMessage: string,
  roundSeq?: number,
): Promise<void> {
  const hadRound = running.dispatchedRound === true;
  const baseline = running.roundEntryBaseline;
  running.dispatchedRound = false;
  running.dispatchedRoundId = undefined;
  running.pendingRoundSignal = undefined;
  running.roundAssociationAttempts = 0;
  killMemberProcess(running);
  markMemberOffline(running, reason);
  runningSubagents.delete(running.id);
  removeRuntimeRecord(running.runtimeFile, running.id);
  settleCompletionFromResult(running.name, {
    exitCode: 1,
    errorMessage,
    sessionFile: running.sessionFile,
  });
  updateWidget();
  if (hadRound) {
    running.roundEntryBaseline = baseline;
    await deliverMemberRoundResult(running, {
      exitCode: 1,
      errorMessage,
      ...(roundSeq != null ? { roundSeq } : {}),
    });
  }
  running.roundEntryBaseline = undefined;
}

/** 自 baseline 起的会话用户消息里是否出现过该派单轮的 marker(轮次关联判定)。
 *
 * 时序不变量:成员在 agent_end 写 .round 时,本轮的用户消息(含派单
 * marker)已落盘——run 处理过派单消息才会结束。因此 marker 缺失只可能是
 * “派单 prompt 仍在队列里,这个 .round 属于自发轮”(消费但不回注),
 * 不存在“派单轮结束而 marker 尚未落盘”的窗口。
 */
function dispatchMarkerInSession(sessionFile: string, baseline: number, roundId: string): boolean {
  return readDispatchMarkerAssociation(sessionFile, baseline, roundId) === "matched";
}

/** 认领一个已落盘的派单轮结果;非当前派单轮的信号只消费、不回注。 */
async function consumeDispatchedMemberRound(
  running: RunningSubagent,
  round: { seq: number },
): Promise<MemberRoundConsumption> {
  if (!running.dispatchedRound) return "not-associated";
  // 轮次关联(nonce marker):交错的成员自发轮不能误清当前派单状态。
  const association = running.dispatchedRoundId
    ? readDispatchMarkerAssociation(
        running.sessionFile,
        running.roundEntryBaseline ?? 0,
        running.dispatchedRoundId,
      )
    : "matched" as const;
  if (association === "unreadable") return "association-error";
  if (association === "absent") return "not-associated";

  running.dispatchedRound = false;
  running.dispatchedRoundId = undefined;
  if (running.rosterFile) {
    try {
      upsertRosterMember(running.rosterFile, {
        name: running.name,
        ...(running.agent ? { agent: running.agent } : {}),
        sessionFile: running.sessionFile,
        ...(running.pid != null ? { pid: running.pid } : {}),
        status: "idle",
        lastRoundAt: Date.now(),
      });
    } catch (error) {
      debugLog(`Could not mark team member ${running.name} idle`, error);
    }
  }
  await deliverMemberRoundResult(running, { exitCode: 0, roundSeq: round.seq });
  return "delivered";
}

/** 处理已认领的轮次信号:短暂读失败时保留信号,最终明确失败。 */
async function handleMemberRoundSignal(
  running: RunningSubagent,
  round: { name: string; seq: number; at: number },
): Promise<"handled" | "retry" | "failed"> {
  const consumption = await consumeDispatchedMemberRound(running, round);
  if (consumption !== "association-error") {
    running.pendingRoundSignal = undefined;
    running.roundAssociationAttempts = 0;
    return "handled";
  }

  const attempts = (running.roundAssociationAttempts ?? 0) + 1;
  if (attempts < MAX_ROUND_ASSOCIATION_RETRIES) {
    running.pendingRoundSignal = round;
    running.roundAssociationAttempts = attempts;
    debugLog(
      `Deferring team member ${running.name} round ${round.seq} after unreadable session association ` +
        `(attempt ${attempts}/${MAX_ROUND_ASSOCIATION_RETRIES})`,
    );
    return "retry";
  }

  const errorMessage =
    `Could not reliably associate team member "${running.name}" round ${round.seq} with its ` +
    `dispatch marker because the session file could not be read. The member was taken offline ` +
    `instead of silently dropping the round; resume or respawn it if the work still matters.`;
  await finalizeMemberFailure(running, "round-association-failed", errorMessage, round.seq);
  return "failed";
}

/**
 * 成员 round watcher(fire-and-forget):常驻轮询 .ask/.round/mailbox 与进程
 * 存活。轮次结束仅在「有在途 dispatch 且 .round 确实属于该派单轮」时回注
 * 一次(idle 期的自发轮、与在途派单交错的自发轮都不回注、不打扰主 pane);
 * 进程死亡 → 先认领已落盘的 .round,再把仍未完成的在途轮次报错;模块替换
 * (/reload)→ 终止成员并降级 offline(stdin 无法重接,不留永活孤儿)。
 * watcher 由 running.abortController(subagent_stop/session_shutdown)终止,
 * 终止责任在各自入口(stop/shutdown 直接 kill+offline)。
 */
async function watchMemberRound(running: RunningSubagent, signal: AbortSignal): Promise<void> {
  const combined = AbortSignal.any([signal, getModuleAbortSignal()]);
  for (;;) {
    if (combined.aborted) return; // stop/session_shutdown 入口已负责 kill+offline
    const moduleWasReplaced = (globalThis as any)[MODULE_INSTANCE_KEY] !== moduleInstanceId;
    if (moduleWasReplaced) {
      killMemberProcess(running);
      markMemberOffline(running, "host-reload");
      runningSubagents.delete(running.id);
      removeRuntimeRecord(running.runtimeFile, running.id);
      return;
    }

    const child = running.headlessChild;
    if (child?.promptError) {
      const errorMessage =
        `Headless team member "${running.name}" rejected its prompt: ${child.promptError}`;
      await finalizeMemberFailure(running, "prompt-rejected", errorMessage);
      return;
    }
    const alive = child ? !child.exited : running.pid != null && isPidAlive(running.pid);
    if (!alive) {
      // 进程可能在写完 .round 与会话结果后才退出。若上一次 marker 读取
      // 正在重试,优先使用内存保留的信号,再认领新信号。
      const round = running.pendingRoundSignal ?? claimRoundSignal(running.sessionFile);
      if (round) {
        const consumption = await consumeDispatchedMemberRound(running, round);
        running.pendingRoundSignal = undefined;
        running.roundAssociationAttempts = 0;
        if (consumption === "association-error") {
          const errorMessage =
            `Could not reliably associate team member "${running.name}" round ${round.seq} with its ` +
            `dispatch marker because the session file could not be read. The member was taken offline ` +
            `instead of silently dropping the round; resume or respawn it if the work still matters.`;
          await finalizeMemberFailure(running, "round-association-failed", errorMessage, round.seq);
          return;
        }
      }
      const unfinishedRound = running.dispatchedRound === true;
      const baseline = running.roundEntryBaseline;
      running.dispatchedRound = false;
      running.dispatchedRoundId = undefined;
      running.pendingRoundSignal = undefined;
      running.roundAssociationAttempts = 0;

      markMemberOffline(running, "process-exited");
      runningSubagents.delete(running.id);
      removeRuntimeRecord(running.runtimeFile, running.id);
      if (unfinishedRound) {
        running.roundEntryBaseline = baseline;
        await deliverMemberRoundResult(running, {
          exitCode: 1,
          errorMessage: `Team member "${running.name}" process exited before finishing its in-flight round. ` +
            `Its session is preserved; resume or respawn it if the work still matters.`,
        });
      }
      running.roundEntryBaseline = undefined;
      return;
    }

    deliverPendingQuestion(running);
    drainMemberMailbox(running);

    // 读失败时保留已认领的信号并有限重试;超过上限转为明确 offline/失败,
    // 不把成员留在永久 busy 状态,也不静默吞掉真实轮次。
    const round = running.pendingRoundSignal ?? claimRoundSignal(running.sessionFile);
    if (round) {
      const outcome = await handleMemberRoundSignal(running, round);
      if (outcome === "failed") return;
      // 无在途 dispatch 的 .round(如成员间消息触发的自发轮):不回注、
      // 不打扰主 pane——成员间通信的结果属于成员自己的对话流。
    }

    await new Promise<void>((resolve, reject) => {
      if (combined.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        combined.removeEventListener("abort", onAbort);
        resolve();
      }, 1000);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      combined.addEventListener("abort", onAbort, { once: true });
    }).catch(() => {});
    if (combined.aborted) return;
  }
}

function deliverPendingQuestion(running: RunningSubagent): void {
  const askFile = `${running.sessionFile}.ask`;
  const claimedAskFile = `${askFile}.${process.pid}.${randomUUID()}.processing`;
  let payload: PendingQuestion | null = null;
  try {
    // Atomic rename claims the signal before reading it. If the host dies after
    // reading, the original .ask file is already gone and a newer signal can
    // still be written to the original path for the next poll.
    renameSync(askFile, claimedAskFile);
    payload = JSON.parse(readFileSync(claimedAskFile, "utf-8")) as PendingQuestion;
  } catch (error) {
    if (existsSync(askFile)) {
      // The writer may still be replacing the sidecar; leave it for the next tick.
      debugLog(`Could not claim question sidecar for ${running.name}`, error);
    }
  } finally {
    try {
      unlinkSync(claimedAskFile);
    } catch (error) {
      if (existsSync(claimedAskFile)) debugLog(`Could not remove claimed question sidecar for ${running.name}`, error);
    }
  }
  if (typeof payload?.question !== "string" || !payload.question.trim()) return;

  const name = running.name; // unique per session (deduped at spawn) — targets the reply
  const sessionId = existsSync(running.sessionFile) ? getSessionId(running.sessionFile) : null;
  const elapsed = Math.floor((Date.now() - running.startTime) / 1000);
  const replyHint = `\n\nReply with subagent_message({ name: "${name}", message: "…" }) — the same name works whether it is still running or has since exited. It stays open until you reply.`;

  latestPi?.sendMessage(
    {
      customType: "subagent_question",
      content: `Sub-agent "${name}" asks (${formatElapsed(elapsed)}):\n\n${payload.question}${replyHint}`,
      display: true,
      details: {
        name,
        agent: running.agent,
        question: payload.question,
        ...(sessionId ? { sessionId } : {}),
      },
    },
    { triggerTurn: true, deliverAs: "steer" },
  );
}

/**
 * headless watcher:等待独立 RPC 进程到终态。与 pane watcher(pollForExit
 * 读屏 + sentinel)不同,终态信号是进程退出——auto-exit 子代理完成任务后
 * subagent-done 置 shutdown → RPC 进程 exit;ask 等待与等待孙代理结果时
 * shutdown 被抑制,进程保持存活,与 pane 的 sentinel 等待语义对齐。
 * 每 tick 同时观察 activity 快照与 .ask sidecar,与 pane 路径一致。
 */
async function waitForHeadlessExit(
  running: RunningSubagent,
  signal: AbortSignal,
): Promise<PollResult> {
  const start = Date.now();
  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    const child = running.headlessChild;
    if (child) {
      if (child.promptError) {
        child.kill();
        await child.exitPromise.catch(() => {});
        deliverPendingQuestion(running);
        return {
          reason: "error",
          exitCode: 1,
          errorMessage: `Headless sub-agent "${running.name}" rejected its initial prompt: ${child.promptError}`,
        };
      }
      if (child.exited) {
        const info = await child.exitPromise;
        // 终态返回前最后消费一次 .ask:子代理可能在退出前夕刚写入问题
        // (如 barrier checkpoint 后被外部 kill),不消费就永远丢失。
        deliverPendingQuestion(running);
        // 先查 .exit sidecar(subagent-done 错误路径),再按退出码判定。
        const sidecar = readExitSidecar(running.sessionFile);
        if (sidecar) return sidecar;
        if ((info.code ?? 1) !== 0) {
          return {
            reason: "error",
            exitCode: info.code ?? 1,
            errorMessage:
              `Headless sub-agent process exited with code ${info.code ?? "null"}` +
              `${info.signal ? ` (signal ${info.signal})` : ""}.`,
          };
        }
        return { reason: "done", exitCode: 0 };
      }
    } else {
      // /reload 降级模式:stdin 已丢失,收不到 RPC 事件,只能轮询 PID。
      // 此刻退出码不可知:优先 .exit sidecar,否则按正常完成处理(结果从
      // session 文件提取;若实际是崩溃,最后 assistant 消息会反映实况)。
      const pid = running.pid ?? parseHeadlessSurface(running.surface);
      if (pid == null || !isPidAlive(pid)) {
        // 降级终态返回前同样最后消费一次 .ask(此前 tick 消费之后写入的
        // 问题在进程消失后不会再有机会投递)。
        deliverPendingQuestion(running);
        const sidecar = readExitSidecar(running.sessionFile);
        return sidecar ?? { reason: "done", exitCode: 0 };
      }
    }

    observeRunningSubagent(running);
    deliverPendingQuestion(running);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, 1000);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

// ── watcher 失败分类 ─────────────────────────────────────────────────────
// 把“等待循环被中止”按来源分到四种处置,是杀进程/回注/保留记录的唯一决策点:
//   reload-handoff :模块被 /reload 替换——进程与 runtime record 全保留,
//                   由新模块的恢复路径接管(真实结果稍后回注)。
//   session-detach :宿主会话关闭(/new、/resume 切走、退出 pi)——同样保留
//                   进程与 record,不杀不删;回到本会话时 recover 接管。
//                   切换期间结果不会自动注入其它会话,这是诚实的降级边界。
//   cancelled      :watcher 自身 signal 被显式 abort——现在只来自
//                   subagent_stop(唯一显式停止入口):杀进程/关 pane、
//                   删 runtime record、兑 cancelled 终态。
//   error          :其它意外错误:杀进程/关 pane、删 record、兑失败结果。
// 工具层的 Escape 中止不 abort watcher(见 subagent-tool.ts),不会落到
// cancelled——子代理继续运行,等待路径转为 detached 迟到回注。
export type WatcherFailureKind = "reload-handoff" | "session-detach" | "cancelled" | "error";

export function classifyWatcherFailure(input: {
  moduleReplaced: boolean;
  moduleAbortAborted: boolean;
  watcherSignalAborted: boolean;
}): WatcherFailureKind {
  if (input.moduleReplaced) return "reload-handoff";
  if (input.moduleAbortAborted) return "session-detach";
  if (input.watcherSignalAborted) return "cancelled";
  return "error";
}

async function watchHeadlessSubagent(
  running: RunningSubagent,
  signal: AbortSignal,
): Promise<SubagentResult> {
  const { name, task, startTime, sessionFile } = running;
  const cohortDetails = running.cohortId ? { cohortId: running.cohortId } : {};

  try {
    const result = await waitForHeadlessExit(running, AbortSignal.any([signal, getModuleAbortSignal()]));
    const elapsed = Math.floor((Date.now() - startTime) / 1000);

    const extracted = await extractSubagentResult(sessionFile, result);

    runningSubagents.delete(running.id);
    removeRuntimeRecord(running.runtimeFile, running.id);
    // 进程通常已自行退出;降级/竞态残留的句柄 best-effort 回收。
    try {
      running.headlessChild?.kill();
    } catch (error) {
      debugLog(`Could not dispose completed headless child ${running.surface}`, error);
    }

    return {
      name,
      task,
      summary: extracted.summary,
      sessionFile,
      ...cohortDetails,
      ...(extracted.sessionId ? { sessionId: extracted.sessionId } : {}),
      exitCode: result.exitCode,
      elapsed,
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
      ...(extracted.stats ? { stats: extracted.stats } : {}),
    };
  } catch (err: any) {
    const moduleWasReplaced = (globalThis as any)[MODULE_INSTANCE_KEY] !== moduleInstanceId;
    const failureKind = classifyWatcherFailure({
      moduleReplaced: moduleWasReplaced,
      moduleAbortAborted: getModuleAbortSignal().aborted,
      watcherSignalAborted: signal.aborted,
    });
    runningSubagents.delete(running.id);
    if (failureKind === "reload-handoff" || failureKind === "session-detach") {
      // /reload 移交或宿主会话关闭:进程还在跑,保留 runtime record 交给
      // 恢复逻辑接管。绝不伪造 cancelled/failed 结果,显式 handed-off 语义:
      // 调用方只报“已移交,真实结果稍后回注”,不重复回注。
      return {
        name,
        task,
        summary:
          failureKind === "reload-handoff"
            ? "Subagent handed off to recovery after host reload; it is still running and " +
              "its real result will be delivered when it finishes."
            : "Subagent detached because the host session was closed or switched away; it is " +
              "still running and its real result will be recovered when this session returns.",
        exitCode: 0,
        elapsed: Math.floor((Date.now() - startTime) / 1000),
        sessionFile,
        ...cohortDetails,
        handedOff: true,
      };
    }
    // cancelled(显式 stop)与 error:headless 全是自动子代理,两种都要
    // 终止进程并移除 runtime record;区别只在结果语义。
    const child = running.headlessChild;
    try {
      if (child) {
        if (!child.exited) child.abort();
        child.kill();
      } else if (running.pid != null) {
        terminateHeadlessProcess(running.pid);
      }
    } catch (error) {
      debugLog(`Could not kill ${failureKind === "cancelled" ? "stopped" : "failed"} headless child ${running.surface}`, error);
    }
    removeRuntimeRecord(running.runtimeFile, running.id);
    if (failureKind === "cancelled") {
      return {
        name,
        task,
        summary: "Subagent stopped.",
        exitCode: 1,
        elapsed: Math.floor((Date.now() - startTime) / 1000),
        sessionFile,
        ...cohortDetails,
        stopped: true,
      };
    }
    return {
      name,
      task,
      summary: `Subagent error: ${err?.message ?? String(err)}`,
      exitCode: 1,
      elapsed: Math.floor((Date.now() - startTime) / 1000),
      ...cohortDetails,
      errorMessage: err?.message ?? String(err),
    };
  }
}

async function watchSubagent(
  running: RunningSubagent,
  signal: AbortSignal,
): Promise<SubagentResult> {
  if (running.kind === "headless") return watchHeadlessSubagent(running, signal);
  const { name, task, surface, startTime, sessionFile } = running;
  const cohortDetails = running.cohortId ? { cohortId: running.cohortId } : {};

  try {
    const result = await pollForExit(surface, AbortSignal.any([signal, getModuleAbortSignal()]), {
      interval: 1000,
      sessionFile,
      sentinelToken: running.sentinelToken,
      onTick() {
        observeRunningSubagent(running);
        deliverPendingQuestion(running);
      },
    });

    const elapsed = Math.floor((Date.now() - startTime) / 1000);

    const extracted = await extractSubagentResult(sessionFile, result);
    const summary = extracted.summary;
    const stats = extracted.stats;
    const subagentSessionId = extracted.sessionId;

    runningSubagents.delete(running.id);
    removeRuntimeRecord(running.runtimeFile, running.id);
    // 结果已经从 session 文件取得，pane 清理失败不应覆盖真实结果。用户
    // 直接关闭 pane(user_closed)时 closeSurface 抛错是预期路径,同样不影响。
    try {
      closeSurface(surface);
    } catch (error) {
      // pane 可能已被外部关闭；不会影响结果回注。
      debugLog(`Could not close completed pane ${surface}`, error);
    }

    // 显式停止后 pane 消失:按显式 cancelled 终态处理,不误报 user_closed。
    if (running.stopRequested && result.reason === "user_closed") {
      return {
        name,
        task,
        summary: "Subagent stopped.",
        exitCode: 1,
        elapsed,
        sessionFile,
        ...cohortDetails,
        stopped: true,
      };
    }
    return {
      name,
      task,
      summary,
      sessionFile,
      ...cohortDetails,
      ...(subagentSessionId ? { sessionId: subagentSessionId } : {}),
      exitCode: result.exitCode,
      elapsed,
      ...(result.reason === "user_closed" ? { userClosed: true } : {}),
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
      ...(stats ? { stats } : {}),
    };
  } catch (err: any) {
    const moduleWasReplaced = (globalThis as any)[MODULE_INSTANCE_KEY] !== moduleInstanceId;
    const failureKind = classifyWatcherFailure({
      moduleReplaced: moduleWasReplaced,
      moduleAbortAborted: getModuleAbortSignal().aborted,
      watcherSignalAborted: signal.aborted,
    });
    runningSubagents.delete(running.id);
    if (failureKind === "reload-handoff" || failureKind === "session-detach") {
      // /reload 移交或宿主会话关闭:pane 与 runtime record 全保留,交给恢复
      // 逻辑接管;不伪造 cancelled/failed,也不在此回注,显式 handed-off。
      return {
        name,
        task,
        summary:
          failureKind === "reload-handoff"
            ? "Subagent handed off to recovery after host reload; it is still running and " +
              "its real result will be delivered when it finishes."
            : "Subagent detached because the host session was closed or switched away; it is " +
              "still running and its real result will be recovered when this session returns.",
        exitCode: 0,
        elapsed: Math.floor((Date.now() - startTime) / 1000),
        sessionFile,
        ...cohortDetails,
        handedOff: true,
      };
    }
    // cancelled(显式 stop)与 error:自动 pane 由 watcher 统一关闭并移除
    // record;交互式 pane 归用户驱动——但 subagent_stop 的显式停止已在 stop
    // 入口直接关闭 pane,这里不再重复关闭(且归属护栏在 closeSurface 内)。
    if (!running.interactive) {
      try {
        closeSurface(surface);
      } catch (error) {
        debugLog(`Could not close cancelled pane ${surface}`, error);
      }
    }
    if (!(signal.aborted && running.interactive)) {
      removeRuntimeRecord(running.runtimeFile, running.id);
    }
    if (failureKind === "cancelled") {
      return {
        name,
        task,
        summary: "Subagent stopped.",
        exitCode: 1,
        elapsed: Math.floor((Date.now() - startTime) / 1000),
        sessionFile,
        ...cohortDetails,
        stopped: true,
      };
    }
    return {
      name,
      task,
      summary: `Subagent error: ${err?.message ?? String(err)}`,
      exitCode: 1,
      elapsed: Math.floor((Date.now() - startTime) / 1000),
      ...cohortDetails,
      errorMessage: err?.message ?? String(err),
    };
  }
}

/** 重载后从运行态记录恢复 watcher，避免同一 session 被重复启动。 */
async function recoverRuntimeSubagents(
  ctx: { sessionManager: { getSessionId(): string; getSessionDir(): string } },
  pi: ExtensionAPI,
): Promise<void> {
  const runtimeFile = runtimeRegistryPath(
    getArtifactDir(ctx.sessionManager.getSessionDir(), ctx.sessionManager.getSessionId()),
  );
  for (const record of readRuntimeRecords(runtimeFile)) {
    if (runningSubagents.has(record.id)) continue;
    // 单条隔离:某条记录恢复失败(如 pane adoptSurface 在无复用器环境下
    // 抛错、或会话文件损坏)只跳过该记录,不中断后续记录的恢复。
    try {

    if ((record.kind ?? "pane") === "headless") {
      // headless 恢复:/reload 后 RPC stdin 已丢失,无法重新接管——这是显式
      // 降级边界。进程已退出:直接提取结果回注;仍在运行:标记 stdinLost,
      // watcher 轮询 PID 直到进程消失,期间 steer 与 ask 回复不可达(报错提示)。
      const pid = record.pid ?? parseHeadlessSurface(record.surface);
      // 持久成员:stdin 无法重接(常驻进程不退出,PID 轮询会永久空转)——
      // 诚实降级:终止进程、移除运行态、roster 标记 offline,session 保留
      // 供显式 resume(subagent_message)或重新 spawn(member: true)。
      if (record.member) {
        if (pid != null && isPidAlive(pid)) {
          terminateHeadlessProcess(pid);
        }
        try {
          const memberRosterFile = rosterPath(dirname(runtimeFile));
          const existingRoster = findRosterMember(memberRosterFile, record.name);
          const offlineReason =
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
        removeRuntimeRecord(runtimeFile, record.id);
        continue;
      }
      if (pid == null || !isPidAlive(pid)) {
        removeRuntimeRecord(runtimeFile, record.id);
        const exit = readExitSidecar(record.sessionFile) ?? { reason: "done" as const, exitCode: 0 };
        const routeModel = readSubagentLoadout(record.sessionFile)?.model ?? null;
        try {
          const extracted = await extractSubagentResult(
            record.sessionFile,
            { exitCode: exit.exitCode, ...(exit.errorMessage ? { errorMessage: exit.errorMessage } : {}) },
          );
          const elapsedForRecord = Math.max(0, Math.floor((Date.now() - record.startTime) / 1000));
          const exitResult = {
            summary: extracted.summary,
            sessionFile: record.sessionFile,
            ...(record.cohortId ? { cohortId: record.cohortId } : {}),
            ...(extracted.sessionId ? { sessionId: extracted.sessionId } : {}),
            exitCode: exit.exitCode,
            elapsed: elapsedForRecord,
            ...(exit.errorMessage ? { errorMessage: exit.errorMessage } : {}),
            ...(extracted.stats ? { stats: extracted.stats } : {}),
          };
          const routeException = routeExceptionFromResult(exitResult, routeModel);
          // reload 前登记的完成记录(若有等待者)在此兑为终态。
          settleCompletionFromResult(record.name, exitResult);
          const presentation = resolveResultPresentation(exitResult, record.name);
          pi.sendMessage(
            {
              customType: "subagent_result",
              content: presentation,
              display: true,
              details: {
                name: record.name,
                task: record.task,
                agent: record.agent,
                exitCode: exit.exitCode,
                elapsed: elapsedForRecord,
                sessionFile: record.sessionFile,
                ...(record.cohortId ? { cohortId: record.cohortId } : {}),
                recovered: "headless-exited",
                ...(extracted.sessionId ? { sessionId: extracted.sessionId } : {}),
                ...(exit.errorMessage ? { errorMessage: exit.errorMessage } : {}),
                ...(extracted.stats ? { stats: extracted.stats } : {}),
                ...(routeException ? { routeException } : {}),
              },
            },
            { triggerTurn: true, deliverAs: "steer" },
          );
        } catch (error) {
          debugLog(`Could not recover finished headless subagent ${record.name}`, error);
        }
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
      runningSubagents.set(running.id, running);
      const watcherAbort = new AbortController();
      running.abortController = watcherAbort;
      watchSubagent(running, watcherAbort.signal)
        .then((result) => {
          updateWidget();
          settleCompletionFromResult(running.name, result);
          // 恢复 watcher 自己又赶上 /reload:再次移交,真实结果由更新后的
          // 模块在下次 session_start 恢复接管,本次不回注,避免伪造/重复结果。
          if (result.handedOff) return;
          const routeException = routeExceptionFromResult(result, running.model);
          const presentation = resolveResultPresentation(result, running.name);
          pi.sendMessage(
            {
              customType: "subagent_result",
              content: presentation,
              display: true,
              details: {
                name: running.name,
                task: running.task,
                agent: running.agent,
                exitCode: result.exitCode,
                elapsed: result.elapsed,
                sessionFile: result.sessionFile,
                ...(running.cohortId ? { cohortId: running.cohortId } : {}),
                recovered: "headless-degraded",
                ...(result.sessionId ? { sessionId: result.sessionId } : {}),
                ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
                ...(result.stats ? { stats: result.stats } : {}),
                ...(routeException ? { routeException } : {}),
              },
            },
            { triggerTurn: true, deliverAs: "steer" },
          );
        })
        .catch((error) => {
          updateWidget();
          settleCompletionFromResult(running.name, { exitCode: 1, errorMessage: error?.message ?? String(error) });
          pi.sendMessage(
            {
              customType: "subagent_result",
              content: `Recovered headless sub-agent "${running.name}" error: ${error?.message ?? String(error)}`,
              display: true,
              details: {
                name: running.name,
                task: running.task,
                ...(running.cohortId ? { cohortId: running.cohortId } : {}),
                error: error?.message,
              },
            },
            { triggerTurn: true, deliverAs: "steer" },
          );
        });
      continue;
    }

    if (!adoptSurface(record.surface)) {
      removeRuntimeRecord(runtimeFile, record.id);
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
    runningSubagents.set(running.id, running);
    const watcherAbort = new AbortController();
    running.abortController = watcherAbort;
    watchSubagent(running, watcherAbort.signal)
      .then((result) => {
        updateWidget();
        // 用户直接关闭 pane 是稳定终态(user_closed),同样要 settle 依赖
        // 记录(按 cancelled 语义),等待者不永久挂起。
        settleCompletionFromResult(running.name, result, {
          ...(result.userClosed ? { status: "cancelled" as const } : {}),
        });
        // 恢复 watcher 自己又赶上 /reload:再次移交,本次不回注(同 headless 分支)。
        if (result.handedOff) return;
        const routeException = routeExceptionFromResult(result, running.model);
        const presentation = resolveResultPresentation(result, running.name);
        pi.sendMessage(
          {
            customType: "subagent_result",
            content: presentation,
            display: true,
            details: {
              name: running.name,
              task: running.task,
              agent: running.agent,
              exitCode: result.exitCode,
              elapsed: result.elapsed,
              sessionFile: result.sessionFile,
              ...(running.cohortId ? { cohortId: running.cohortId } : {}),
              recovered: "pane",
              ...(result.userClosed ? { userClosed: true } : {}),
              ...(result.sessionId ? { sessionId: result.sessionId } : {}),
              ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
              ...(result.stats ? { stats: result.stats } : {}),
              ...(routeException ? { routeException } : {}),
            },
          },
          { triggerTurn: true, deliverAs: "steer" },
        );
      })
      .catch((error) => {
        updateWidget();
        settleCompletionFromResult(running.name, { exitCode: 1, errorMessage: error?.message ?? String(error) });
        pi.sendMessage(
          {
            customType: "subagent_result",
            content: `Recovered sub-agent "${running.name}" error: ${error?.message ?? String(error)}`,
            display: true,
            details: {
              name: running.name,
              task: running.task,
              ...(running.cohortId ? { cohortId: running.cohortId } : {}),
              error: error?.message,
            },
          },
          { triggerTurn: true, deliverAs: "steer" },
        );
      });
    } catch (error) {
      // 单条隔离兑底:该记录的恢复失败被记录并跳过,循环继续处理后续记录。
      debugLog(`Could not recover runtime subagent record ${record.id} (${record.name})`, error);
    }
  }
  if (runningSubagents.size > 0) {
    startWidgetRefresh();
    startStatusRefresh(pi);
  }
}

export default function subagentsExtension(pi: ExtensionAPI, options?: SubagentsExtensionOptions) {
  configureSubagentsExtension(options ?? {});
  latestPi = pi;
  // Capture the UI context for widget updates
  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx;
    // pi runs multiple sessions in one process. A prior session's shutdown
    // aborts the shared module poll-abort controller; install a fresh one so
    // subagents spawned in this session aren't watched against a dead signal.
    // See https://github.com/HazAT/pi-interactive-subagents/issues/5
    const prevAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
    if (!prevAbort || prevAbort.signal.aborted) {
      (globalThis as any)[POLL_ABORT_KEY] = new AbortController();
    }
    recoverRuntimeSubagents(ctx, pi).catch((error) => {
      debugLog("Runtime subagent recovery failed", error);
    });
  });

  // Clean up on session shutdown
  // 区分关闭来源(与 watcher 的 classifyWatcherFailure 配合):
  //   - /reload:模块替换,reload-handoff——现有恢复路径接管,无特殊处理。
  //   - /new、/resume 切会话、退出 pi:session-detach——自动子代理不杀:
  //     进程/pane 与 runtime record 全保留;回到本会话时 recover 接管
  //     (已退出 → 提取结果回注;仍在跑 → PID 轮询降级/pane 重新接管)。
  //     切换期间结果不会自动注入其它会话——这是诚实的降级边界,不伪称跨会话回传。
  //   - 交互式演示 pane 归用户所有:一律不动,留给用户自行处理。
  // 工具层的 Escape 中止不经过这里(它只解除工具等待,子代理转 detached)。
  pi.on("session_shutdown", (_event, _ctx) => {
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
      (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
    }
    if (statusInterval) {
      clearInterval(statusInterval);
      statusInterval = null;
      (globalThis as any)[STATUS_INTERVAL_KEY] = null;
    }
    const moduleAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
    if (moduleAbort) moduleAbort.abort();
    for (const [_id, agent] of runningSubagents) {
      if (agent.interactive) {
        // 交互式子代理归用户所有,宿主会话关闭时不强杀其 pane,留给用户自行处理。
        continue;
      }
      if (agent.member) {
        // 持久成员是永活进程(不 auto-exit):不能像普通自动子代理那样 detach
        // 留孤儿——安全终止并 roster 标记 offline;session/loadout 保留供显式 resume。
        killMemberProcess(agent);
        markMemberOffline(agent, "host-shutdown");
        removeRuntimeRecord(agent.runtimeFile, agent.id);
        agent.abortController?.abort();
        continue;
      }
      // A /reload-recovered headless child has no live stdin handle. Abort the
      // watcher and explicitly terminate its recorded PID so an ask_question
      // parked process cannot become an orphan after the host shuts down.
      // (stdinLost 进程无人可再接管,显式终止防泄漏;有句柄的子进程交给
      // watcher 的 session-detach 分支保留存活。)
      if (agent.kind === "headless" && !agent.headlessChild && agent.pid != null) {
        terminateHeadlessProcess(agent.pid);
      }
      // 中止 watcher 的等待循环:watcher 判定 session-detach 后保留进程与
      // runtime record(不杀不删),交给本会话的恢复路径接管。
      agent.abortController?.abort();
    }
    runningSubagents.clear();
  });

  // The spawning tools are always registered here. Whether a child process can
  // actually see/use them is governed by the parent's `--tools` allowlist and
  // by Pi's normal extension discovery in the child's inherited config/cwd
  // (+ explicit -e for parent-registered custom tools). See launchSubagent().

  registerSubagentTool(pi, {
    allowlist: SUBAGENT_ALLOWLIST,
    discoverAgents: discoverAgentDefinitions,
    isMuxAvailable,
    muxUnavailableResult,
    resolveSurfaceChoice: (params) => {
      const agentDefs = params.agent ? loadAgentDefaults(params.agent) : null;
      const lifecycleError = validateAgentLifecycleConfig(agentDefs);
      if (lifecycleError) return { error: lifecycleError };
      const interactive = resolveEffectiveInteractive(params as SubagentParams, agentDefs);
      return resolveSurfaceChoice(params.surface, interactive);
    },
    getArtifactDir,
    runningSubagents,
    reservedNames,
    resolveInteractive: (params) => {
      const agentDefs = params.agent ? loadAgentDefaults(params.agent) : null;
      return resolveEffectiveInteractive(params as SubagentParams, agentDefs);
    },
    uniqueRunningName,
    launchSubagent,
    canReuseMemberName: (name: string, artifactDir: string) => canReuseMemberName(name, artifactDir),
    startWidgetRefresh,
    startStatusRefresh,
    watchSubagent,
    watchMemberRound,
    updateWidget,
    resolveResultPresentation,
  });

  registerSubagentMessageTool(pi, {
    isMuxAvailable,
    muxUnavailableResult,
    resolveSurfaceChoice: (params) => resolveSurfaceChoice(params.surface, false),
    spawnHeadlessPi,
    runningSubagents,
    reservedNames,
    handleSubagentSteer,
    getArtifactDir,
    readNameRegistry,
    resolveNameInRegistry,
    getSessionId,
    readSubagentLoadout,
    readAnchoredLoadout,
    getAgentConfigDir,
    validateResumeTarget,
    countSessionEntryLines,
    getSubagentActivityFile,
    createSurface,
    shellEscape,
    subagentsDir: SUBAGENTS_DIR,
    applySandboxToParts,
    getShellReadyDelayMs,
    sendCommand,
    closeSurface,
    resolveResumeLaunchBehavior,
    runtimeRegistryPath,
    upsertRuntimeRecord,
    removeRuntimeRecord,
    startWidgetRefresh,
    startStatusRefresh,
    watchSubagent,
    updateWidget,
    extractSubagentResult,
    resolveResultPresentation,
  });

  registerSubagentsListTool(pi, {
    discoverAgents: discoverAgentDefinitions,
    getArtifactDir,
    runningSubagents,
    readNameRegistry,
    readSubagentLoadout,
    readRuntimeRecords,
    runtimeRegistryPath,
  });
  registerSubagentInspectTool(pi, {
    runningSubagents,
    observeRunningSubagent,
    getArtifactDir,
    readNameRegistry,
    readSubagentLoadout,
    readRuntimeRecords,
    runtimeRegistryPath,
    isPidAlive,
    probeSurface,
    readRosterMember: (name, artifactDir) => {
      const member = findRosterMember(rosterPath(artifactDir), name);
      return member
        ? {
            status: member.status,
            ...(member.offlineReason ? { offlineReason: member.offlineReason } : {}),
            ...(member.dispatchedAt != null ? { dispatchedAt: member.dispatchedAt } : {}),
            ...(member.lastRoundAt != null ? { lastRoundAt: member.lastRoundAt } : {}),
          }
        : null;
    },
  });
  // 旧 `/subagent` 命令：合并决策 5 后产品不再注册，只在显式开启时注册
  // （保留代码路径与自测覆盖，避免“功能静默消失”）。
  if (hostOptions.registerCommand === true) {
    registerSubagentCommand(pi, loadAgentDefaults);
  }
  registerSubagentRenderers(pi);
  registerSubagentStopTool(pi, {
    resolveRunningByName,
    closeSurface,
    updateWidget,
    stopMember: (running) => {
      // 持久成员的 watcher 不兑终态(进程常驻):stop 入口直接终止 + offline,
      // 并移除运行态登记;session/loadout/roster 保留(offline 状态)供追溯。
      killMemberProcess(running);
      markMemberOffline(running, "stopped");
      runningSubagents.delete(running.id);
      removeRuntimeRecord(running.runtimeFile, running.id);
      running.abortController?.abort();
    },
  });
  registerTeamDispatchTool(pi, {
    runningSubagents,
    getArtifactDir,
    rosterPath,
    findRosterMember,
    upsertRosterMember,
    countSessionEntryLines,
  });
}
