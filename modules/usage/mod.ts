import { randomUUID } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ModuleContext } from "../../kit/module.ts";
import type { ServiceRegistry } from "../../kit/services.ts";
import {
  PROVIDERS_POOL_USAGE_SERVICE_NAME,
  type ProvidersPoolUsageService,
} from "../providers/api.ts";
import {
  SUBAGENTS_MODELS_SERVICE_NAME,
  type SubagentsModelsService,
} from "../subagents/index.ts";
import {
  USAGE_RECORDER_SERVICE_NAME,
  USAGE_SNAPSHOT_SERVICE_NAME,
  type UsageRecord,
  type UsageRecorderService,
  type UsageRunEvent,
  type UsageSnapshotQuery,
  type UsageSnapshotService,
  type UsageSnapshotView,
} from "./api.ts";
import { buildUsageSnapshot, flattenPoolModels, type UsagePoolEntry } from "./aggregate.ts";
import { appendUsageRecord, createUsageRecord, readUsageRecords, usageJournalPath } from "./journal.ts";

export interface UsageRuntimeOptions {
  readonly agentDir: string;
  readonly services: ServiceRegistry;

  readonly getSessionId?: () => string | null;
}

export interface UsageRuntime {
  readonly journalPath: string;
  snapshot(query?: UsageSnapshotQuery): UsageSnapshotView;
  refresh(query?: UsageSnapshotQuery): Promise<void>;
  record(event: UsageRunEvent): UsageRecord | null;
}

function resolveModels(services: ServiceRegistry): SubagentsModelsService | undefined {
  return services.get<SubagentsModelsService>(SUBAGENTS_MODELS_SERVICE_NAME);
}

function resolveProviderUsage(services: ServiceRegistry): ProvidersPoolUsageService | undefined {
  return services.get<ProvidersPoolUsageService>(PROVIDERS_POOL_USAGE_SERVICE_NAME);
}

export function createUsageRuntime(options: UsageRuntimeOptions): UsageRuntime {
  const journalPath = usageJournalPath(options.agentDir);
  const getSessionId = options.getSessionId ?? (() => null);

  let revision = 0;
  let signature: string | undefined;

  const poolsOf = (cwd?: string): UsagePoolEntry[] => {
    const models = resolveModels(options.services);
    return models ? [...models.pools(cwd)] : [];
  };

  const snapshot = (query?: UsageSnapshotQuery): UsageSnapshotView => {
    const now = query?.now ?? Date.now();
    const pools = poolsOf(query?.cwd);
    const poolRefs = flattenPoolModels(pools).map((model) => model.model);
    const models = resolveModels(options.services);
    const providerUsage = resolveProviderUsage(options.services);
    const view = buildUsageSnapshot({
      records: readUsageRecords(journalPath),
      pools,
      health: models ? models.health(poolRefs) : new Map(),
      poolUsage: providerUsage ? providerUsage.snapshot(poolRefs) : [],
      sessionId: getSessionId(),
      now,
      revision,
    });

    const nextSignature = JSON.stringify({ ...view, revision: 0, generatedAt: 0 });
    if (signature !== undefined && nextSignature !== signature) revision += 1;
    signature = nextSignature;
    return { ...view, revision };
  };

  const refresh = async (query?: UsageSnapshotQuery): Promise<void> => {
    const poolRefs = flattenPoolModels(poolsOf(query?.cwd)).map((model) => model.model);
    if (poolRefs.length === 0) return;
    const providerUsage = resolveProviderUsage(options.services);
    if (!providerUsage) return;
    try {
      await providerUsage.refresh(poolRefs);
    } catch {

    }
  };

  const record = (event: UsageRunEvent): UsageRecord | null => {
    const entry = createUsageRecord(event, {
      id: randomUUID(),
      at: Date.now(),
      sessionId: getSessionId(),
    });
    try {
      appendUsageRecord(journalPath, entry);
    } catch {
      return null;
    }
    return entry;
  };

  return { journalPath, snapshot, refresh, record };
}

export function registerUsage(context: ModuleContext): void {
  let sessionId: string | null = null;
  const runtime = createUsageRuntime({
    agentDir: getAgentDir(),
    services: context.services,
    getSessionId: () => sessionId,
  });

  context.pi.on("session_start", (_event, ctx) => {
    sessionId = ctx.sessionManager.getSessionId();

    void runtime.refresh({ cwd: ctx.cwd });
  });
  context.pi.on("session_shutdown", () => {
    sessionId = null;
  });

  context.services.register(USAGE_SNAPSHOT_SERVICE_NAME, {
    id: "usage",
    snapshot: (query?: UsageSnapshotQuery) => runtime.snapshot(query),
    refresh: (query?: UsageSnapshotQuery) => runtime.refresh(query),
  } satisfies UsageSnapshotService);

  context.services.register(USAGE_RECORDER_SERVICE_NAME, {
    id: "usage",
    record: (event: UsageRunEvent) => runtime.record(event),
  } satisfies UsageRecorderService);
}
