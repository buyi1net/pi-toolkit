import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { dirname, join, resolve, sep } from "node:path";
import { existsSync, mkdirSync, statSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  closeSurface,
  createSurface,
  createSurfaceFor,
  readExitSidecar,
  sentinelSuffix,
  sendCommand,
  shellEscape,
  resolveDisplaySurface,
  setActiveSurfaceKind,
  type DisplayMode,
  type SurfaceKind,
} from "./surface.ts";
import {
  createSubagentLaunchEnv,
  formatHeadlessSurface,
  parseHeadlessSurface,
  spawnHeadlessPi,
  type HeadlessChild,
} from "./headless.ts";
import {
  appliedLoadoutThinking,
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
  needsEnvProxyForTools,
  resolveEffectiveAutoExit,
  resolveEffectiveInteractive,
  resolveLaunchBehavior,
  resolveSubagentPaths,
  resolveSurfaceChoice,
  subagentTaskDepth,
  validateAgentLifecycleConfig,
} from "./launch-config.ts";
import { loadTierRouteConfig, normalizeTier, resolveTierPoolForParams, isThinkingLevel, modelOwnThinkingSuffix, THINKING_LEVELS, type ModelTier, type ThinkingLevel, type TierRouteInjectedSource, type TierConfigLoadResult } from "./routing.ts";
import {
  buildRoutingSnapshot,
  type RoutingFallbackReason,
} from "./routing-snapshot.ts";
import {
  normalizeModelCapability,
  selectModelCandidate,
  supportedThinkingLevels,
  resolveModelThinkingSupport,
  resolveKnownModelReference,
  modelMissingCapabilities,
  MODEL_CAPABILITIES,
  type ModelCandidateRejection,
  type ModelCandidateSelection,
  type ModelCapability,
  type ModelCatalog,
} from "./model-selector.ts";
import type { ModelHealthGateway, ModelHealthMap } from "./model-health.ts";

export type SpawnModelCatalog = ModelCatalog;
export { supportedThinkingLevels, resolveModelThinkingSupport };
import { getSubagentActivityFile, isTerminalDoneActivity, readSubagentActivityFile } from "./activity.ts";
import { createStatusState } from "./status.ts";
import { normalizeSubagentName, sanitizeSubagentFileName } from "./names.ts";
import { normalizeCohortId, SubagentParams, validateCohortId, validateSpawnText } from "./params.ts";
import { buildTeamRoundPrompt, findRosterMember, rosterPath, upsertRosterMember } from "./team.ts";
import type { RuntimeRecord, RuntimeRegistry } from "./registry.ts";
import type { RunningSubagent, SubagentResult } from "./types.ts";
import type { AgentDefaults } from "./agents.ts";
import { debugLog } from "./diagnostics.ts";
import {
  CODEX_V2_SUBAGENT_PROTOCOL,
  createCodexV2LaunchPlanMetadata,
  type SubagentLaunchPlanMetadata,
} from "./protocol.ts";

export function validateTimeoutMs(timeoutMs: unknown): string | null {
  if (timeoutMs == null) return null;
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 1000) {
    return `Invalid timeoutMs: must be an integer >= 1000 (milliseconds); got ${String(timeoutMs)}.`;
  }
  return null;
}

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

  readonly modelRegistry?: SpawnModelCatalog;

  readonly model?: { provider: string; id: string };

  readonly thinkingLevel?: string;
}

export interface StartedRun {
  running: RunningSubagent;

  signal: AbortSignal;

  watch: Promise<SubagentResult | void>;
}

export interface ResumeStartedRun extends StartedRun {
  resumedSessionId: string;
  entryCountBefore: number;
}

export interface SpawnPlanOptions {
  excludeModels?: ReadonlySet<string>;
  protocol?: typeof CODEX_V2_SUBAGENT_PROTOCOL;
  forkTurns: "all" | "none";
}

export interface SpawnPlan {
  params: Static<typeof SubagentParams>;
  cohortId: string | null;
  agentDefs: AgentDefaults | null;
  effectiveCwd: string | null;
  localAgentDir: string | null;
  effectiveAgentDir: string;
  targetCwdForSession: string;
  effectiveModel: string | null;
  effectiveTools: string | undefined;

  toolAllowlist: string | null;
  effectiveSkills: string | undefined;
  effectiveThinking: string | undefined;

  tierThinking: ThinkingLevel | null;
  tier: ModelTier | null;

  tierPool: readonly string[] | null;

  fallbackReason: RoutingFallbackReason | null;

  tierSelection: ModelCandidateSelection | null;

  tierSelectionSkips: readonly ModelCandidateRejection[] | null;

  poolSource: string | null;

  tierConfigProblems: readonly string[] | null;

  interactive: boolean;
  member: boolean;

  effectiveAutoExit: boolean;

  resolvedDisplayMode: DisplayMode;
  useHeadless: boolean;
  sessionFile: string;
  sessionId: string;
  artifactDir: string;
  sessionDir: string;
  launchBehavior: ReturnType<typeof resolveLaunchBehavior>;

  launchPlan: SubagentLaunchPlanMetadata;
}

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

      details?: Record<string, unknown>;

      muxUnavailable?: boolean;
    };

export type ResumePlanOutcome = PlanOutcome<ResumePlan> | { kind: "steer"; name: string };

export type RecoveredRun =
  | { kind: "running"; recovered: "headless-degraded" | "pane"; run: StartedRun }
  | { kind: "exited"; record: RuntimeRecord; exit: { exitCode: number; errorMessage?: string } }
  | { kind: "member-offline"; name: string; reason: string };

