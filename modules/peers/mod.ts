import { statSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ModuleContext } from "../../kit/module.ts";
import {
  PEERS_DISCOVERY_SERVICE_NAME,
  type PeersDiagnostic,
  type PeersDiscoverySnapshot,
  type PeersScanFn,
  type PeersScanResult,
  type PeersSettings,
  type PeersSnapshotError,
} from "./api.ts";
import { readPeersSettings } from "./config.ts";
import { collectPeerSessionCandidates, mergePeerDiscovery, type PeerSessionCandidate } from "./discovery.ts";
import { createPeersEndpointServer, createPeersTransport, type PeersEndpointServer } from "./endpoint.ts";
import { cleanupPeersExpiredFiles } from "./file-store.ts";
import { registerPeersListTool } from "./list-tool.ts";
import {
  createPeersDedupeWindow,
  createPeersInboundHandler,
  createPeersRateGuard,
  deliverPeersIdleNotice,
  judgePeersInboundRequest,
  subscribePeersIdle,
} from "./messaging.ts";
import { registerPeersNotifyIdleTool } from "./notify-idle-tool.ts";
import { createPeersIdleSubscriptionTable, clampPeersIdleSubscriptionTtl } from "./subscriptions.ts";
import { registerPeersRenderers } from "./renderer.ts";
import { registerPeersSendTool } from "./send-tool.ts";
import { createHeartbeatMaintainer, readPeerRegistrationByIdentity, readPeerRegistrations } from "./registry.ts";
import { createPeersDiskScanner, type PeersDiskScanner } from "./scan.ts";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const PEERS_DIAGNOSTICS_LIMIT = 50;

export interface PeersRuntimeOptions {
  readonly agentDir: string;

  readonly getConfig?: () => Record<string, unknown>;

  readonly scan?: PeersScanFn;

  readonly diskScanner?: PeersDiskScanner;

  readonly now?: () => number;
}

export interface PeersRuntime {

  initialize(): void;

  activate(): void;

  dispose(): void;
  snapshot(): PeersDiscoverySnapshot;
  refresh(): Promise<void>;
  diagnostics(): readonly PeersDiagnostic[];

  reportRuntime(detail: string): void;

  takeUnreportedDiagnostics(): readonly PeersDiagnostic[];
}

