// 模型与用量面板模块实现（工单 28）：共享快照控制器 + 服务句柄 + 会话绑定。
//
// 快照的输入全部来自既有接缝，不重复造轮子：
// - 候选池与编排判定：`subagents.models` 句柄（工单 25/26 的健康网关，含错误观测）；
// - 余额/额度原始观测：`providers.pool-usage` 句柄（工单 25，未知保持未知）；
// - 运行统计：子代理终态经 `usage.recorder` 写入的 append-only 统计日志。
//
// 读侧 `usage.snapshot` 是只读编排查询接口（面板与编排共用同一份快照）；
// 写侧 `usage.recorder` 只给子代理模块在终态调用。统计落盘失败只返回 null，
// 绝不让用量统计阻断子代理终态投递。

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
  /** 当前宿主会话 id（由 session_start 绑定；未绑定为 null） */
  readonly getSessionId?: () => string | null;
}

/** 统计运行时：快照读出、后台刷新与终态记录（句柄注册前的可测接口）。 */
export interface UsageRuntime {
  readonly journalPath: string;
  snapshot(query?: UsageSnapshotQuery): UsageSnapshotView;
  refresh(query?: UsageSnapshotQuery): Promise<void>;
  record(event: UsageRunEvent): UsageRecord | null;
}

/** 句柄查找延迟到每次调用（模块可禁用、装配顺序无关）；缺席即空。 */
function resolveModels(services: ServiceRegistry): SubagentsModelsService | undefined {
  return services.get<SubagentsModelsService>(SUBAGENTS_MODELS_SERVICE_NAME);
}

function resolveProviderUsage(services: ServiceRegistry): ProvidersPoolUsageService | undefined {
  return services.get<ProvidersPoolUsageService>(PROVIDERS_POOL_USAGE_SERVICE_NAME);
}

export function createUsageRuntime(options: UsageRuntimeOptions): UsageRuntime {
  const journalPath = usageJournalPath(options.agentDir);
  const getSessionId = options.getSessionId ?? (() => null);
  // 变更序号：内容变才递增（与 status 模块的 createRevisionReader 同一口径），
  // 供将来接重绘节奏；用户面板每次打开直接重读文件，不依赖内存缓存。
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
    // 签名用于变更序号：排除每次调用都会变的 revision / generatedAt，
    // 只有快照内容真的变了才递增（否则重绘节奏会被时钟顶着每秒重绘）。
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
      // 刷新型查询失败只影响状态新鲜度，不阻断快照读取（ADR 0007 决策 4）。
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

/** 模块装配：绑定会话、注册只读快照句柄与终态记录句柄。 */
export function registerUsage(context: ModuleContext): void {
  let sessionId: string | null = null;
  const runtime = createUsageRuntime({
    agentDir: getAgentDir(),
    services: context.services,
    getSessionId: () => sessionId,
  });

  context.pi.on("session_start", (_event, ctx) => {
    sessionId = ctx.sessionManager.getSessionId();
    // 候选池状态预热：尽力而为，失败静默（快照照常可读，未知不阻断）。
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
