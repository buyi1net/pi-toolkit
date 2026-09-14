// peers 模块实现入口（工单 33 骨架 + 34 磁盘层扫描 + 35 会话注册 + 36 发现合并与 peers_list
// + 38 端点监听 + 39 通讯主链路 + 40 大内容通道与限流防护 + 50 外部消息卡片渲染器）：发现快照控制器 +
// `peers.discovery` 句柄 + 心跳维护器接线 + 端点生命周期 + 入站判定与注入 + 大内容
// 文件通道与 TTL 清理 + 速率/队列/环路防护 + peers_send 工具 + 诊断呈现。
//
// 边界：句柄快照结构（活/离线分区、变更序号、错误状态）、刷新异步且并发复用同一在途
// 操作、初始化失败与运行期异常独立呈现。默认扫描接工单 34 的磁盘层（会话文件树扫描 +
// 修改时间缓存）；工单 35 的心跳维护器负责本实例的注册写入、心跳刷新与保守清理；
// 工单 36 把注册层与磁盘层合并进快照（discovery.ts）并注册 peers_list 工具（同一数据源）；
// 工单 39 接上通讯主链路：端点 onRequest 从占位回执换成入站判定与注入（messaging.ts），
// 新增 peers_send 工具（send-tool.ts，寻址候选不经列表合并器的截断与排序）。
//
// 诊断口径：装配失败由装配器收进 toolkit.problems（kind "module"）；本模块内部的初始化失败
// （agentDir 可用性、配置校验）与运行期异常（扫描抛错）记进自己的诊断列表并写入快照错误状态，
// 在 session_start 时经 ctx.ui.notify 呈现——两条路径互不混用。

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
import { collectPeerSessionCandidates, mergePeerDiscovery } from "./discovery.ts";
import { createPeersEndpointServer, createPeersTransport, type PeersEndpointServer } from "./endpoint.ts";
import { cleanupPeersExpiredFiles } from "./file-store.ts";
import { registerPeersListTool } from "./list-tool.ts";
import { createPeersDedupeWindow, createPeersInboundHandler, createPeersRateGuard } from "./messaging.ts";
import { registerPeersRenderers } from "./renderer.ts";
import { registerPeersSendTool } from "./send-tool.ts";
import { createHeartbeatMaintainer, readPeerRegistrationByIdentity, readPeerRegistrations } from "./registry.ts";
import { createPeersDiskScanner, type PeersDiskScanner } from "./scan.ts";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 运行期诊断保留条数上限（审查修复）：工单 40 起内容校验失败诊断可由故障对端持续
 * 触发，进程生命周期内不回收会无界增长；50 条足以覆盖会话启动呈现窗口与人工排障，
 * 超出丢最旧。 */
const PEERS_DIAGNOSTICS_LIMIT = 50;

export interface PeersRuntimeOptions {
  readonly agentDir: string;
  /** 模块配置节（context.getConfig() 的合并记录）；初始化时解析校验 */
  readonly getConfig?: () => Record<string, unknown>;
  /** 扫描接缝：默认两层合并（注册层 + 磁盘层，工单 36）；注入则完全替换（测试） */
  readonly scan?: PeersScanFn;
  /** 磁盘层扫描器（修改时间缓存跨刷新复用）；默认自建。工单 39 起与寻址共享同一实例 */
  readonly diskScanner?: PeersDiskScanner;
  /** 测试注入时钟 */
  readonly now?: () => number;
}

/** 发现运行时：快照读出、在途复用刷新、诊断观测（句柄注册前的可测接口）。 */
export interface PeersRuntime {
  /** 初始化：配置校验 + agentDir 可用性检查；失败记 init 诊断与快照错误，不抛出 */
  initialize(): void;
  /** 会话绑定：解除 dispose 并允许继续刷新；初始化失败时静默重试初始化 */
  activate(): void;
  /** 会话解绑：之后 refresh 不再触发扫描（幂等） */
  dispose(): void;
  snapshot(): PeersDiscoverySnapshot;
  refresh(): Promise<void>;
  diagnostics(): readonly PeersDiagnostic[];
  /** 外部组件（心跳维护器）上报运行期异常，进同一诊断列表与呈现路径 */
  reportRuntime(detail: string): void;
  /** 取走尚未呈现过的诊断（取走即标记已呈现，供 session_start 的 notify 路径使用） */
  takeUnreportedDiagnostics(): readonly PeersDiagnostic[];
}

