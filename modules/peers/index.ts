// peers 模块装配定义（工单 33 骨架）：会话发现与通讯的模块壳 + 只读发现句柄。
//
// 模块边界：
// - api.ts：对其它模块开放的静态导出面（类型 / 常量 / 纯函数）；
// - config.ts：阈值类数值参数的结构化配置解析（菜单 schema 不出现自由数值字段）；
// - mod.ts：发现快照控制器 + `peers.discovery` 句柄 + 初始化/运行诊断 + 心跳维护器接线；
// - registry.ts：会话注册表（每实例一个注册文件的读写）与心跳维护器（工单 35）；
// - discovery.ts：发现合并纯函数 + 状态展示组合（工单 36，寻址可复用）；
// - list-tool.ts：peers_list 模型侧工具（工单 36，与句柄同一数据源）；
// - protocol.ts：线协议与帧编解码 + 传输/超时接缝（工单 37，纯逻辑）；
// - endpoint.ts：真实本地端点适配器（工单 38，Windows 命名管道 / Unix 域 socket 同一接口）
//   与发送侧传输适配器；
// - messaging.ts：通讯主链路（工单 39）：寻址解析、接收端固定判定顺序、去重窗口、
//   正文封套与投递编排（判定纯函数 + 副作用小组件分层）；
// - send-tool.ts：peers_send 模型侧工具（工单 39）；
// - messages/：本模块三语键表（自包含）。
//
// 通讯端点监听（工单 38）随会话生命周期建立；通讯主链路与 peers_send 归工单 39；
// 本单验收：模块可安装、可开关、无残留、诊断可观测、句柄快照结构就位。

import {
  enabledField,
  type ModuleConfigSchema,
  type ModuleContext,
  type ModuleDefinition,
} from "../../kit/module.ts";
import { PEERS_MODULE_ID } from "./api.ts";
import { registerPeers, type PeersModuleOptions } from "./mod.ts";

export { PEERS_DISCOVERY_SERVICE_NAME, PEERS_MODULE_ID } from "./api.ts";
export type {
  PeerActivity,
  PeerLiveEntry,
  PeerLiveness,
  PeerOfflineEntry,
  PeersDiagnostic,
  PeersDiscoveryService,
  PeersDiscoverySnapshot,
  PeersScanFn,
  PeersScanResult,
  PeersSettings,
  PeersSnapshotError,
} from "./api.ts";
export type { PeersModuleOptions, PeersRuntime } from "./mod.ts";
export { createPeersDiskScanner, peersProjectDirName, peersSessionsRoot } from "./scan.ts";
export type {
  PeersDiskScanner,
  PeersDiskScanOutput,
  PeersDiskScanStats,
  PeersDiskSession,
} from "./scan.ts";
export { mergePeerDiscovery, peerDisplayStatus, collectPeerSessionCandidates } from "./discovery.ts";
export type {
  PeerDisplayStatus,
  PeerLiveCandidate,
  PeerSessionCandidate,
  PeersDiscoveryMergeDiskInput,
  PeersDiscoveryMergeInput,
} from "./discovery.ts";
export { registerPeersListTool } from "./list-tool.ts";
export type {
  PeersListEntryView,
  PeersListOutput,
  PeersListToolDeps,
  PeersSelfIdentity,
} from "./list-tool.ts";
export {
  PEERS_MESSAGE_CUSTOM_TYPE,
  buildPeersMessageEnvelope,
  createPeersDedupeWindow,
  createPeersInboundHandler,
  deliverPeersMessage,
  describePeersReason,
  judgePeersInboundRequest,
  resolvePeersAddress,
} from "./messaging.ts";
export type {
  PeersAddressRefusalReason,
  PeersDedupeWindow,
  PeersInboundHandler,
  PeersInboundHandlerDeps,
  PeersInboundJudgment,
  PeersMessageDetails,
  PeersMessageInjector,
  PeersResolveOutcome,
  PeersSendDeps,
  PeersSendReport,
} from "./messaging.ts";
export { registerPeersSendTool } from "./send-tool.ts";
export type { PeersSendToolDeps } from "./send-tool.ts";
export {
  createPeersEndpointServer,
  createPeersTransport,
  peersUnixSocketAddress,
  peersUnixSocketDir,
  peersWindowsPipeName,
} from "./endpoint.ts";
export type {
  PeersEndpointReply,
  PeersEndpointRequestHandler,
  PeersEndpointServer,
  PeersEndpointServerOptions,
} from "./endpoint.ts";
export {
  createHeartbeatMaintainer,
  defaultPeerHeartbeatScheduler,
  peerRegistrationFile,
  peerRegistrationFileName,
  peerRegistrationLiveness,
  readPeerRegistrations,
  writePeerRegistration,
} from "./registry.ts";
export type {
  HeartbeatMaintainer,
  HeartbeatMaintainerOptions,
  PeerHeartbeatScheduler,
  PeerHeartbeatTimer,
  PeerInstanceIdentity,
  PeerRegistration,
  PeerRegistrationRead,
  PeerRegistrationReadStats,
  PeerSessionIdentity,
} from "./registry.ts";

/** 配置 schema：装配门控共用（菜单不再出现任何 peers 行） */
const PEERS_CONFIG_SCHEMA: ModuleConfigSchema = {
  enabled: enabledField("module.peers.enabled.label", "module.peers.enabled.description"),
};

export function createPeersModule(options: PeersModuleOptions = {}): ModuleDefinition {
  return {
    id: PEERS_MODULE_ID,
    labelKey: "module.peers.label",
    descriptionKey: "module.peers.description",
    group: "general",
    // 配置契约：菜单 schema 只放 enabled；原入站策略按用户决策废除（拒收是全局阀，
    // 一关全机器收不到消息，不是防骚扰，故删除）。
    // 阈值类数值参数是模块私有结构化配置，由 config.ts 的解析器校验。
    configSchema: PEERS_CONFIG_SCHEMA,
    // 模块在一级菜单不出行（显式空 topLevel；无需菜单行，开关只能手编配置文件）
    topLevel: () => [],
    register(context: ModuleContext): void {
      registerPeers(context, options);
    },
  };
}

export const peersModule: ModuleDefinition = createPeersModule();
