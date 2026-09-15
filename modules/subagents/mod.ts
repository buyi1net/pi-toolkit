import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
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
  adoptSurface,
  probeSurface,
  readExitSidecar,
  type PollResult,
} from "./surface.ts";
import {
  isPidAlive,
  parseHeadlessSurface,
  spawnHeadlessPi,
  terminateHeadlessProcess,
} from "./headless.ts";

import {
  countSessionEntryLines,
  getSessionId,
  getNewEntries,
  readNameRegistry,
  readSubagentLoadout,
  type MessageEntry,
  type SubagentLoadout,
} from "./session.ts";
import {
  type StatusSnapshot,
  type StatusLivenessEvidence,
  advanceStatusState,
  capStatusLines,
  forceStatusAfterInterrupt,
  observeStatus,
  loadStatusConfig,
} from "./status.ts";
import { createSessionFileLivenessProbe } from "./liveness.ts";
import {
  activeScopeLabel,
  formatStatusAggregate,
  formatTransitionLine,
  statusLabelText,
} from "./status-lines.ts";
import { subagentsTableTranslator, type SubagentsTranslate } from "./messages/index.ts";
import type { Translator } from "../../i18n/index.ts";
import {
  activityDisplayLabel,
  isTerminalDoneActivity,
  readSubagentActivityFile,
  type ActivityReadResult,
} from "./activity.ts";
import {
  discoverAgentDefinitions as discoverAgents,
  loadAgentDefaults as loadAgentDefaultsFrom,
  type AgentDefaults,
} from "./agents.ts";
import { normalizeSubagentName, sanitizeSubagentFileName } from "./names.ts";
import {
  buildFirstLayerOnlySnapshot,
  createDescendantsTracker,
  isWithin,
  type DescendantsTracker,
  type WidgetSnapshot,
} from "./descendants.ts";
import { withUsageRecording } from "./usage-bridge.ts";
import type { UsageRunEvent } from "../usage/api.ts";
import { loadTierRouteConfig, MODEL_TIERS, modelOwnThinkingSuffix, type TierRouteInjectedSource } from "./routing.ts";
import { routeExceptionFromResult, type RouteException } from "./route-error.ts";
import type { ModelErrorJournal, ModelHealthGateway } from "./model-health.ts";
import { isFailoverSwitchable } from "./model-failover.ts";
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
import { claimRoundSignal, claimTeamMessages, findRosterMember, rosterPath, teamRoundMarker, upsertRosterMember } from "./team.ts";
import type { RunningSubagent, SubagentResult } from "./types.ts";
import {
  buildPiPromptArgs,
  buildSubagentToolAllowlist,
  resolveEffectiveAutoExit,
  resolveEffectiveInteractive,
  resolveEffectiveSessionMode,
  resolveLaunchBehavior,
  resolveSurfaceChoice,
  validateAgentLifecycleConfig,
  SPAWNING_TOOLS,
  TEAM_TOOLS,
} from "./launch-config.ts";
import {
  borderBottom,
  borderLine,
  borderSegmentLine,
  borderTop,
  buildSubagentMetadataSegment,
  type SubagentMetadataLevel,
  contextWindowFor,
  formatContextUsage,
  formatElapsed,
  formatTokens,
  formatUsageSegments,
  subagentTreePrefix,
  subagentTreeTier,
  SUBAGENT_WIDGET_SEGMENT_PRIORITIES,
  widgetIcon,
} from "./display.ts";
import { layoutTwoColumnSegments, type StatusSegment } from "../tui/status/segment-layout.ts";
import { debugLog } from "./diagnostics.ts";
import { createRuntimeRegistry, type RuntimeRecord } from "./registry.ts";
import {
  buildWatcherTerminal,
  failureSettlement,
  takeMemberOffline,
  type MemberTerminalActions,
} from "./terminal.ts";
import {
  createSubagentStartup,
  validateResumeTarget,
  type StartedRun,
  type SubagentStartup,
} from "./startup.ts";

/**
 * 本模块目录的绝对路径（工单 13 平掉 src/ 后实现文件平铺在模块根）。
 * https://github.com/nodejs/node/issues/37845
 */
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

// 思考等级词汇表（含 ":level" 后缀识别）统一由 routing.ts 提供（工单 23），
// 与配置解析、启动校验同一份规范集合，不再各自维护本地副本。

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
  /**
   * 候选池运行状态网关（工单 25，宿主注入）：独立 `-e` 装载（子进程）时
   * 省略——无状态输入，选择行为与工单 24 一致。缺席时绝不阻断选择。
   */
  modelHealth?: ModelHealthGateway;
  /**
   * 模型错误观测日志（工单 26，宿主注入）：子代理临时性路由失败分类写入
   * （工真降级重试与观测共用），网关读取合并成 unstable/持续不稳定判定。
   * 会话结束清空；缺席时降级重试照常，只是状态不沉淀。
   */
  modelErrorJournal?: ModelErrorJournal;
  /**
   * 工单 28：用量统计记录器（宿主注入）。每次 watcher 终态（handed-off 除
   * 外）经它落一条统计；缺席时统计不沉淀，其余行为不变。
   */
  recordUsage?: (event: UsageRunEvent) => void;
  /**
   * 工单 44：渲染层译者（宿主注入，读实时语言，切换后无需重建）。
   * 独立 `-e` 装载（子进程）时缺席，状态语汇回落本模块英文表；
   * 模型侧工具输出不经过它，界面语言不影响工具协议。
   */
  t?: Translator;
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

/** 独立装载时的英文兜底译者：本模块键表自取，不依赖全局登记 */
const FALLBACK_TRANSLATE = subagentsTableTranslator("en");

/**
 * 渲染层取词（工单 44）：宿主译者优先（读实时语言），独立装载回退英文。
 * 只服务显示面（widget / 通知句 / 终态行）；模型侧工具输出不经它。
 */
const widgetText: SubagentsTranslate = (key, vars) => (hostOptions.t ?? FALLBACK_TRANSLATE)(key, vars);

