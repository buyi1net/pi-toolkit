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

const PEERS_CONFIG_SCHEMA: ModuleConfigSchema = {
  enabled: enabledField("module.peers.enabled.label", "module.peers.enabled.description"),
};

export function createPeersModule(options: PeersModuleOptions = {}): ModuleDefinition {
  return {
    id: PEERS_MODULE_ID,
    labelKey: "module.peers.label",
    descriptionKey: "module.peers.description",
    group: "general",

    configSchema: PEERS_CONFIG_SCHEMA,

    topLevel: () => [],
    register(context: ModuleContext): void {
      registerPeers(context, options);
    },
  };
}

export const peersModule: ModuleDefinition = createPeersModule();