export function createPeersRuntime(options: PeersRuntimeOptions): PeersRuntime {
  const getConfig = options.getConfig ?? (() => ({}));
  // 磁盘层扫描器与运行时同寿命：修改时间缓存跨刷新复用，未变更文件不重复解析；
  // 注入 scan 时不创建（按需惰性建，避免无用实例）
  let diskScanner: PeersDiskScanner | undefined = options.diskScanner;
  const defaultScan = (request: { readonly now: number }): PeersScanResult => {
    // 两层合并（工单 36）：注册层（活跃实例）覆盖磁盘层；磁盘层只贡献无活跃实例的
    // 条目。列表上限与阈值每次刷新重读（随 reload 生效）。
    diskScanner ??= createPeersDiskScanner({ agentDir: options.agentDir });
    const { settings } = readPeersSettings(getConfig());
    const { registrations } = readPeerRegistrations(options.agentDir, {
      now: request.now,
      settings,
    });
    const liveCount = registrations.filter((read) => read.liveness !== "offline").length;
    // 磁盘扫描窗口在列表上限之上加活实例数：活跃会话的文件几乎必在最新窗口内，
    // 被排除在窗口外的古老活会话才会误标「文件缺失」（此时列表必然已截断）
    const disk = diskScanner.scan({ limit: settings.listEntryLimit + liveCount });
    return mergePeerDiscovery({ registrations, disk, limit: settings.listEntryLimit });
  };
  const scan = options.scan ?? defaultScan;
  const now = options.now ?? Date.now;

  let online: PeersScanResult["online"] = [];
  let offline: PeersScanResult["offline"] = [];
  let truncated = false;
  let revision = 0;
  // 变更序号只看内容：排除每次刷新都会变的 generatedAt 与错误时间戳
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
  /** 初始化失败后为 true：刷新被阻止，快照错误保持到一次真实成功的重新初始化 */
  let initFailed = false;
  let inFlight: Promise<void> | undefined;

  /** 用下一份内容重建快照：内容变才递增序号；错误时间戳随快照生成时刻走 */
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
    // 同 kind + 同 detail 去重（审查修复）：重复上报只刷新时间戳，不追加重复条目——
    // 故障对端用同一 messageId 重试失败帧时不会流成同样内容的重复诊断
    const existing = diagnostics.findIndex((entry) => entry.kind === kind && entry.detail === detail);
    if (existing >= 0) {
      diagnostics[existing] = { ...diagnostics[existing], at: now() };
      return;
    }
    diagnostics.push({ kind, detail, at: now() });
    if (diagnostics.length > PEERS_DIAGNOSTICS_LIMIT) {
      const dropped = diagnostics.length - PEERS_DIAGNOSTICS_LIMIT;
      diagnostics.splice(0, dropped); // 超限丢最旧
      // 已上报水位同步下调同样的条数，保持 takeUnreportedDiagnostics 的「未上报增量」
      // 语义：丢掉的条目不再出现于后续 pending，未上报的新条目不图丢旧而漏报
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
      // 扫描失败保留上一轮清单并显式标错（规格场景 16：不伪装成空清单）
      const detail = describeError(scanError);
      recordDiagnostic("runtime", detail);
      apply({ kind: "scan-failed", detail });
    }
  };

  /**
   * 初始化校验：配置告警 + agentDir 可用性。
   * recordProblems=true（首次 initialize）记诊断并写快照错误；false（会话启动重试）静默——
   * 失败详情只在首次记录，避免每个会话启动重复播报同一问题。
   */
  const runInitChecks = (recordProblems: boolean): void => {
    const { warnings } = readPeersSettings(getConfig());
    if (recordProblems && warnings.length > 0) recordDiagnostic("init", warnings.join("；"));
    try {
      // 初始化只做只读校验（agentDir 可用性）：不落盘；共享区目录由心跳维护器的
      // 注册写入方懒建（与 usage journal 同款），避免装配期碰用户的 agentDir。
      if (!statSync(options.agentDir).isDirectory()) {
        throw new Error("agentDir 不是目录");
      }
      if (initFailed) {
        // 重新初始化成功才解除阻止并清除 init-failed（内容变化推序号）
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
      // 初始化失败状态下每次会话启动静默重试：恢复前刷新仍被阻止，错误保持
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
      // 并发刷新复用同一在途操作（规格「模块与装配」句柄契约）；
      // 初始化失败时阻止刷新：不让成功扫描把 init-failed 冲成“空清单”
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
  /** pi 的配置目录；默认 getAgentDir() */
  readonly agentDir?: string;
  /** 扫描接缝（测试注入） */
  readonly scan?: PeersScanFn;
  /** 磁盘层扫描器（测试注入；默认与寻址共享同一实例） */
  readonly diskScanner?: PeersDiskScanner;
  /** 测试注入时钟 */
  readonly now?: () => number;
}

/** 模块装配：初始化运行时、绑定会话、注册只读发现句柄与诊断呈现路径。 */
export function registerPeers(context: ModuleContext, moduleOptions: PeersModuleOptions = {}): void {
  const agentDir = moduleOptions.agentDir ?? getAgentDir();
  // 磁盘层扫描器全模块共享：发现快照（带列表上限窗口）与寻址候选集（全量、不经合并器
  // 截断）复用同一份修改时间缓存，两次读盘只花一次解析
  const diskScanner = moduleOptions.diskScanner ?? createPeersDiskScanner({ agentDir });
  const runtime = createPeersRuntime({
    agentDir,
    getConfig: () => context.getConfig(),
    scan: moduleOptions.scan,
    diskScanner,
    now: moduleOptions.now,
  });
  runtime.initialize();

  /** 当前生效阈值（配置随 reload 重读；通讯两侧、去重窗口与限流防护共用同一解析器） */
  const currentSettings = (): PeersSettings => readPeersSettings(context.getConfig()).settings;

  // 心跳维护器（工单 35）：会话注册写入 / 心跳刷新 / 保守清理；异常进同一运行期诊断路径。
  // 工单 40：大内容文件 TTL 清理搭心跳 tick（不新起独立定时器），每 tick 现读阈值
  const heartbeat = createHeartbeatMaintainer({
    agentDir,
    getSettings: () => readPeersSettings(context.getConfig()).settings,
    now: moduleOptions.now,
    onError: (detail) => runtime.reportRuntime(detail),
    onTick: () =>
      cleanupPeersExpiredFiles(agentDir, currentSettings().fileTtlMs, (moduleOptions.now ?? Date.now)()),
  });

  // 速率与环路防护（工单 40）：同一实例的入站判定与发送侧共用（环路防护是无序对合并
  // 计数，两侧必须记进同一窗口）
  const rateGuard = createPeersRateGuard({
    getSettings: () => currentSettings(),
  });

  // 入站判定与注入（工单 39 + 40）：端点 onRequest 的接线目标。候选/来源读取直读注册层与
  // 扫描层（不经列表合并器的截断与排序）；注入走 ExtensionAPI.sendMessage 的
  // steer + 空闲触发语义（详见 messaging.ts）；大内容 file 引用校验与队列/速率检查点
  // 在 messaging.ts，阈值经 getThrottle 注入（随 reload 生效）
  const inboundHandler = createPeersInboundHandler({
    getOwnIdentity: () => heartbeat.identity(),
    getPolicy: () => {
      const raw = context.getConfig().inboundPolicy;
      return raw === "reject" ? "reject" : "accept";
    },
    // 入站来源校验（工单 51）：按帧自报的会话 id + 实例 id 定向读那一个注册文件（不再全量枚举），
    // 定位失败按来源未登记并进运行期诊断——判定顺序与口径由 messaging.ts 的纯函数保证
    findSourceRegistration: (instanceId, now, sessionId) =>
      readPeerRegistrationByIdentity(agentDir, {
        sessionId,
        instanceId,
        now,
        settings: currentSettings(),
        onDiagnostic: (detail) => runtime.reportRuntime(detail),
      }),
    dedupe: createPeersDedupeWindow({ getWindowMs: () => currentSettings().dedupeWindowMs, now: moduleOptions.now ?? Date.now }),
    inject: (message, deliverOptions) => context.pi.sendMessage(message, deliverOptions),
    now: moduleOptions.now ?? Date.now,
    getThrottle: () => currentSettings(),
    rateGuard,
    agentDir,
    reportDiagnostic: (detail) => runtime.reportRuntime(detail),
  });

  // 端点监听（工单 38）：一实例一端点，地址含实例 id；建立后写入本实例注册，会话结束幂等释放。
  // 监听初始化失败按会话运行期失败处理（区别于模块装配失败）：上报运行期诊断并降级——
  // endpoint 保持 null、注册照写、发现等其余能力不受影响
  let endpointServer: PeersEndpointServer | undefined;
  const startEndpoint = (): void => {
    endpointServer?.close(); // 会话切换（无中间 shutdown）时先释放旧实例的端点
    const instanceId = heartbeat.instanceId();
    if (!instanceId) return;
    const next = createPeersEndpointServer({
      agentDir,
      instanceId,
      getSettings: () => currentSettings(),
      // 投递判定（来源校验 / 自投递 / 拒收策略 / 去重）与注入（messaging.ts，工单 39）
      onRequest: inboundHandler,
      // 运行期监听异常 teardown 后，心跳里缓存的端点已是死地址且不会被本实例后续
      // 心跳改写：先清空注册端点再上报（setEndpoint(null) 同值直接返回，安全）；
      // 会话切换时旧实例的 close 发生在 endpointServer = next 之前，不会误清新实例
      onError: (detail) => {
        if (endpointServer === next) heartbeat.setEndpoint(null);
        runtime.reportRuntime(detail);
      },
      now: moduleOptions.now,
    });
    endpointServer = next;
    void next.start().then(
      (address) => {
        // 等待监听期间会话已切换/结束：地址不写入注册（该实例的注册已随心跳清理）
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
    // 只挡初始化失败（agentDir 不可用）：共享区懒建会连带建出 agentDir，等恢复后的
    // 下一个会话启动再开始注册；扫描失败（scan-failed）不挡注册——注册表写入与
    // 发现扫描是两条独立路径，别让上一轮的扫描错误拖掉新会话的注册
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
  // 活动状态由宿主事件驱动：agent 开始 → 工作中；稳定结束 → 空闲（规格「活性与状态」）
  context.pi.on("agent_start", () => heartbeat.setActivity("working"));
  context.pi.on("agent_settled", () => heartbeat.setActivity("idle"));
  // 会话名变化（注册层是活跃会话名字的权威源，须保持新鲜）
  context.pi.on("session_info_changed", (event) => heartbeat.setName(event.name ?? null));
  context.pi.on("session_shutdown", () => {
    endpointServer?.close();
    endpointServer = undefined;
    heartbeat.stop();
    runtime.dispose();
  });

  context.services.register(PEERS_DISCOVERY_SERVICE_NAME, {
    id: "peers",
    snapshot: () => runtime.snapshot(),
    refresh: () => runtime.refresh(),
  });

  // 模型侧列表工具（工单 36）：与句柄同一 runtime（同一份合并快照），不另行扫描；
  // 「自己」标记的实例 id 取心跳维护器（会话未绑定为 null，此时不标）
  registerPeersListTool(context.pi, {
    getSnapshot: () => runtime.snapshot(),
    refresh: () => runtime.refresh(),
    getInstanceId: () => heartbeat.instanceId(),
    label: context.t("module.peers.tool.list.label"),
  });

  // 模型侧发送工具（工单 39 + 40 + 51）：寻址分两段可替换入口——注册层只读注册文件（命中即
  // 终局，不碰会话树），未命中才走扫描层（注册层 + 磁盘层合并候选集，共享磁盘扫描器的全量
  // 窗口，不经列表合并器的截断与排序）；发送方自报字段取本实例注册身份（heartbeat.identity）；
  // 大内容转文件与环路防护的发送侧计数经 deps 接入
  registerPeersSendTool(context.pi, {
    getOwnIdentity: () => heartbeat.identity(),
    loadRegistryCandidates: () => {
      const settings = currentSettings();
      const now = (moduleOptions.now ?? Date.now)();
      const { registrations } = readPeerRegistrations(agentDir, { now, settings });
      return [...collectPeerSessionCandidates({ registrations, disk: [] }).values()];
    },
    loadCandidates: () => {
      const settings = currentSettings();
      const now = (moduleOptions.now ?? Date.now)();
      try {
        // 候选读取（注册层 + 扫描层）同一兜底：注册层读取失败与扫描器抛错都归一成显式
        // 失败结果；细节文案不预判失败出自哪一层，避免注册层读取失败被外层误报成扫描树失败
        const { registrations } = readPeerRegistrations(agentDir, { now, settings });
        // 寻址候选不设列表上限：scan() 不传 limit 即全量（截断只属于列表展示层）
        const disk = diskScanner.scan();
        return [...collectPeerSessionCandidates({ registrations, disk: disk.sessions }).values()];
      } catch (error) {
        // 发送候选读取失败（注册层或扫描层）：按错误原样返回（细节文案不预判失败出自哪一层），
        // 由 messaging.ts 统一加「读取发送候选失败」前缀；不降级成「对方离线」或「目标不明」
        return { failure: describeError(error) };
      }
    },
    reportDiagnostic: (detail) => runtime.reportRuntime(detail),
    transport: createPeersTransport(),
    getSettings: () => currentSettings(),
    agentDir,
    rateGuard,
    now: moduleOptions.now,
    label: context.t("module.peers.tool.send.label"),
  });

  // 外部消息卡片渲染器（工单 50）：context.t 读当前语言，语言切换后无需重新注册；
  // 渲染器任何情况下都返回最小安全卡片，不让宿主回退渲染含英文安全提示的完整封套
  registerPeersRenderers(context.pi, (key, vars) => context.t(key, vars));
}