/**
 * 宿主 tier 层的注入候选。宿主节声明了 `models` 或 `thinking`（工单 23）任一
 * 对象时这一层才参与；两者都未声明时让链继续落到包内 config.json / example
 * 兜底。同层声明的 models 与 thinking 一起注入（层级整体生效，不拆开逐键
 * 取舍）：仅声明 thinking 的层会以 models:{} 参与链，若更低层本就配了候选池
 * （如手写的包内 config.json），缺映射会在 spawn 时以指向本节的原版报错
 * 显式暴露，而不是静默丢掉思考等级配置。
 */
export function resolveHostTierSources(): TierRouteInjectedSource[] {
  const host = hostSection();
  if (!host) return [];
  const raw: Record<string, unknown> = {};
  const models = host.section.models;
  const thinking = host.section.thinking;
  if (isPlainObject(models) && Object.keys(models).length > 0) raw.models = models;
  if (isPlainObject(thinking) && Object.keys(thinking).length > 0) raw.thinking = thinking;
  if (Object.keys(raw).length === 0) return [];
  return [{ source: host.source, raw }];
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
 *
 * 工单 29：优先级为 用户安装扩展（agentDir/extensions/…）> 运行时注册表
 * （registerToolExtension，显式覆盖）> 模块捆绑兜底实现（tools/ 下的
 * web-search / web-fetch；此前这两个名字只指向用户安装路径，多数机器上
 * 从未存在，pi 又会静默丢弃 --tools 白名单里没有提供方的名字，子代理
 * 于是只剩 ask_question）。捆绑兜底让随包 profile（researcher/worker）
 * 的声明在任何机器上都真实可装载。
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
  // Prefer the user-installed path, but fall back to a runtime-registered
  // extension when that path no longer exists on disk (e.g. a user tool
  // extension was disabled/removed but a project-local extension re-registered
  // it), and finally to the module-bundled fallback below.
  const builtin = map[tool];
  if (builtin && existsSync(builtin)) return builtin;
  const registered = EXTRA_TOOL_EXTENSIONS.get(tool);
  if (registered) return registered;
  // 捆绑兜底：web_search / web_fetch 有随包实现（tools/web-search.ts /
  // tools/web-fetch.ts），用户安装版缺席时按模块内路径注入。
  const bundled: Record<string, string> = {
    web_search: join(SUBAGENTS_DIR, "tools", "web-search.ts"),
    web_fetch: join(SUBAGENTS_DIR, "tools", "web-fetch.ts"),
  };
  const fallback = bundled[tool];
  return fallback && existsSync(fallback) ? fallback : undefined;
}

/**
 * 工单 29：按最终 `--tools` 白名单逐名判定子进程里是否真有提供方。
 * pi 会静默丢弃白名单里没有注册者的工具名，所以“声明了但没人提供”
 * 只有在这里显式判红，spawn 阶段才能拒绝而不是让子代理跑到任务中途
 * 才发现工具缺失。
 *
 * 白名单由 buildSubagentToolAllowlist 构造：spawning 工具与 team_send 只在
 * 被显式授权（subagent_agents / member spawn）时才会出现在白名单里，
 * ask_question 则由启动事务无条件 `-e subagent-done.ts` 提供。因此这三类
 * 在白名单里出现即视为模块提供；其余名字要么是 pi 内置工具，要么必须有
 * 存在于磁盘的背书扩展（getToolExtensionPath 的任一来源）。
 */
export interface ToolProvisionReport {
  tool: string;
  kind: "builtin" | "module" | "extension";
  provider?: string;
}

export function classifyToolProvisions(allowlist: string): {
  provided: ToolProvisionReport[];
  missing: string[];
} {
  const provided: ToolProvisionReport[] = [];
  const missing: string[] = [];
  for (const raw of allowlist.split(",")) {
    const tool = raw.trim();
    if (!tool) continue;
    if (BUILTIN_TOOLS.has(tool)) {
      provided.push({ tool, kind: "builtin" });
      continue;
    }
    const isSpawning = (SPAWNING_TOOLS as readonly string[]).includes(tool);
    const isTeam = (TEAM_TOOLS as readonly string[]).includes(tool);
    if (isSpawning || isTeam || tool === "ask_question") {
      provided.push({ tool, kind: "module" });
      continue;
    }
    const provider = getToolExtensionPath(tool);
    if (provider && existsSync(provider)) {
      provided.push({ tool, kind: "extension", provider });
      continue;
    }
    missing.push(tool);
  }
  return { provided, missing };
}

/**
 * 工单 29：spawn 阶段核验 profile 声明的工具全部可提供，返回缺失名单
 * （空数组 = 全部可提供）。注入 startup 事务做 fail-fast。
 */