export function createPeersRuntime(options: PeersRuntimeOptions): PeersRuntime {
  const getConfig = options.getConfig ?? (() => ({}));

  let diskScanner: PeersDiskScanner | undefined = options.diskScanner;
  const defaultScan = (request: { readonly now: number }): PeersScanResult => {

    diskScanner ??= createPeersDiskScanner({ agentDir: options.agentDir });
    const { settings } = readPeersSettings(getConfig());
    const { registrations } = readPeerRegistrations(options.agentDir, {
      now: request.now,
      settings,
    });
    const liveCount = registrations.filter((read) => read.liveness !== "offline").length;

    const disk = diskScanner.scan({ limit: settings.listEntryLimit + liveCount });
    return mergePeerDiscovery({ registrations, disk, limit: settings.listEntryLimit });
  };
  const scan = options.scan ?? defaultScan;
  const now = options.now ?? Date.now;

  let online: PeersScanResult["online"] = [];
  let offline: PeersScanResult["offline"] = [];
  let truncated = false;
  let revision = 0;

  let signature: string | undefined;
  let snapshotCache: PeersDiscoverySnapshot = {
    generatedAt: now(),
    revision: 0,
    online,
    offline,
    truncated: false,
    error: null,
  };

  const diagnostics: PeersDiagnostic[] = [];
  let reportedCount = 0;
  let disposed = false;

  let initFailed = false;
  let inFlight: Promise<void> | undefined;

  const apply = (nextError: Omit<PeersSnapshotError, "at"> | null): void => {
    const at = now();
    const error = nextError ? { ...nextError, at } : null;
    const nextSignature = JSON.stringify({
      online,
      offline,
      truncated,
      errorKind: error?.kind,
      errorDetail: error?.detail,
    });
    if (signature !== undefined && nextSignature !== signature) revision += 1;
    signature = nextSignature;
    snapshotCache = { generatedAt: at, revision, online, offline, truncated, error };
  };

  const recordDiagnostic = (kind: PeersDiagnostic["kind"], detail: string): void => {

    const existing = diagnostics.findIndex((entry) => entry.kind === kind && entry.detail === detail);
    if (existing >= 0) {
      diagnostics[existing] = { ...diagnostics[existing], at: now() };
      return;
    }
    diagnostics.push({ kind, detail, at: now() });
    if (diagnostics.length > PEERS_DIAGNOSTICS_LIMIT) {
      const dropped = diagnostics.length - PEERS_DIAGNOSTICS_LIMIT;
      diagnostics.splice(0, dropped);

      reportedCount = Math.max(0, reportedCount - dropped);
    }
  };

  const runRefresh = async (): Promise<void> => {
    try {
      const result = await scan({ now: now() });
      online = result.online;
      offline = result.offline;
      truncated = result.truncated;
      apply(null);
    } catch (scanError) {

      const detail = describeError(scanError);
      recordDiagnostic("runtime", detail);
      apply({ kind: "scan-failed", detail });
    }
  };

  const runInitChecks = (recordProblems: boolean): void => {
    const { warnings } = readPeersSettings(getConfig());
    if (recordProblems && warnings.length > 0) recordDiagnostic("init", warnings.join("；"));
    try {

      if (!statSync(options.agentDir).isDirectory()) {
        throw new Error("agentDir 不是目录");
      }
      if (initFailed) {

        initFailed = false;
        apply(null);
      }
    } catch (initError) {
      initFailed = true;
      if (recordProblems) {
        const detail = describeError(initError);
        recordDiagnostic("init", detail);
        apply({ kind: "init-failed", detail });
      }
    }
  };

  return {
    initialize(): void {
      runInitChecks(true);
    },

    activate(): void {
      disposed = false;

      if (initFailed) runInitChecks(false);
    },

    dispose(): void {
      disposed = true;
    },

    snapshot(): PeersDiscoverySnapshot {
      return snapshotCache;
    },

    refresh(): Promise<void> {
      if (disposed || initFailed) return Promise.resolve();

      if (!inFlight) {
        inFlight = runRefresh().finally(() => {
          inFlight = undefined;
        });
      }
      return inFlight;
    },

    diagnostics(): readonly PeersDiagnostic[] {
      return diagnostics;
    },

    reportRuntime(detail: string): void {
      recordDiagnostic("runtime", detail);
    },

    takeUnreportedDiagnostics(): readonly PeersDiagnostic[] {
      const pending = diagnostics.slice(reportedCount);
      reportedCount = diagnostics.length;
      return pending;
    },
  };
}

export interface PeersModuleOptions {

  readonly agentDir?: string;

  readonly scan?: PeersScanFn;

  readonly diskScanner?: PeersDiskScanner;

  readonly now?: () => number;
}