export interface SubagentStartupDeps {
  registry: RuntimeRegistry;

  getAgentConfigDir: () => string;

  loadAgentDefaults: (agentName: string, cwd?: string) => AgentDefaults | null;

  resolveHostTierSources: () => TierRouteInjectedSource[];
  getArtifactDir: (sessionDir: string, sessionId: string) => string;

  isMuxAvailable: () => boolean;

  adoptSurface: (surface: string) => boolean;

  isPidAlive: (pid: number) => boolean;

  terminateHeadlessProcess: (pid: number) => void;

  validateResumeTarget: (
    sessionPath: string,
    loadout: SubagentLoadout,
    agentDir: string,
    opts?: { anchored?: AnchoredSubagentLoadout | null; requireAnchored?: boolean },
  ) => string | null;

  applySandboxToParts: (
    parts: string[],
    loadout: SubagentLoadout,
    options: { artifactDir: string; name: string },
    raw?: { escape?: (value: string) => string },
  ) => string[];

  validateToolProvision?: (toolAllowlist: string) => string[];

  resolveResumeLaunchBehavior: () => { autoExit: boolean; interactive: boolean };

  subagentsDir: string;

  buildHeadlessPrompt: (effectiveSkills: string | undefined, task: string) => string;

  getShellReadyDelayMs: () => number;

  spawnHeadlessPi: typeof spawnHeadlessPi;

  createSurface: typeof createSurface;

  createSurfaceFor?: typeof createSurfaceFor;
  sendCommand: typeof sendCommand;
  closeSurface: typeof closeSurface;

  startWidgetRefresh: () => void;
  startStatusRefresh: (pi: ExtensionAPI) => void;
  watchSubagent: (running: RunningSubagent, signal: AbortSignal) => Promise<SubagentResult>;
  watchMemberRound: (running: RunningSubagent, signal: AbortSignal) => void | Promise<void>;

  modelHealth?: ModelHealthGateway;
}

export interface SubagentStartup {

  planSpawn(
    params: Static<typeof SubagentParams>,
    ctx: SpawnContext,
    options?: SpawnPlanOptions,
  ): PlanOutcome<SpawnPlan>;

  spawn(
    plan: SpawnPlan,
    ctx: SpawnContext,
    pi: ExtensionAPI,
    options?: { surface?: string },
  ): Promise<StartedRun>;

  planResume(request: { name: string; message: string; timeoutMs?: number }, ctx: ResumeContext): ResumePlanOutcome;

  resume(plan: ResumePlan, ctx: ResumeContext, pi: ExtensionAPI): Promise<ResumeStartedRun>;