export function validateToolProvision(allowlist: string): string[] {
  return classifyToolProvisions(allowlist).missing;
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
  return join(SUBAGENTS_DIR, "agents");
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
  const t = widgetText;
  if (snapshot.kind === "starting") return ` ${t("module.subagents.widget.status.starting")} `;
  if (snapshot.kind === "running") return ` ${t("module.subagents.widget.status.running")} ${snapshot.elapsedText} `;
  if (snapshot.kind === "active") {
    const label = activeScopeLabel(snapshot);
    const duration = snapshot.activeDurationText ? ` ${snapshot.activeDurationText}` : "";
    return label ? ` ${t("module.subagents.widget.status.active")} · ${label}${duration} ` : ` ${t("module.subagents.widget.status.active")} `;
  }
  if (snapshot.kind === "waiting") {
    const duration = snapshot.waitingDurationText ? ` ${snapshot.waitingDurationText}` : "";
    const detail = snapshot.statusLabel ? ` · ${statusLabelText(t, snapshot.statusLabel)}` : "";
    return ` ${t("module.subagents.widget.status.waiting")}${duration}${detail} `;
  }

  // 工单 45 三态：stale-tool / stale 不冒充 active，证据停滞带证据文字。
  if (snapshot.kind === "stale-tool") {
    const duration = snapshot.activeDurationText ?? snapshot.staleDurationText ?? "";
    return ` ${t("module.subagents.widget.stale.toolRunning", { duration })} `;
  }
  if (snapshot.kind === "stale") {
    const last = activeScopeLabel(snapshot) ?? snapshot.latestEvent ?? "—";
    const duration = snapshot.staleDurationText ?? "";
    return ` ${t("module.subagents.widget.stale.noActivity", { duration, last })} `;
  }
  if (snapshot.stalledWithEvidence) {
    const duration = snapshot.snapshotProblemText ?? snapshot.staleDurationText ?? "";
    return ` ${t("module.subagents.widget.stalled.evidence", { duration })} `;
  }

  const detail = snapshot.statusLabel ? ` · ${statusLabelText(t, snapshot.statusLabel)}` : "";
  const duration = snapshot.snapshotProblemText ? ` ${snapshot.snapshotProblemText}` : "";
  return ` ${t("module.subagents.widget.status.stalled")}${detail}${duration} `;
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
 * 进程级运行态登记表：内存运行态、保留名与磁盘运行记录统一由它持有。
 * 本文件的启动/恢复/watcher/关闭路径与所有工具都只经它读写运行态。
 */
const runtimeRegistry = createRuntimeRegistry();

/**
 * 服务注册表句柄 `subagents.running` 的只读投影（三个方法签名与既有一致）：
 * 数据源统一为登记表——内存实时态来自 list()，会话磁盘记录来自 readRecords()。
 */
export const subagentsRunningView = {
  /** 进程内运行中的子代理数量（与状态 widget 同源，实时）。 */
  runningCount: (): number => runtimeRegistry.list().length,
  /** 进程内运行中的子代理名（便于其它模块做哨兵判断）。 */
  runningNames: (): readonly string[] => runtimeRegistry.list().map((running) => running.name),
  /** 会话作用域的持久化运行态登记（沿用 subagent-runtime.json 的既有布局）。 */
  runtimeRecords: (sessionDir: string, sessionId: string): RuntimeRecord[] =>
    runtimeRegistry.readRecords(runtimeRegistry.pathFor(getArtifactDir(sessionDir, sessionId))),
};

// When this extension is loaded inside a subagent that itself spawns children
// (e.g. a worker delegating to plan/researcher), `subagent-done.ts` runs in the
// same process and needs to know whether this session still has children in
// flight — so it can suppress auto-exit and keep the session open until they all
// report back. Expose a live count through a process-global symbol that both
// modules share. (subagent-done.ts reads it; if absent it assumes zero.)
const RUNNING_CHILDREN_COUNT_KEY = Symbol.for("pi-subagents/running-children-count");
(globalThis as any)[RUNNING_CHILDREN_COUNT_KEY] = () => runtimeRegistry.list().length;

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

/** 后代行显示层名字截断上限（工单 43）；仅作用于后代行的名字与归属名，第一层行维持既有全名展示。 */
const DESCENDANT_NAME_LIMIT = 16;

/** 孤儿行右标签：父已退出的标记挂在 required 状态段里，任何档位都可见。 */
function formatRowRightLabel(row: { orphan: boolean; snapshot: StatusSnapshot }): string {
  if (!isStatusEnabled()) {
    return row.orphan
      ? ` ${widgetText("module.subagents.widget.orphan")} `
      : ` ${widgetText("module.subagents.widget.status.starting")} `;
  }
  if (!row.orphan) return formatWidgetRightLabel(row.snapshot);
  return ` ${widgetText("module.subagents.widget.orphan")} · ${formatWidgetRightLabel(row.snapshot).trim()} `;
}

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function widgetBorderColor(
  _snapshot: WidgetSnapshot,
  theme: any,
  currentSessionThinkingLevel: string | undefined,
): ((text: string) => string) | undefined {
  if (!theme || typeof theme.getThinkingBorderColor !== "function") return undefined;
  const level = currentSessionThinkingLevel && THINKING_LEVELS.has(currentSessionThinkingLevel)
    ? currentSessionThinkingLevel
    : "off";
  return theme.getThinkingBorderColor(level);
}

function rowIdentityAndMetadata(
  row: WidgetSnapshot["rows"][number],
  tier: ReturnType<typeof subagentTreeTier>,
  level: SubagentMetadataLevel,
  muted: ((text: string) => string) | undefined,
): { prefix: string; left: string; right: string } {
  const icon = widgetIcon(row.snapshot.kind);
  // 工单 63：固定 3 列树形槽位（外列统一 1 列内边距）——顶层「图标+两空格」、
  // 后代「连接符+一空格」占同一槽位，时间列从同一列开始；后代行不再重复
  // 状态图标，运行状态由右侧状态段表达。前缀是固定 chrome：单独扣减段位
  // 预算，不进压缩循环。
  const prefix = row.depth === 0
    ? ` ${icon}  `
    : ` ${subagentTreePrefix(row.depth, row.lastFlags, row.isLast, tier, muted ?? ((text) => text))}`;
  const name = row.depth === 0 ? row.name : truncateToWidth(row.name, DESCENDANT_NAME_LIMIT, "…");
  const role = row.agent ? truncateToWidth(row.agent, DESCENDANT_NAME_LIMIT, "…") : null;
  const metadata = level === "hidden" ? null : buildSubagentMetadataSegment(row.model, row.thinking, role, level);
  const identity = `${formatElapsedMMSS(row.startTime)}  ${name}`;
  const left = metadata ? `${identity}  ${metadata.text}` : identity;
  return { prefix, left, right: formatRowRightLabel(row) };
}

/** 元信息级别按整个 widget 的最坏行统一选择，而不是逐行压缩。 */
function widgetMetadataLevel(snapshot: WidgetSnapshot, width: number, tier: ReturnType<typeof subagentTreeTier>): SubagentMetadataLevel {
  for (const level of ["full", "compact"] as const) {
    const fits = snapshot.rows.every((row) => {
      const parts = rowIdentityAndMetadata(row, tier, level, undefined);
      const budget = Math.max(0, width - 2 - visibleWidth(parts.prefix));
      return visibleWidth(parts.left) + 1 + visibleWidth(parts.right) <= budget;
    });
    if (fits) return level;
  }
  return "hidden";
}

function renderWidgetSnapshotLines(
  snapshot: WidgetSnapshot,
  width: number,
  theme?: any,
  currentSessionThinkingLevel?: string,
): string[] {
  // 标题 Subagents 是用户口径的标识类例外（不翻），计数是状态语汇走 t()；
  // 同一行里一半冻结一半翻是刻意为之。
  const colorize = widgetBorderColor(snapshot, theme, currentSessionThinkingLevel);
  // 工单 63：树形连接符/续行用主题 muted，与外框同一主题实例取色；主题
  // 缺席或无 fg 接口时不着色。
  const muted = theme && typeof theme.fg === "function"
    ? (text: string) => theme.fg("muted", text)
    : undefined;
  const lines: string[] = [
    borderTop("Subagents", widgetText("module.subagents.widget.count.running", { count: snapshot.counts.allCount }), width, colorize),
  ];
  const tier = subagentTreeTier(width);
  const metadataLevel = widgetMetadataLevel(snapshot, width, tier);

  for (const row of snapshot.rows) {
    const parts = rowIdentityAndMetadata(row, tier, metadataLevel, muted);
    const left: StatusSegment[] = [{
      id: "identity",
      text: parts.left,
      priority: SUBAGENT_WIDGET_SEGMENT_PRIORITIES.identity,
      required: true,
    }];
    const right: StatusSegment[] = [{
      id: "status",
      text: parts.right,
      priority: SUBAGENT_WIDGET_SEGMENT_PRIORITIES.status,
      required: true,
    }];

    const prefix = parts.prefix;
    const budget = Math.max(0, width - 2 - visibleWidth(prefix));
    const layout = layoutTwoColumnSegments(left, right, budget);
    lines.push(borderLine(prefix + layout.left, layout.right, width, colorize));
    if (row.collapseAfter != null && row.collapseAfter > 0) {
      // 组尾折叠提示（chrome 行，连接符与树线同用 muted）。
      lines.push(borderLine(` ${muted ? muted("└─") : "└─"} … +${row.collapseAfter} more`, "", width, colorize));
    }
  }

  if (snapshot.counts.globalOverflow > 0) {
    lines.push(borderLine(` … +${snapshot.counts.globalOverflow} more`, "", width, colorize));
  }
  lines.push(borderBottom(width, colorize));
  return lines;
}

function renderSubagentWidgetLines(
  agents: RunningSubagent[],
  width: number,
  theme?: any,
  currentSessionThinkingLevel?: string,
): string[] {
  return renderWidgetSnapshotLines(
    buildFirstLayerOnlySnapshot(agents, Date.now()),
    width,
    theme,
    currentSessionThinkingLevel,
  );
}

/** 后代快照 tracker（工单 43）：session_start 重建，session_shutdown 丢弃。 */
let widgetTree: DescendantsTracker | null = null;

/** 最近一次 widget 快照：渲染闭包只读它，零磁盘 IO（工单 43）。 */
let widgetSnapshot: WidgetSnapshot | null = null;

function updateWidget() {
  if (!latestCtx?.hasUI) return;

  const firstLayer = runtimeRegistry.list();
  const snapshot = widgetTree
    ? widgetTree.snapshot(firstLayer, Date.now())
    : buildFirstLayerOnlySnapshot(firstLayer, Date.now());
  widgetSnapshot = snapshot;

  // 存续条件（工单 43）：快照（含孤儿行）为空才撤 widget/停 interval——
  // 父行消失后孤儿仍要有展示窗口；磁盘清理责任仍在写方，这里只做展示过滤。
  if (snapshot.counts.allCount === 0) {
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
    (_tui: any, theme: any) => {
      return {
        invalidate() {},
        render(width: number) {
          return widgetSnapshot
          ? renderWidgetSnapshotLines(
              widgetSnapshot,
              width,
              theme,
              typeof latestPi?.getThinkingLevel === "function"
                ? latestPi.getThinkingLevel()
                : latestCtx?.thinkingLevel,
            )
          : [];
        },
      };
    },
    { placement: "aboveEditor" },
  );
}

/** 本扩展的完整包名(@scope/name 或 name),从自身 package.json 读取,发布树与开发树同源。 */
function ownPackageName(): string | null {
  try {
    const pkg: unknown = JSON.parse(readFileSync(join(SUBAGENTS_DIR, "..", "..", "package.json"), "utf8"));
    const name = (pkg as { name?: unknown } | null)?.name;
    return typeof name === "string" && name ? name : null;
  } catch {
    return null;
  }
}

/**
 * 从 packages 条目解析包名(去版本/ref):
 * npm:@scope/name@1.2.3 → @scope/name(全名,保留 scope 供精确比对);
 * git:host/path#ref → path 末段;其余条目(npm/git 之外 pi 一律按本地路径
 * 看待,裸名亦然)按 baseDir 解析成绝对路径后取末段目录名。
 */
function entryPackageName(entry: string, baseDir: string): string | null {
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
  return resolve(baseDir, entry).split(/[\\/]/).filter(Boolean).pop() ?? null;
}

/**
 * 判定子进程的扩展发现是否会注册与本模块同批的工具(spawning 工具):
 * 读子进程 agentDir 的 settings.json,packages 里任一条目是本包,或本地
 * 路径条目(绝对/相对)的安装根覆盖 SUBAGENTS_DIR(本地测试包场景),即成立。
 * 与“是否同一份拷贝”无关:任何一份 pi-toolkit 被发现都会注册同批工具,
 * 再注入本模块必致工具名冲突。读不到或格式异常按不成立处理(保守保留注入)。
 * 相对路径基准是 settings.json 所在目录,不是进程 cwd:pi 包管理器按 scope
 * 的 base dir 解析本地条目并据此写入相对条目(user scope = agentDir,project
 * scope = <cwd>/.pi;dist/core/package-manager.js 的 getBaseDirForScope /
 * resolvePathFromBase,工单 54 探针实测命中 agentDir 基准)。
 * 匹配精度:npm 条目带 scope,全名精确匹配;git/本地路径没有 scope 对应
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
      const isLocalEntry = !entry.startsWith("npm:") && !entry.startsWith("git:");
      const name = entryPackageName(entry, dir);
      if (own && name === own) return true;
      if (own && !entry.startsWith("npm:") && name === own.split("/").pop()) return true;
      // 本地条目(含相对路径)解析后覆盖本模块目录 → 子进程必然发现同一批工具
      if (isLocalEntry && isWithin(target, resolve(dir, entry))) return true;
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
    // 思考等级覆盖链（工单 23，规格 §4）：spawn 显式 thinkingOverride > 代理
    // frontmatter thinking > 档位默认 tierThinking > 模型自带 ":level" 后缀。
    // 模型自带后缀是最低层（"模型自身默认值"），任何更高层的等级都会先剥掉
    // 后缀再拼接，不会拼成 ":max:low" 双后缀。旧快照（无 tierThinking）走同
    // 一链路，缺省即为 undefined，行为不变。
    const requested =
      loadout.thinkingOverride ?? loadout.thinking ?? loadout.tierThinking ?? null;
    let model = loadout.model;
    if (requested != null) {
      const own = modelOwnThinkingSuffix(model);
      if (own) model = model.slice(0, model.length - own.length - 1);
      model = `${model}:${requested}`;
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
    // 目录的包时,再 -e 注入本模块入口会把同一批工具注册两次,子进程以工具名
    // 冲突拒绝启动(exit 1)。此时只跳过模块入口本身(spawning 工具映射的
    // mod.ts),工具由发现路径提供;tools/ 下的独立工具扩展(safe-bash、
    // web-search、web-fetch)不在包 manifest 里,发现路径给不出来,必须照常
    // 注入(工单 29:此前按 SUBAGENTS_DIR 树整体豁免,导致 safe_bash 声明了
    // 却没装载,子代理只剩 ask_question)。
    const selfEntryPath = resolve(fileURLToPath(import.meta.url));
    const skipSelfInjection = childDiscoversOwnPackage(loadout.agentDir);
    for (const extPath of extPaths) {
      const resolved = resolve(extPath);
      if (!trustedRoots.some((root) => resolved === root || resolved.startsWith(root + sep))) continue;
      if (skipSelfInjection && resolved === selfEntryPath) continue;
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

/**
 * 会话文件存活证据探针（工单 45）：第一层运行态每秒观测时采集（指纹变化 +
 * pid 探活），与后代 tracker 共用 liveness.ts 的采集语义、status.ts 的判定。
 */
const sessionLivenessProbe = createSessionFileLivenessProbe();

function observeRunningSubagent(running: RunningSubagent, observedAt = Date.now()) {
  const activityFile = running.activityFile;
  const read: ActivityReadResult = activityFile
    ? readSubagentActivityFile(activityFile, running.id)
    : { ok: false, reason: "missing" };

  running.activityRead = read.ok
    ? { ok: true }
    : { ok: false, reason: read.reason, error: read.error };

  // 证据采集（IO 在采集侧）：会话指纹 + headless 句柄/pid 探活；pane 派生无 pid。
  const session = running.sessionFile
    ? sessionLivenessProbe.probe(running.sessionFile, observedAt)
    : null;
  const evidence: StatusLivenessEvidence = {
    sessionLastChangeAtMs: session?.lastChangeAtMs ?? null,
    processAlive: running.headlessChild
      ? !running.headlessChild.exited
      : running.pid != null
        ? isPidAlive(running.pid)
        : null,
  };

  if (read.ok) {
    running.activity = read.activity;
    running.statusState = observeStatus(running.statusState, {
      snapshot: "present",
      updatedAt: read.activity.updatedAt,
      sequence: read.activity.sequence,
      phase: read.activity.phase,
      active: read.activity.phase === "active",
      toolActive: read.activity.toolActive,
      activeScope: read.activity.activeScope,
      activeSince: read.activity.activeSince,
      waitingSince: read.activity.waitingSince,
      latestEvent: read.activity.latestEvent,
      activityLabel: activityDisplayLabel(read.activity),
    }, observedAt, evidence);
    return;
  }

  running.statusState = observeStatus(running.statusState, {
    snapshot: read.reason,
    snapshotError: read.error,
  }, observedAt, evidence);
}

// 名字保留（reserveName/releaseName/isNameTaken/uniqueName）与按名解析
// （resolveName）已收进登记表 registry.ts；本文件不再持有进程内 Map/Set。

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

  const resolved = runtimeRegistry.resolveName(params.name ?? "");
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
    if (runtimeRegistry.list().length === 0) {
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

    for (const running of runtimeRegistry.list()) {
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
        transitionLines.push(formatTransitionLine(running.name, snapshot, transition, widgetText));
      }
    }

    if (shouldRefreshWidget) updateWidget();

    if (transitionLines.length > 0) {
      const capped = capStatusLines(transitionLines, statusConfig.lineLimit);
      pi.sendMessage(
        {
          customType: "subagent_status",
          content: formatStatusAggregate(transitionLines, statusConfig.lineLimit, widgetText),
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

/** 工单 29：launch-config 纯函数再出口（子进程环境打 NODE_USE_ENV_PROXY 用）。 */
export { needsEnvProxyForTools } from "./launch-config.ts";

export const __test__ = {
  borderLine,
  borderSegmentLine,
  isStatusEnabled,
  getShellReadyDelayMs,
  renderSubagentWidgetLines,
  renderWidgetSnapshotLines,
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
  classifyToolProvisions,
  validateToolProvision,
  buildPiPromptArgs,
  observeRunningSubagent,
  getToolExtensionPath,
  steerSubagent,
  handleSubagentSteer,
  classifyWatcherFailure,
  watchMemberRound,
  canReuseMemberName,
  drainMemberMailbox,
  resolveResultPresentation,
  resolveResumeLaunchBehavior,
  buildHeadlessPrompt,
  runtimeRegistry,
  watchSubagent,
  waitForHeadlessExit,
  formatTokens,
  formatContextUsage,
  contextWindowFor,
  formatUsageSegments,
  widgetIcon,
};

function startWidgetRefresh() {
  // 先立 interval 再首刷：空快照的 teardown 能当场把 interval 撤干净，
  // 不会留下一个只会重复撤除动作的空转 tick。
  if (!widgetInterval) {
    widgetInterval = setInterval(() => {
      updateWidget();
    }, 1000);
    (globalThis as any)[WIDGET_INTERVAL_KEY] = widgetInterval;
  }
  updateWidget(); // immediate first render
}

/**
 * Watch a launched subagent until it exits. Polls for completion, extracts
 * the summary from the session file, cleans up the surface,
 * and removes the entry from the runtime registry.
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
  return !runtimeRegistry.isNameTaken(normalized);
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

/** 成员终态收尾动作：terminal.ts 的统一实现在此拿到进程/roster/登记三个原语。 */
function memberTerminalActions(): MemberTerminalActions {
  return { registry: runtimeRegistry, killMemberProcess, markMemberOffline };
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
  takeMemberOffline(running, reason, memberTerminalActions());
  settleCompletionFromResult(running.name, failureSettlement(running, errorMessage));
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
      takeMemberOffline(running, "host-reload", memberTerminalActions());
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

      takeMemberOffline(running, "process-exited", memberTerminalActions(), { kill: false });
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
      // 状态回收(工单 30):PID 仍存活但活动快照早已声明终态(done 且超出
      // 兜底窗口)——记录里的 PID 大概率已被无关进程复用(Windows 进程
      // churn 下高发)。控制面已 finished,不能永远轮询一个无关进程:按
      // 正常完成兑终态,让调用方回收运行态、磁盘记录与 widget 行。
      // running.activity 由循环底部的 observeRunningSubagent 喂数,首轮
      // 观测后即命中。
      if (isTerminalDoneActivity(running.activity)) {
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
  const { startTime, sessionFile } = running;

  try {
    const result = await waitForHeadlessExit(running, AbortSignal.any([signal, getModuleAbortSignal()]));
    const elapsed = Math.floor((Date.now() - startTime) / 1000);

    const extracted = await extractSubagentResult(sessionFile, result);

    runtimeRegistry.remove(running.id);
    // 进程通常已自行退出;降级/竞态残留的句柄 best-effort 回收。
    try {
      running.headlessChild?.kill();
    } catch (error) {
      debugLog(`Could not dispose completed headless child ${running.surface}`, error);
    }

    return buildWatcherTerminal(running, {
      kind: "completed",
      summary: extracted.summary,
      exitCode: result.exitCode,
      ...(extracted.sessionId ? { sessionId: extracted.sessionId } : {}),
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
      ...(extracted.stats ? { stats: extracted.stats } : {}),
    }, elapsed);
  } catch (err: any) {
    const moduleWasReplaced = (globalThis as any)[MODULE_INSTANCE_KEY] !== moduleInstanceId;
    const failureKind = classifyWatcherFailure({
      moduleReplaced: moduleWasReplaced,
      moduleAbortAborted: getModuleAbortSignal().aborted,
      watcherSignalAborted: signal.aborted,
    });
    runtimeRegistry.remove(running.id, { keepRecord: true });
    if (failureKind === "reload-handoff" || failureKind === "session-detach") {
      // /reload 移交或宿主会话关闭:进程还在跑,保留 runtime record 交给
      // 恢复逻辑接管。绝不伪造 cancelled/failed 结果,显式 handed-off 语义:
      // 调用方只报“已移交,真实结果稍后回注”,不重复回注。
      return buildWatcherTerminal(running, {
        kind: "handed-off",
        reason: failureKind === "reload-handoff" ? "host-reload" : "session-detach",
      }, Math.floor((Date.now() - startTime) / 1000));
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
    runtimeRegistry.removeRecord(running.runtimeFile, running.id);
    if (failureKind === "cancelled") {
      return buildWatcherTerminal(running, { kind: "cancelled" }, Math.floor((Date.now() - startTime) / 1000));
    }
    return buildWatcherTerminal(running, { kind: "failed", error: err }, Math.floor((Date.now() - startTime) / 1000));
  }
}

async function watchSubagent(
  running: RunningSubagent,
  signal: AbortSignal,
): Promise<SubagentResult> {
  if (running.kind === "headless") return watchHeadlessSubagent(running, signal);
  const { surface, startTime, sessionFile } = running;

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

    runtimeRegistry.remove(running.id);
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
      return buildWatcherTerminal(running, { kind: "cancelled" }, elapsed);
    }
    return buildWatcherTerminal(running, {
      kind: "completed",
      summary,
      exitCode: result.exitCode,
      ...(subagentSessionId ? { sessionId: subagentSessionId } : {}),
      ...(result.reason === "user_closed" ? { userClosed: true } : {}),
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
      ...(stats ? { stats } : {}),
    }, elapsed);
  } catch (err: any) {
    const moduleWasReplaced = (globalThis as any)[MODULE_INSTANCE_KEY] !== moduleInstanceId;
    const failureKind = classifyWatcherFailure({
      moduleReplaced: moduleWasReplaced,
      moduleAbortAborted: getModuleAbortSignal().aborted,
      watcherSignalAborted: signal.aborted,
    });
    runtimeRegistry.remove(running.id, { keepRecord: true });
    if (failureKind === "reload-handoff" || failureKind === "session-detach") {
      // /reload 移交或宿主会话关闭:pane 与 runtime record 全保留,交给恢复
      // 逻辑接管;不伪造 cancelled/failed,也不在此回注,显式 handed-off。
      return buildWatcherTerminal(running, {
        kind: "handed-off",
        reason: failureKind === "reload-handoff" ? "host-reload" : "session-detach",
      }, Math.floor((Date.now() - startTime) / 1000));
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
      runtimeRegistry.removeRecord(running.runtimeFile, running.id);
    }
    if (failureKind === "cancelled") {
      return buildWatcherTerminal(running, { kind: "cancelled" }, Math.floor((Date.now() - startTime) / 1000));
    }
    return buildWatcherTerminal(running, { kind: "failed", error: err }, Math.floor((Date.now() - startTime) / 1000));
  }
}

/** 重载后从运行态记录恢复 watcher，避免同一 session 被重复启动。
 *  进程/表面的重建与 watcher 启动归启动模块（startup.recover）；这里只做
 *  结果提取、完成记录落定与回注——结果提取与呈现不是启动职责。 */
async function recoverRuntimeSubagents(
  ctx: { sessionManager: { getSessionId(): string; getSessionDir(): string } },
  pi: ExtensionAPI,
  startup: SubagentStartup,
): Promise<void> {
  for (const outcome of await startup.recover(ctx, pi)) {
    if (outcome.kind === "exited") {
      await deliverRecoveredExit(outcome.record, outcome.exit, pi);
      continue;
    }
    if (outcome.kind === "running") {
      if (outcome.recovered === "pane") {
        deliverRecoveredPane(outcome.run, pi);
      } else {
        deliverRecoveredHeadless(outcome.run, pi);
      }
    }
  }
}

/** 已退出的重载记录：提取真实结果、落定完成记录并按恢复语义回注一次。 */
async function deliverRecoveredExit(
  record: RuntimeRecord,
  exit: { exitCode: number; errorMessage?: string },
  pi: ExtensionAPI,
): Promise<void> {
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
}

/** 仍在跑的 headless 降级记录：watcher 已由启动模块挂上，这里只落定与回注。 */
function deliverRecoveredHeadless(run: StartedRun, pi: ExtensionAPI): void {
  const running = run.running;
  run.watch
    .then((result) => {
      const terminal = result as SubagentResult;
      updateWidget();
      settleCompletionFromResult(running.name, terminal);
      // 恢复 watcher 自己又赶上 /reload:再次移交,真实结果由更新后的
      // 模块在下次 session_start 恢复接管,本次不回注,避免伪造/重复结果。
      if (terminal.handedOff) return;
      const routeException = routeExceptionFromResult(terminal, running.model);
      const presentation = resolveResultPresentation(terminal, running.name);
      pi.sendMessage(
        {
          customType: "subagent_result",
          content: presentation,
          display: true,
          details: {
            name: running.name,
            task: running.task,
            agent: running.agent,
            exitCode: terminal.exitCode,
            elapsed: terminal.elapsed,
            sessionFile: terminal.sessionFile,
            ...(running.cohortId ? { cohortId: running.cohortId } : {}),
            recovered: "headless-degraded",
            ...(terminal.sessionId ? { sessionId: terminal.sessionId } : {}),
            ...(terminal.errorMessage ? { errorMessage: terminal.errorMessage } : {}),
            ...(terminal.stats ? { stats: terminal.stats } : {}),
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
}

/** 仍在跑的 pane 记录：watcher 已由启动模块挂上，这里只落定与回注。 */
function deliverRecoveredPane(run: StartedRun, pi: ExtensionAPI): void {
  const running = run.running;
  run.watch
    .then((result) => {
      const terminal = result as SubagentResult;
      updateWidget();
      // 用户直接关闭 pane 是稳定终态(user_closed),同样要 settle 依赖
      // 记录(按 cancelled 语义),等待者不永久挂起。
      settleCompletionFromResult(running.name, terminal, {
        ...(terminal.userClosed ? { status: "cancelled" as const } : {}),
      });
      // 恢复 watcher 自己又赶上 /reload:再次移交,本次不回注(同 headless 分支)。
      if (terminal.handedOff) return;
      const routeException = routeExceptionFromResult(terminal, running.model);
      const presentation = resolveResultPresentation(terminal, running.name);
      pi.sendMessage(
        {
          customType: "subagent_result",
          content: presentation,
          display: true,
          details: {
            name: running.name,
            task: running.task,
            agent: running.agent,
            exitCode: terminal.exitCode,
            elapsed: terminal.elapsed,
            sessionFile: terminal.sessionFile,
            ...(running.cohortId ? { cohortId: running.cohortId } : {}),
            recovered: "pane",
            ...(terminal.userClosed ? { userClosed: true } : {}),
            ...(terminal.sessionId ? { sessionId: terminal.sessionId } : {}),
            ...(terminal.errorMessage ? { errorMessage: terminal.errorMessage } : {}),
            ...(terminal.stats ? { stats: terminal.stats } : {}),
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
}

export default function subagentsExtension(pi: ExtensionAPI, options?: SubagentsExtensionOptions) {
  configureSubagentsExtension(options ?? {});
  latestPi = pi;
  // Capture the UI context for widget updates
  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx;
    // 工单 43：后代快照 tracker 随会话重建；有 UI 的会话启动即刷一次
    // widget——recover 未恢复出第一层运行态时，孤儿扫描也要有展示窗口。
    // 宿主/测试可能给不带 sessionManager（或只带空对象）的最小 ctx：方法级
    // 校验后跳过 tracker，updateWidget 自动退回纯内存第一层快照，不影响
    // 既有生命周期；只判对象存在会把 TypeError 同步抛进 session_start，
    // 跳过其后的 poll-abort 重装/预热/recover。
    widgetTree?.dispose();
    widgetTree = null;
    const sessionManager = ctx.sessionManager as
      | { getSessionDir?: () => string; getSessionId?: () => string }
      | undefined;
    if (
      typeof sessionManager?.getSessionDir === "function" &&
      typeof sessionManager?.getSessionId === "function"
    ) {
      widgetTree = createDescendantsTracker({
        rootArtifactDir: getArtifactDir(sessionManager.getSessionDir(), sessionManager.getSessionId()),
        rootCwd: ctx.cwd ?? process.cwd(),
        agentConfigDir: getAgentConfigDir(),
      });
    }
    widgetSnapshot = null;
    if (ctx.hasUI) startWidgetRefresh();
    // pi runs multiple sessions in one process. A prior session's shutdown
    // aborts the shared module poll-abort controller; install a fresh one so
    // subagents spawned in this session aren't watched against a dead signal.
    // See https://github.com/HazAT/pi-interactive-subagents/issues/5
    const prevAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
    if (!prevAbort || prevAbort.signal.aborted) {
      (globalThis as any)[POLL_ABORT_KEY] = new AbortController();
    }
    // 工单 25：候选池运行状态预热（fire-and-forget）。按默认配置链解析全档
    // 候选并集触发一次后台刷新，首次 tier spawn 大概率已有可读状态。预热
    // 是尽力而为：配置层缺失/providers 句柄缺席/刷新失败都静默跳过——状态
    // 未知不影响任何启动行为。
    const healthGateway = hostOptions.modelHealth;
    if (healthGateway) {
      const loaded = loadTierRouteConfig({
        cwd: ctx.cwd,
        agentConfigDir: getAgentConfigDir(),
        injected: resolveHostTierSources(),
      });
      const union = loaded.config
        ? MODEL_TIERS.flatMap((tier) => loaded.config?.models[tier] ?? [])
        : [];
      if (union.length > 0) healthGateway.refresh(union);
    }
    recoverRuntimeSubagents(ctx, pi, startup).catch((error) => {
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
    widgetTree?.dispose();
    widgetTree = null;
    widgetSnapshot = null;
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
    // 工单 26：会话结束清空模型错误观测——下一会话不受本会话的临时故障
    // 历史（持续不稳定判定）影响。
    hostOptions.modelErrorJournal?.clear();
    for (const agent of runtimeRegistry.list()) {
      if (agent.interactive) {
        // 交互式子代理归用户所有,宿主会话关闭时不强杀其 pane,留给用户自行处理。
        continue;
      }
      if (agent.member) {
        // 持久成员是永活进程(不 auto-exit):不能像普通自动子代理那样 detach
        // 留孤儿——安全终止并 roster 标记 offline;session/loadout 保留供显式 resume。
        killMemberProcess(agent);
        markMemberOffline(agent, "host-shutdown");
        runtimeRegistry.remove(agent.id);
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
    runtimeRegistry.clear();
  });

  // The spawning tools are always registered here. Whether a child process can
  // actually see/use them is governed by the parent's `--tools` allowlist and
  // by Pi's normal extension discovery in the child's inherited config/cwd
  // (+ explicit -e for parent-registered custom tools). See launchSubagent().

  // 启动事务：三模式（fresh / resume / recover）统一入口。工具侧只保留
  // 业务层职责（名字保留与查重、dependsOn、结果呈现与投递），启动原语
  // 全部收在这里注入启动模块。
  const startup = createSubagentStartup({
    registry: runtimeRegistry,
    getAgentConfigDir,
    loadAgentDefaults,
    resolveHostTierSources,
    getArtifactDir,
    isMuxAvailable,
    adoptSurface,
    isPidAlive,
    terminateHeadlessProcess,
    validateResumeTarget,
    applySandboxToParts,
    // 工单 29：spawn 前核验 profile 声明的工具都有提供方（fail-fast）。
    validateToolProvision,
    resolveResumeLaunchBehavior,
    subagentsDir: SUBAGENTS_DIR,
    getShellReadyDelayMs,
    spawnHeadlessPi,
    createSurface,
    sendCommand,
    closeSurface,
    buildHeadlessPrompt,
    startWidgetRefresh,
    startStatusRefresh,
    // 工单 28：watcher 终态旁路落一条用量统计（handed-off 由恢复路径的真实
    // 终态记录）；记录器缺席时行为不变。
    watchSubagent: (running, signal) =>
      withUsageRecording(watchSubagent(running, signal), running, hostOptions.recordUsage),
    watchMemberRound,
    modelHealth: options?.modelHealth,
  });

  registerSubagentTool(pi, {
    allowlist: SUBAGENT_ALLOWLIST,
    discoverAgents: discoverAgentDefinitions,
    startup,
    muxUnavailableResult,
    getArtifactDir,
    registry: runtimeRegistry,
    canReuseMemberName: (name: string, artifactDir: string) => canReuseMemberName(name, artifactDir),
    updateWidget,
    resolveResultPresentation,
    // 工单 26：临时性路由失败写入错误观测日志（供后续候选选择与观测复用；
    // 日志自身也只收临时性类别，双保险）。
    ...(hostOptions.modelErrorJournal
      ? {
          recordModelError: (model: string, exception: RouteException) => {
            if (!isFailoverSwitchable(exception.kind)) return;
            hostOptions.modelErrorJournal!.record(model, {
              kind: exception.kind,
              message: exception.message,
            });
          },
        }
      : {}),
    t: widgetText,
  });

  registerSubagentMessageTool(pi, {
    startup,
    registry: runtimeRegistry,
    handleSubagentSteer,
    extractSubagentResult,
    resolveResultPresentation,
    updateWidget,
    t: widgetText,
  });

  registerSubagentsListTool(pi, {
    discoverAgents: discoverAgentDefinitions,
    getArtifactDir,
    registry: runtimeRegistry,
    readNameRegistry,
    readSubagentLoadout,
  });
  registerSubagentInspectTool(pi, {
    registry: runtimeRegistry,
    observeRunningSubagent,
    getArtifactDir,
    readNameRegistry,
    readSubagentLoadout,
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
  registerSubagentRenderers(pi, widgetText);
  registerSubagentStopTool(pi, {
    resolveRunningByName: (name: string) => runtimeRegistry.resolveName(name),
    closeSurface,
    updateWidget,
    stopMember: (running) => {
      // 持久成员的 watcher 不兑终态(进程常驻):stop 入口直接终止 + offline,
      // 并移除运行态登记;session/loadout/roster 保留(offline 状态)供追溯。
      killMemberProcess(running);
      markMemberOffline(running, "stopped");
      runtimeRegistry.remove(running.id);
      running.abortController?.abort();
    },
  });
  registerTeamDispatchTool(pi, {
    registry: runtimeRegistry,
    getArtifactDir,
    rosterPath,
    findRosterMember,
    upsertRosterMember,
    countSessionEntryLines,
  });
}