export function registerPeers(context: ModuleContext, moduleOptions: PeersModuleOptions = {}): void {
  const agentDir = moduleOptions.agentDir ?? getAgentDir();

  const diskScanner = moduleOptions.diskScanner ?? createPeersDiskScanner({ agentDir });
  const runtime = createPeersRuntime({
    agentDir,
    getConfig: () => context.getConfig(),
    scan: moduleOptions.scan,
    diskScanner,
    now: moduleOptions.now,
  });
  runtime.initialize();

  const currentSettings = (): PeersSettings => readPeersSettings(context.getConfig()).settings;

  const now = moduleOptions.now ?? Date.now;
  const idleSubscriptions = createPeersIdleSubscriptionTable({ now });

  const heartbeat = createHeartbeatMaintainer({
    agentDir,
    getSettings: () => readPeersSettings(context.getConfig()).settings,
    now: moduleOptions.now,
    onError: (detail) => runtime.reportRuntime(detail),
    onTick: () => {
      cleanupPeersExpiredFiles(agentDir, currentSettings().fileTtlMs, (moduleOptions.now ?? Date.now)());
      idleSubscriptions.maintain(now());
    },
  });

  const rateGuard = createPeersRateGuard({
    getSettings: () => currentSettings(),
  });

  const transport = createPeersTransport();

  let injectedSinceIdle = 0;

  const loadRegistryCandidates = (): readonly PeerSessionCandidate[] => {
    const settings = currentSettings();
    const at = now();
    const { registrations } = readPeerRegistrations(agentDir, { now: at, settings });
    return [...collectPeerSessionCandidates({ registrations, disk: [] }).values()];
  };

  const loadAllCandidates = (): readonly PeerSessionCandidate[] | { failure: string } => {
    const settings = currentSettings();
    const at = now();
    try {
      const { registrations } = readPeerRegistrations(agentDir, { now: at, settings });
      const disk = diskScanner.scan();
      return [...collectPeerSessionCandidates({ registrations, disk: disk.sessions }).values()];
    } catch (error) {
      return { failure: describeError(error) };
    }
  };

  const sendDeps = {
    getOwnIdentity: () => heartbeat.identity(),
    loadCandidates: loadAllCandidates,
    loadRegistryCandidates,
    transport,
    getSettings: () => readPeersSettings(context.getConfig()).settings,
    agentDir,
    rateGuard,
    reportDiagnostic: (detail: string) => runtime.reportRuntime(detail),
    now,
  };

  const flushIdleNotices = (kind: "idle" | "exit"): void | Promise<void> => {
    const triggered = idleSubscriptions.takeTriggered(now());
    if (triggered.length === 0) return;
    return Promise.allSettled(
      triggered.map((subscription) =>
        deliverPeersIdleNotice(sendDeps, {
          subscriptionId: subscription.subscriptionId,
          sessionId: subscription.sessionId,
          instanceId: subscription.instanceId,
          kind,
        }),
      ),
    ).then(() => undefined);
  };

  const inboundHandler = createPeersInboundHandler({
    getOwnIdentity: () => heartbeat.identity(),

    findSourceRegistration: (instanceId, now, sessionId) =>
      readPeerRegistrationByIdentity(agentDir, {
        sessionId,
        instanceId,
        now,
        settings: currentSettings(),
        onDiagnostic: (detail) => runtime.reportRuntime(detail),
      }),
    dedupe: createPeersDedupeWindow({ getWindowMs: () => currentSettings().dedupeWindowMs, now: moduleOptions.now ?? Date.now }),
    inject: (message, deliverOptions) => {
      injectedSinceIdle += 1;
      try {
        return context.pi.sendMessage(message, deliverOptions);
      } catch (error) {
        injectedSinceIdle = Math.max(0, injectedSinceIdle - 1);
        throw error;
      }
    },
    now: moduleOptions.now ?? Date.now,
    getThrottle: () => currentSettings(),
    rateGuard,
    agentDir,
    reportDiagnostic: (detail) => runtime.reportRuntime(detail),
  });

  let endpointServer: PeersEndpointServer | undefined;
  const startEndpoint = (): void => {
    endpointServer?.close();
    const instanceId = heartbeat.instanceId();
    if (!instanceId) return;
    const next = createPeersEndpointServer({
      agentDir,
      instanceId,
      getSettings: () => currentSettings(),

      onRequest: inboundHandler,
      onSubscribe: async (frame) => {
        const at = now();
        const settings = currentSettings();
        const own = heartbeat.identity();
        const source = readPeerRegistrationByIdentity(agentDir, {
          sessionId: frame.sessionId,
          instanceId: frame.instanceId,
          now: at,
          settings,
          onDiagnostic: (detail) => runtime.reportRuntime(detail),
        });
        const judgment = judgePeersInboundRequest({
          request: frame,
          ownSessionId: own?.sessionId ?? null,
          ownInstanceId: own?.instanceId ?? null,
          sourceRegistration: source,
          duplicate: false,
          throttle: {
            queueDepth: 0,
            queueLimit: settings.inboundQueueLimit,
            rateAllowed: rateGuard.allowsInbound(frame.sessionId, own?.sessionId ?? null, at),
          },
        });
        if (judgment.result !== "accepted") {
          return { result: judgment.result, reason: judgment.reason };
        }
        rateGuard.recordInbound(frame.sessionId, own?.sessionId ?? null, at);
        const armed = idleSubscriptions.arm({
          subscriptionId: frame.subscriptionId,
          sessionId: frame.sessionId,
          instanceId: frame.instanceId,
          ttlMs: clampPeersIdleSubscriptionTtl(frame.ttlMs),
          targetIdle:
            heartbeat.activity() === "idle" && heartbeat.blockedState() === null && injectedSinceIdle === 0,
        });
        if (armed.state === "fired") {
          const notice = await deliverPeersIdleNotice(sendDeps, {
            subscriptionId: frame.subscriptionId,
            sessionId: frame.sessionId,
            instanceId: frame.instanceId,
            kind: "idle",
          });
          if (!notice.ok) {
            return { result: "error" as const, reason: "receiver-injection-failed" as const };
          }
        }
        return {
          result: "accepted" as const,
          reason: null,
          subscription: {
            id: frame.subscriptionId,
            expiresAt: armed.subscription.expiresAt,
            state: armed.state,
          },
        };
      },

      onError: (detail) => {
        if (endpointServer === next) heartbeat.setEndpoint(null);
        runtime.reportRuntime(detail);
      },
      now: moduleOptions.now,
    });
    endpointServer = next;
    void next.start().then(
      (address) => {

        if (endpointServer === next && heartbeat.instanceId() === instanceId) {
          heartbeat.setEndpoint(address);
        }
      },
      (error) => runtime.reportRuntime(describeError(error)),
    );
  };

  context.pi.on("session_start", (_event, ctx) => {
    runtime.activate();
    if (ctx.hasUI) {
      const t = context.t;
      for (const diagnostic of runtime.takeUnreportedDiagnostics()) {
        const key = diagnostic.kind === "init" ? "module.peers.problem.init" : "module.peers.problem.runtime";
        ctx.ui.notify(t(key, { detail: diagnostic.detail }), "warning");
      }
    }

    if (runtime.snapshot().error?.kind !== "init-failed") {
      heartbeat.start({
        sessionId: ctx.sessionManager.getSessionId(),
        name: ctx.sessionManager.getSessionName() ?? null,
        cwd: ctx.cwd,
      });
      startEndpoint();
    }
    void runtime.refresh();
  });

  context.pi.on("agent_start", () => {
    injectedSinceIdle = 0;
    heartbeat.setActivity("working");
  });
  context.pi.on("agent_settled", () => {
    injectedSinceIdle = 0;
    heartbeat.setBlocked(null);
    heartbeat.setActivity("idle");
    void flushIdleNotices("idle");
  });

  context.pi.on("ui_prompt_start", (event) =>
    heartbeat.setBlocked({ waitingFor: `ui-prompt:${event.kind}`, since: (moduleOptions.now ?? Date.now)() }),
  );
  context.pi.on("ui_prompt_end", () => heartbeat.setBlocked(null));

  context.pi.on("session_info_changed", (event) => heartbeat.setName(event.name ?? null));
  context.pi.on("session_shutdown", () => {
    const finish = (): void => {
      endpointServer?.close();
      endpointServer = undefined;
      heartbeat.stop();
      runtime.dispose();
    };
    const flushing = flushIdleNotices("exit");
    if (flushing === undefined) {
      finish();
      return;
    }
    return flushing.then(finish, finish);
  });

  context.services.register(PEERS_DISCOVERY_SERVICE_NAME, {
    id: "peers",
    snapshot: () => runtime.snapshot(),
    refresh: () => runtime.refresh(),
  });

  registerPeersListTool(context.pi, {
    getSnapshot: () => runtime.snapshot(),
    refresh: () => runtime.refresh(),
    getInstanceId: () => heartbeat.instanceId(),
    label: context.t("module.peers.tool.list.label"),
    t: context.t,
  });

  const subscribeIdle = (target: string, ttlMs: number) => subscribePeersIdle(sendDeps, target, ttlMs);

  registerPeersSendTool(context.pi, {
    getOwnIdentity: () => heartbeat.identity(),
    loadRegistryCandidates,
    loadCandidates: loadAllCandidates,
    reportDiagnostic: (detail) => runtime.reportRuntime(detail),
    transport,
    getSettings: () => currentSettings(),
    agentDir,
    rateGuard,
    now: moduleOptions.now,
    label: context.t("module.peers.tool.send.label"),
    t: context.t,
    subscribeIdle,
  });

  registerPeersNotifyIdleTool(context.pi, {
    ...sendDeps,
    label: context.t("module.peers.tool.notify.label"),
    t: context.t,
  });

  registerPeersRenderers(context.pi, (key, vars) => context.t(key, vars));
}