  recover(
    ctx: { sessionManager: { getSessionId(): string; getSessionDir(): string } },
    pi: ExtensionAPI,
  ): Promise<RecoveredRun[]>;
}

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

  const requiresAnchored = opts?.requireAnchored === true || snapshotVersion === SUBAGENT_LOADOUT_VERSION;
  if (requiresAnchored && !anchored) {
    return "parent-anchored loadout snapshot is missing or unreadable; refusing to fall back to legacy resume validation";
  }
  const resolvedSession = resolve(sessionPath);

  if (loadout.agentDir !== undefined && loadout.agentDir !== null && typeof loadout.agentDir !== "string") {
    return "loadout agentDir must be a string or null";
  }
  if (loadout.cwd !== undefined && loadout.cwd !== null && typeof loadout.cwd !== "string") {
    return "loadout cwd must be a string or null";
  }
  if (anchored) {

    if (resolve(anchored.sessionFile) !== resolvedSession) {
      return `session path does not match the parent-anchored snapshot: ${sessionPath} (anchored: ${anchored.sessionFile})`;
    }
  } else {

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
  if (loadout.thinking != null && !isThinkingLevel(loadout.thinking)) {
    return `loadout thinking level invalid: ${loadout.thinking}`;
  }
  if (loadout.thinkingOverride != null && !isThinkingLevel(loadout.thinkingOverride)) {
    return `loadout thinkingOverride invalid: ${loadout.thinkingOverride}`;
  }
  if (loadout.tierThinking != null && !isThinkingLevel(loadout.tierThinking)) {
    return `loadout tierThinking invalid: ${loadout.tierThinking}`;
  }
  if (loadout.parentThinking != null && !isThinkingLevel(loadout.parentThinking)) {
    return `loadout parentThinking invalid: ${loadout.parentThinking}`;
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
  if (loadout.modelIdentity != null) {
    const identity = loadout.modelIdentity;
    if (typeof identity !== "object" || typeof identity.provider !== "string" || typeof identity.id !== "string" || typeof identity.api !== "string" || typeof identity.baseUrl !== "string") {
      return "loadout modelIdentity must carry provider, id, api and baseUrl strings";
    }
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
  function modelReferenceError(
    problem: {
      model: string;
      candidates: readonly string[];
      reason: string;
      message: string;
    },
    field: "model" | "candidate",
  ): PlanOutcome<SpawnPlan> {
    return {
      kind: "error",
      error: problem.message,
      details: {
        error: "invalid model reference",
        field,
        model: problem.model,
        reason: problem.reason,
        candidates: [...problem.candidates],
      },
    };
  }

  function startWatcher(running: RunningSubagent, pi?: ExtensionAPI): StartedRun {
    const watcherAbort = new AbortController();
    running.abortController = watcherAbort;
    deps.startWidgetRefresh();
    if (pi) deps.startStatusRefresh(pi);
    const watch = running.member
      ? Promise.resolve(deps.watchMemberRound(running, watcherAbort.signal))
      : deps.watchSubagent(running, watcherAbort.signal).then((result) => ({
          ...result,
          ...(running.protocol === "codex-v2" ? { protocol: running.protocol, launchPlan: running.launchPlan } : {}),
        }));
    return { running, signal: watcherAbort.signal, watch };
  }

  function planSpawn(
    params: Static<typeof SubagentParams>,
    ctx: SpawnContext,
    planOptions?: SpawnPlanOptions,
  ): PlanOutcome<SpawnPlan> {
    if (planOptions?.protocol === CODEX_V2_SUBAGENT_PROTOCOL && planOptions.forkTurns == null) {
      return {
        kind: "error",
        error: "fork_turns is required; choose none or all",
        details: { error: "fork_turns required" },
      };
    }
    const agentError = validateSpawnText("agent", params?.agent);
    if (agentError) return { kind: "error", error: agentError, details: { error: "agent required" } };
    const taskError = validateSpawnText("task", params?.task);
    if (taskError) return { kind: "error", error: taskError, details: { error: "task required" } };
    const cohortError = validateCohortId(params.cohortId);
    if (cohortError) return { kind: "error", error: cohortError };
    const cohortId = normalizeCohortId(params.cohortId);
    if (cohortId) params.cohortId = cohortId;
    else delete params.cohortId;

    const currentAgent = process.env.PI_SUBAGENT_AGENT;
    if (params.agent && currentAgent && params.agent === currentAgent) {
      const alternativeAgent = currentAgent === "general-purpose"
        ? "explore"
        : currentAgent === "explore"
          ? "general-purpose"
          : null;
      const alternativeHint = alternativeAgent
        ? ` If a separate nested task is needed, choose the other available agent type "${alternativeAgent}" explicitly.`
        : "";
      return {
        kind: "error",
        error:
          `You are the ${currentAgent} agent — do not start another ${currentAgent}. ` +
          `You were spawned to do this work yourself. Complete the task directly.${alternativeHint}`,
        details: { error: "self-spawn blocked" },
      };
    }

    const agentDefs = params.agent ? deps.loadAgentDefaults(params.agent, ctx.cwd) : null;

    const requestedThinking = params.thinking ?? agentDefs?.thinking ?? null;
    if (requestedThinking != null && !isThinkingLevel(requestedThinking)) {
      return {
        kind: "error",
        error: `Invalid thinking level "${requestedThinking}". Use: ${THINKING_LEVELS.join(", ")}.`,
      };
    }
    const requiredCapabilities: ModelCapability[] = [];
    for (const raw of agentDefs?.capabilities ?? []) {
      const capability = normalizeModelCapability(raw);
      if (!capability) {
        return {
          kind: "error",
          error:
            `Invalid capabilities in agent profile "${params.agent}": "${raw}". ` +
            `Use one or more of: ${MODEL_CAPABILITIES.join(", ")}.`,
          details: {
            error: "invalid agent capabilities",
            agent: params.agent,
            invalid: raw,
            supported: [...MODEL_CAPABILITIES],
          },
        };
      }
      if (!requiredCapabilities.includes(capability)) requiredCapabilities.push(capability);
    }

    const { effectiveCwd, localAgentDir, effectiveAgentDir } = resolveSubagentPaths(
      params,
      agentDefs,
      deps.getAgentConfigDir,
    );
    const targetCwdForSession = effectiveCwd ?? ctx.cwd;

    if (params.model !== undefined) {
      if (typeof params.model !== "string" || params.model.trim() === "") {
        return {
          kind: "error",
          error: "Invalid model: must be a non-empty string when provided.",
          details: { error: "invalid model reference", field: "model", model: params.model ?? null },
        };
      }
      params.model = params.model.trim();
      if (ctx.modelRegistry && planOptions?.protocol !== CODEX_V2_SUBAGENT_PROTOCOL) {
        const checked = resolveKnownModelReference(params.model, ctx.modelRegistry);
        if (checked && "problem" in checked) return modelReferenceError(checked.problem, "model");
        if (checked && "resolution" in checked) params.model = checked.resolution.model;
      }
    }

    const tierLoadRef: { value: TierConfigLoadResult | null } = { value: null };
    const tierPool = resolveTierPoolForParams(
      {
        ...params,

        model: params.model ?? (params.tier ? undefined : agentDefs?.model),
        agentTier: agentDefs?.tier,
      },
      () => {
        tierLoadRef.value = loadTierRouteConfig({
          cwd: targetCwdForSession,
          agentConfigDir: effectiveAgentDir,
          injected: deps.resolveHostTierSources(),
        });
        return tierLoadRef.value;
      },
    );
    if ("error" in tierPool) return { kind: "error", error: tierPool.error };

    if (tierPool.pool && ctx.modelRegistry) {
      const normalizedPool: string[] = [];
      for (const candidate of tierPool.pool) {
        const checked = resolveKnownModelReference(candidate, ctx.modelRegistry);
        if (checked && "problem" in checked) return modelReferenceError(checked.problem, "candidate");
        normalizedPool.push(checked && "resolution" in checked ? checked.resolution.model : candidate);
      }
      tierPool.pool = normalizedPool;
    }

    let tierSelection: ModelCandidateSelection | null = null;
    let fallbackReason: SpawnPlan["fallbackReason"] = tierPool.fallbackReason ?? null;

    let tierSelectionSkips: readonly ModelCandidateRejection[] | null = null;
    let modelHealth: ModelHealthMap | undefined;
    if (tierPool.pool !== undefined && deps.modelHealth) {
      modelHealth = deps.modelHealth.read(tierPool.pool);
      deps.modelHealth.refresh(tierPool.pool);
    }
    if (tierPool.pool !== undefined) {
      const outcome = selectModelCandidate(
        tierPool.pool,
        {
          ...(requiredCapabilities.length > 0 ? { capabilities: requiredCapabilities } : {}),
          thinking: requestedThinking ?? tierPool.thinking ?? null,
        },
        ctx.modelRegistry,
        modelHealth,
        planOptions?.excludeModels,
      );
      if ("failure" in outcome) {
        const allStatusBlocked = outcome.failure.rejections.length > 0 &&
          outcome.failure.rejections.every((rejection) =>
            rejection.kind === "status" && !rejection.reason.includes("excluded by failover policy"),
          );
        if (!allStatusBlocked) {
          const rejections = outcome.failure.rejections
            .map((rejection) => `  - ${rejection.model}: ${rejection.reason}`)
            .join("\n");
          const statusSkipped = outcome.failure.rejections.some((rejection) => rejection.kind === "status");
          return {
            kind: "error",
            error:
              `No usable model candidate for tier "${tierPool.tier}": every configured candidate ` +
              `was filtered out (pool: ${outcome.failure.pool.join(", ")}).\n${rejections}` +
              (statusSkipped
                ? "\nNote: status-based skips use the last known runtime status (quota exhausted / offline) " +
                  "and refresh in the background; the static pool config is unchanged."
                : ""),
            details: {
              error: "no usable model candidate",
              tier: tierPool.tier,
              pool: [...outcome.failure.pool],
              requirements: {
                ...(requiredCapabilities.length > 0 ? { capabilities: [...requiredCapabilities] } : {}),
                thinking: requestedThinking ?? tierPool.thinking ?? null,
              },
              rejections: outcome.failure.rejections.map((rejection) => ({ ...rejection })),
            },
          };
        }
        fallbackReason = "pool-status-unavailable";
        tierSelectionSkips = outcome.failure.rejections;
      } else {
        tierSelection = outcome.selection;
        tierSelectionSkips = outcome.selection.skipped;
      }
    }

    const inheritedModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null;
    if (fallbackReason && !inheritedModel) {
      return {
        kind: "error",
        error: `Cannot inherit parent session model for tier "${tierPool.tier}": no parent model is available.`,
        details: { error: "parent model unavailable", tier: tierPool.tier, reason: fallbackReason },
      };
    }
    let effectiveModel = params.model ?? tierSelection?.model ?? agentDefs?.model ?? inheritedModel;
    if (effectiveModel && ctx.modelRegistry && planOptions?.protocol !== CODEX_V2_SUBAGENT_PROTOCOL) {
      const checked = resolveKnownModelReference(effectiveModel, ctx.modelRegistry);
      if (checked && "problem" in checked) return modelReferenceError(checked.problem, "model");
      if (checked && "resolution" in checked) effectiveModel = checked.resolution.model;
    }

    const tierThinking = tierPool.thinking ?? null;
    const effectiveThinking = fallbackReason
      ? ctx.thinkingLevel
      : params.thinking ?? agentDefs?.thinking ?? tierThinking ?? undefined;

    if (requiredCapabilities.length > 0 && effectiveModel && ctx.modelRegistry) {
      const missing = modelMissingCapabilities(effectiveModel, requiredCapabilities, ctx.modelRegistry);
      if (missing != null && missing.length > 0) {
        return {
          kind: "error",
          error:
            `Model "${effectiveModel}" does not support the capabilities required by agent ` +
            `profile "${params.agent}" (missing: ${missing.join(", ")}).`,
          details: {
            error: "missing model capabilities",
            model: effectiveModel,
            required: [...requiredCapabilities],
            missing: [...missing],
          },
        };
      }
    }

    const appliedThinking = effectiveThinking ?? modelOwnThinkingSuffix(effectiveModel) ?? null;
    if (appliedThinking != null && effectiveModel && ctx.modelRegistry) {
      const supported = resolveModelThinkingSupport(effectiveModel, ctx.modelRegistry);
      if (supported != null && !supported.includes(appliedThinking)) {
        return {
          kind: "error",
          error:
            `Model "${effectiveModel}" does not support thinking level "${appliedThinking}" ` +
            `(supported: ${supported.join(", ")}).`,
          details: {
            error: "unsupported thinking level",
            model: effectiveModel,
            requested: appliedThinking,
            supported: [...supported],
          },
        };
      }
    }
    const lifecycleError = validateAgentLifecycleConfig(agentDefs);
    if (lifecycleError) return { kind: "error", error: lifecycleError };
    const timeoutError = validateTimeoutMs(params.timeoutMs);
    if (timeoutError) return { kind: "error", error: timeoutError };
    const effectiveInteractive = resolveEffectiveInteractive(params, agentDefs);
    const effectiveAutoExit = resolveEffectiveAutoExit(agentDefs);

    const memberMode = params.member === true;

    const grantSpawning = subagentTaskDepth() < 2;
    const toolAllowlist = buildSubagentToolAllowlist(agentDefs?.tools, {
      grantSpawning,
      ...(memberMode ? { grantTeamSend: true } : {}),
    });
    if (deps.validateToolProvision && typeof toolAllowlist === "string") {
      const missing = deps.validateToolProvision(toolAllowlist);
      if (missing.length > 0) {
        const error =
          `Agent profile "${params.agent ?? "(unnamed)"}" declares tools that no extension can provide: ` +
          `${missing.join(", ")}. The child would silently start WITHOUT them (pi drops unknown ` +
          `--tools entries without warning). Fix: install the backing extension under ` +
          `${join(deps.getAgentConfigDir(), "extensions")}, or register it via registerToolExtension, ` +
          `or edit the agent profile's tools list.`;
        return {
          kind: "error",
          error,
          details: { error: "unprovidable tools", agent: params.agent ?? null, missing },
        };
      }
    }

    if (params.timeoutMs != null && effectiveInteractive) {
      return {
        kind: "error",
        error:
          `timeoutMs does not apply to interactive (demo) sub-agents: their spawn returns immediately and ` +
          `there is no blocking wait to bound. Drop timeoutMs for this spawn.`,
      };
    }

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

    const requestedDisplayMode = (params as any).display_mode as DisplayMode | undefined;
    const resolvedDisplayMode: DisplayMode = requestedDisplayMode ?? "auto";
    const resolvedSurface = requestedDisplayMode !== undefined
      ? resolveDisplaySurface(resolvedDisplayMode, [
          { mode: "auto", available: true, reason: null },
          { mode: "herdr", available: process.env.HERDR_ENV === "1", reason: null },
          { mode: "tmux", available: !!process.env.TMUX, reason: null },
        ])
      : "background";
    const surfaceChoice = requestedDisplayMode !== undefined
      ? (resolvedSurface === "background" ? { choice: "headless" as const } : { choice: "pane" as const })
      : resolveSurfaceChoice(
          memberMode ? "background" : params.surface,
          memberMode ? false : effectiveInteractive,
        );
    if ("error" in surfaceChoice) return { kind: "error", error: surfaceChoice.error };
    const useHeadless = surfaceChoice.choice === "headless";

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

    const launchBehavior = planOptions?.forkTurns === "all"
      ? {
          sessionMode: "fork" as const,
          seededSessionMode: "fork" as const,
          inheritsConversationContext: true,
          taskDelivery: "direct" as const,
        }
      : planOptions?.protocol === CODEX_V2_SUBAGENT_PROTOCOL && planOptions.forkTurns === "none"
        ? {
            sessionMode: "standalone" as const,
            seededSessionMode: null,
            inheritsConversationContext: false,
            taskDelivery: "artifact" as const,
          }
        : resolveLaunchBehavior(params, agentDefs);
    if (launchBehavior.inheritsConversationContext && planOptions?.protocol !== CODEX_V2_SUBAGENT_PROTOCOL) {
      return {
        kind: "error",
        error: 'session-mode: fork is not supported by this extension. Use "standalone" or "lineage-only".',
      };
    }

    const sessionDir = getDefaultSessionDirFor(targetCwdForSession, effectiveAgentDir);

    const tierConfigProblems =
      tierLoadRef.value?.config && tierLoadRef.value.config.problems.length > 0
        ? tierLoadRef.value.config.problems
        : null;

    const poolSource =
      tierPool.tier != null
        ? tierLoadRef.value?.config?.tiers[tierPool.tier].poolSource ?? null
        : null;

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
        toolAllowlist,
        effectiveSkills: agentDefs?.skills,
        effectiveThinking,
        tierThinking,
        tier: tierPool.tier,
        tierPool: tierPool.pool ?? null,
        tierSelection,
        tierSelectionSkips,
        poolSource,
        tierConfigProblems,
        fallbackReason,
        effectiveAutoExit,
        interactive: effectiveInteractive,
        member: memberMode,
        resolvedDisplayMode,
        useHeadless,
        sessionFile,
        sessionId,
        artifactDir,
        sessionDir,
        launchBehavior,
        launchPlan: createCodexV2LaunchPlanMetadata(`codex-v2-${randomUUID()}`),
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

      toolAllowlist,
      effectiveSkills,
      effectiveAutoExit,
      interactive: effectiveInteractive,
      member: memberMode,
      resolvedDisplayMode,
      useHeadless,
      artifactDir,
      sessionDir,
      launchBehavior,
      launchPlan,
    } = plan;
    const startTime = Date.now();
    const id = Math.random().toString(16).slice(2, 10);
    const sentinelToken = `__PI_SUBAGENT_DONE_${randomUUID()}__`;

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23) + "Z";
    const uuid = [
      id,
      Math.random().toString(16).slice(2, 10),
      Math.random().toString(16).slice(2, 10),
      Math.random().toString(16).slice(2, 6),
    ].join("-");
    const subagentSessionFile = join(sessionDir, `${timestamp}_${uuid}.jsonl`);
    const sessionFile = plan.sessionFile;

    const surfacePreCreated = !!options?.surface;

    const surfaceName = normalizeSubagentName(params.name ?? params.agent ?? "subagent");
    const activityFile = getSubagentActivityFile(artifactDir, id);
    mkdirSync(dirname(activityFile), { recursive: true });

    const grantSpawning = subagentTaskDepth() < 2;

    const resolvedAgentDir =
      localAgentDir && existsSync(localAgentDir)
        ? localAgentDir
        : process.env.PI_CODING_AGENT_DIR ?? null;

    const splitEnv: Record<string, string> = createSubagentLaunchEnv();
    const selectedIdentity = (params as any).modelIdentity as { provider?: string; id?: string; api?: string; baseUrl?: string } | undefined;
    if (selectedIdentity) {
      if (selectedIdentity.provider) splitEnv.PI_SUBAGENT_MODEL_PROVIDER = selectedIdentity.provider;
      if (selectedIdentity.id) splitEnv.PI_SUBAGENT_MODEL_ID = selectedIdentity.id;
      if (selectedIdentity.api) splitEnv.PI_SUBAGENT_MODEL_API = selectedIdentity.api;
      if (selectedIdentity.baseUrl) splitEnv.PI_SUBAGENT_MODEL_BASE_URL = selectedIdentity.baseUrl;
    }
    if (resolvedAgentDir) {
      splitEnv.PI_CODING_AGENT_DIR = resolvedAgentDir;
    }

    splitEnv.PI_SUBAGENT_NAME = surfaceName;
    splitEnv.PI_SUBAGENT_TASK_PATH = `${process.env.PI_SUBAGENT_TASK_PATH ?? "/root"}/${surfaceName}`;
    if (params.agent) {
      splitEnv.PI_SUBAGENT_AGENT = params.agent;
    }
    if (effectiveAutoExit && !memberMode) {
      splitEnv.PI_SUBAGENT_AUTO_EXIT = "1";
    }

    if (!effectiveInteractive && !memberMode) {
      splitEnv.PI_SUBAGENT_BARRIER = "1";
    }
    if (memberMode) {

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

    const esc = useHeadless ? (value: string) => value : shellEscape;
    const parts: string[] = ["pi"];
    parts.push("--session", esc(subagentSessionFile));

    parts.push("-e", esc(join(deps.subagentsDir, "subagent-done.ts")));

    if (needsEnvProxyForTools(toolAllowlist)) {
      splitEnv.NODE_USE_ENV_PROXY = "1";
    }

    const routingSnapshot = buildRoutingSnapshot(plan);
    const parentThinking =
      routingSnapshot.effectiveThinkingSource === "parent" ? routingSnapshot.effectiveThinking : null;

    const loadout: SubagentLoadout = {
      snapshotVersion: SUBAGENT_LOADOUT_VERSION,
      protocol: plan.launchPlan.protocol,
      agent: params.agent ?? null,
      toolAllowlist,
      model: effectiveModel,
      modelIdentity: (params as any).modelIdentity ?? null,
      ...(plan.resolvedDisplayMode !== "auto" ? { surfaceKind: plan.resolvedDisplayMode as SurfaceKind } : {}),
      thinking: agentDefs?.thinking ?? null,
      thinkingOverride: params.thinking ?? null,

      tierThinking: plan.tierThinking,

      parentThinking,

      routing: routingSnapshot,
      tier: plan.tier,
      ...(cohortId ? { cohortId } : {}),
      systemPromptMode: systemPromptMode ?? null,
      identity: identityInSystemPrompt ? identity : null,
      spawnable: null,
      autoExit: memberMode ? false : effectiveAutoExit,
      ...(memberMode ? { member: true } : {}),

      cwd: targetCwdForSession,
      agentDir: resolvedAgentDir,
    };
    writeSubagentLoadout(subagentSessionFile, loadout);

    const appliedThinking = appliedLoadoutThinking(loadout);

    let anchoredLoadoutFile: string | null = null;
    try {
      anchoredLoadoutFile = writeAnchoredLoadout(artifactDir, subagentSessionFile, loadout);
    } catch (error) {
      debugLog(`Could not persist anchored loadout for ${surfaceName}`, error);
    }

    const contextFiles: string[] = deps.applySandboxToParts(
      parts,
      loadout,
      { artifactDir, name: surfaceName },
      { escape: esc },
    );
    if (anchoredLoadoutFile) contextFiles.push(anchoredLoadoutFile);

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

    const memberFirstRoundId = memberMode ? randomUUID() : null;
    let child: HeadlessChild | null = null;
    let surface: string;
    if (useHeadless) {

      const rpcArgs = ["--mode", "rpc", ...parts.slice(1, basePartsLength)];
      const initialPromptId = `initial-${id}`;
      let initialPromptPending = true;
      child = deps.spawnHeadlessPi(
        { args: rpcArgs, cwd: targetCwdForSession, env: splitEnv },
        (event) => {

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

      try {
        child.send({
          id: initialPromptId,
          type: "prompt",
          message: memberFirstRoundId
            ? buildTeamRoundPrompt(memberFirstRoundId, deps.buildHeadlessPrompt(effectiveSkills, fullTask))
            : deps.buildHeadlessPrompt(effectiveSkills, fullTask),
        });
      } catch (err) {

        try {
          child.kill();
        } catch (closeError) {
          debugLog(`Could not kill failed headless launch ${surface}`, closeError);
        }
        throw err;
      }
    } else {
      surface = options?.surface ?? (plan.resolvedDisplayMode !== "auto" && deps.createSurfaceFor
        ? deps.createSurfaceFor(plan.resolvedDisplayMode as SurfaceKind, surfaceName, { cwd: effectiveCwd ?? undefined, env: splitEnv })
        : deps.createSurface(surfaceName, { cwd: effectiveCwd ?? undefined, env: splitEnv }));
      if (!surfacePreCreated) {
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, deps.getShellReadyDelayMs()));
      }

      const command = `${parts.join(" ")}${sentinelSuffix(sentinelToken)}`;
      try {
        deps.sendCommand(surface, command);
      } catch (err) {

        try {
          deps.closeSurface(surface);
        } catch (closeError) {
          debugLog(`Could not close failed launch pane ${surface}`, closeError);
        }
        throw err;
      }
    }

    const runtimeFile = deps.registry.pathFor(artifactDir);
    try {
      const running: RunningSubagent = {
        id,
        name: surfaceName,
        task: params.task,
        ...(cohortId ? { cohortId } : {}),
        agent: params.agent,
        model: effectiveModel,
        ...(loadout.modelIdentity ? { modelIdentity: loadout.modelIdentity } : {}),
        thinking: appliedThinking,
        protocol: launchPlan.protocol,
        launchPlan,

        ...(plan.tier != null ? { tier: plan.tier } : {}),
        ...(plan.tierPool != null ? { modelPool: plan.tierPool } : {}),

        modelRouting: routingSnapshot,
        canonicalTaskName: `${process.env.PI_SUBAGENT_TASK_PATH ?? "/root"}/${surfaceName}`,
        parentCanonicalTaskName: process.env.PI_SUBAGENT_TASK_PATH ?? "/root",
        parentId: process.env.PI_SUBAGENT_ID ?? null,
        ...(params.timeoutMs != null ? { timeoutMs: params.timeoutMs } : {}),
        waitMode: memberMode ? "member-round" : effectiveInteractive ? "interactive" : "hard-barrier",
        surface,
        ...(plan.resolvedDisplayMode !== "auto" && !useHeadless ? { surfaceKind: plan.resolvedDisplayMode as SurfaceKind } : {}),
        startTime,
        sessionFile: subagentSessionFile,
        hostSessionId: ctx.sessionManager.getSessionId(),
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
    if (effectiveLoadout.surfaceKind) setActiveSurfaceKind(effectiveLoadout.surfaceKind);
    const { autoExit, interactive } = deps.resolveResumeLaunchBehavior();
    const startTime = Date.now();
    const id = Math.random().toString(16).slice(2, 10);
    const launchPlan = createCodexV2LaunchPlanMetadata(`codex-v2-resume-${randomUUID()}`);
    const sentinelToken = `__PI_SUBAGENT_DONE_${randomUUID()}__`;
    const activityFile = getSubagentActivityFile(artifactDir, id);
    mkdirSync(dirname(activityFile), { recursive: true });

    const resumeEnv: Record<string, string> = createSubagentLaunchEnv();
    if (effectiveLoadout.modelIdentity) {
      resumeEnv.PI_SUBAGENT_MODEL_PROVIDER = effectiveLoadout.modelIdentity.provider;
      resumeEnv.PI_SUBAGENT_MODEL_ID = effectiveLoadout.modelIdentity.id;
      resumeEnv.PI_SUBAGENT_MODEL_API = effectiveLoadout.modelIdentity.api;
      resumeEnv.PI_SUBAGENT_MODEL_BASE_URL = effectiveLoadout.modelIdentity.baseUrl;
    }
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

    if (!interactive) resumeEnv.PI_SUBAGENT_BARRIER = "1";

    if (needsEnvProxyForTools(effectiveLoadout.toolAllowlist)) {
      resumeEnv.NODE_USE_ENV_PROXY = "1";
    }

    try { rmSync(`${sessionPath}.exit`, { force: true }); } catch {}
    try { rmSync(`${sessionPath}.ask`, { force: true }); } catch {}

    const surfaceChoice = resolveSurfaceChoice(undefined, false);
    const useHeadless = "choice" in surfaceChoice && surfaceChoice.choice === "headless";
    const runtimeFile = deps.registry.pathFor(artifactDir);
    let createdSurface: string | null = null;
    let child: HeadlessChild | null = null;
    try {
      if (useHeadless) {

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

        model: effectiveLoadout.model ?? null,
        ...(effectiveLoadout.modelIdentity ? { modelIdentity: effectiveLoadout.modelIdentity } : {}),
        thinking: appliedLoadoutThinking(effectiveLoadout),
        protocol: launchPlan.protocol,
        launchPlan,

        ...(effectiveLoadout.tier != null ? { tier: effectiveLoadout.tier } : {}),
        ...(effectiveLoadout.routing?.pool != null
          ? { modelPool: [...effectiveLoadout.routing.pool] }
          : {}),
        modelRouting: effectiveLoadout.routing ?? null,
        canonicalTaskName: `${process.env.PI_SUBAGENT_TASK_PATH ?? "/root"}/${name}`,
        parentCanonicalTaskName: process.env.PI_SUBAGENT_TASK_PATH ?? "/root",
        parentId: process.env.PI_SUBAGENT_ID ?? null,
        ...(plan.timeoutMs != null ? { timeoutMs: plan.timeoutMs } : {}),
        waitMode: "hard-barrier",
        surface: createdSurface as string,
        ...(effectiveLoadout.surfaceKind ? { surfaceKind: effectiveLoadout.surfaceKind } : {}),
        startTime,
        sessionFile: sessionPath,
        hostSessionId: ctx.sessionManager.getSessionId(),
        activityFile,
        interactive,
        sentinelToken,
        runtimeFile,
        statusState: createStatusState({ source: "pi", startTimeMs: startTime }),
        kind: useHeadless ? "headless" : "pane",
        ...(child && child.pid != null ? { pid: child.pid, headlessChild: child } : {}),
      };
      deps.registry.removeRecordsForSession(runtimeFile, sessionPath);
      deps.registry.add(running);
      return {
        ...startWatcher(running, pi),
        resumedSessionId: plan.resumedSessionId,
        entryCountBefore: plan.entryCountBefore,
      };
    } catch (error) {

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
    const publicPath = deps.registry.publicPathFor(dirname(runtimeFile));
    const waitingIds = new Set(
      deps.registry.listPublic(publicPath)
        .filter((entry) => entry.status === "waiting")
        .map((entry) => entry.agent_id),
    );
    for (const record of deps.registry.recoverableRecords(runtimeFile)) {

      try {
        if ((record.kind ?? "pane") === "headless") {

          const pid = record.pid ?? parseHeadlessSurface(record.surface);
          if (record.interruptedRound || waitingIds.has(record.id)) {
            if (pid != null && deps.isPidAlive(pid)) {
              deps.terminateHeadlessProcess(pid);
            }
            deps.registry.updatePublicStatus(
              deps.registry.publicPathFor(dirname(runtimeFile)),
              record.id,
              "waiting",
              "Current round interrupted; context is preserved for follow-up.",
            );
            deps.registry.removeRecord(runtimeFile, record.id);
            continue;
          }
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

          const headlessActivityFile = record.activityFile
            ?? getSubagentActivityFile(dirname(runtimeFile), record.id);
          const headlessActivityRead = readSubagentActivityFile(headlessActivityFile, record.id);
          const doneDeclared = headlessActivityRead.ok && isTerminalDoneActivity(headlessActivityRead.activity);
          if (pid == null || !deps.isPidAlive(pid) || doneDeclared) {
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

          const recoveredLoadout = readSubagentLoadout(record.sessionFile);
          const running: RunningSubagent = {
            id: record.id,
            name: record.name,
            task: record.task,
            ...(record.cohortId ? { cohortId: record.cohortId } : {}),
            agent: record.agent,
            model: recoveredLoadout?.model ?? null,
            thinking: recoveredLoadout ? appliedLoadoutThinking(recoveredLoadout) : null,
            ...(recoveredLoadout?.tier != null ? { tier: recoveredLoadout.tier } : {}),
            ...(recoveredLoadout?.routing?.pool != null
              ? { modelPool: [...recoveredLoadout.routing.pool] }
              : {}),
            modelRouting: recoveredLoadout?.routing ?? null,
            canonicalTaskName: record.canonicalTaskName ?? `${record.parentCanonicalTaskName ?? "/root"}/${record.name}`,
            parentCanonicalTaskName: record.parentCanonicalTaskName ?? "/root",
            parentId: record.parentId ?? null,
            ...(record.timeoutMs != null ? { timeoutMs: record.timeoutMs } : {}),
            ...(record.waitReleased ? { waitReleased: record.waitReleased } : {}),
            waitMode: "recovered",
            surface: record.surface,
            startTime: record.startTime,
            sessionFile: record.sessionFile,
            ...(record.hostSessionId ? { hostSessionId: record.hostSessionId } : {}),
            activityFile: headlessActivityFile,
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

        if (record.interruptedRound || waitingIds.has(record.id)) {
          try {
            deps.closeSurface(record.surface);
          } catch (error) {
            debugLog(`Could not close interrupted recovered surface ${record.surface}`, error);
          }
          deps.registry.updatePublicStatus(
            deps.registry.publicPathFor(dirname(runtimeFile)),
            record.id,
            "waiting",
            "Current round interrupted; context is preserved for follow-up.",
          );
          deps.registry.removeRecord(runtimeFile, record.id);
          continue;
        }

        if (record.surfaceKind) setActiveSurfaceKind(record.surfaceKind);
        if (!deps.adoptSurface(record.surface)) {
          deps.registry.removeRecord(runtimeFile, record.id);
          continue;
        }

        const recoveredLoadout = readSubagentLoadout(record.sessionFile);
        const running: RunningSubagent = {
          id: record.id,
          name: record.name,
          task: record.task,
          ...(record.cohortId ? { cohortId: record.cohortId } : {}),
          agent: record.agent,
          model: recoveredLoadout?.model ?? null,
          thinking: recoveredLoadout ? appliedLoadoutThinking(recoveredLoadout) : null,
          ...(recoveredLoadout?.tier != null ? { tier: recoveredLoadout.tier } : {}),
          ...(recoveredLoadout?.routing?.pool != null
            ? { modelPool: [...recoveredLoadout.routing.pool] }
            : {}),
          modelRouting: recoveredLoadout?.routing ?? null,
          canonicalTaskName: record.canonicalTaskName ?? `${record.parentCanonicalTaskName ?? "/root"}/${record.name}`,
          parentCanonicalTaskName: record.parentCanonicalTaskName ?? "/root",
          parentId: record.parentId ?? null,
          ...(record.timeoutMs != null ? { timeoutMs: record.timeoutMs } : {}),
          ...(record.waitReleased ? { waitReleased: record.waitReleased } : {}),
          waitMode: "recovered",
          surface: record.surface,
          startTime: record.startTime,
          sessionFile: record.sessionFile,
          ...(record.hostSessionId ? { hostSessionId: record.hostSessionId } : {}),
          activityFile: record.activityFile ?? getSubagentActivityFile(dirname(runtimeFile), record.id),
          interactive: record.interactive,
          sentinelToken: record.sentinelToken,
          runtimeFile,
          statusState: createStatusState({ source: "pi", startTimeMs: record.startTime }),
        };
        deps.registry.track(running);
        recovered.push({ kind: "running", recovered: "pane", run: startWatcher(running) });
      } catch (error) {

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
