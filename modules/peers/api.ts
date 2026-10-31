import { join } from "node:path";

export const PEERS_MODULE_ID = "peers";

export const PEERS_DISCOVERY_SERVICE_NAME = "peers.discovery";

export type PeerLiveness = "online" | "stale" | "offline";

export type PeerActivity = "working" | "idle";

export interface PeerLiveEntry {
  readonly sessionId: string;
  readonly instanceId: string;

  readonly name: string | null;
  readonly cwd: string | null;

  readonly sessionFile: string | null;
  readonly liveness: "online" | "stale";
  readonly activity: PeerActivity;
}

export interface PeerOfflineEntry {
  readonly sessionId: string;
  readonly name: string | null;
  readonly cwd: string | null;
  readonly sessionFile: string | null;
}

export interface PeersScanResult {
  readonly online: readonly PeerLiveEntry[];
  readonly offline: readonly PeerOfflineEntry[];

  readonly truncated: boolean;
}

export type PeersScanFn = (request: { readonly now: number }) => Promise<PeersScanResult> | PeersScanResult;

export interface PeersSnapshotError {
  readonly kind: "init-failed" | "scan-failed";
  readonly detail: string;
  readonly at: number;
}

export interface PeersDiscoverySnapshot {
  readonly generatedAt: number;

  readonly revision: number;

  readonly online: readonly PeerLiveEntry[];

  readonly offline: readonly PeerOfflineEntry[];
  readonly truncated: boolean;
  readonly error: PeersSnapshotError | null;
}

export interface PeersDiagnostic {
  readonly kind: "init" | "runtime";
  readonly detail: string;
  readonly at: number;
}

export interface PeersDiscoveryService {
  readonly id: "peers";
  snapshot(): PeersDiscoverySnapshot;

  refresh(): Promise<void>;
}

export interface PeersSettings {
  readonly heartbeatIntervalMs: number;
  readonly staleAfterMs: number;
  readonly cleanupAfterMs: number;
  readonly listEntryLimit: number;
  readonly maxFrameBytes: number;
  readonly connectTimeoutMs: number;
  readonly writeTimeoutMs: number;

  readonly dedupeWindowMs: number;

  readonly largeContentThresholdBytes: number;

  readonly fileTtlMs: number;

  readonly inboundQueueLimit: number;

  readonly senderRateLimit: number;

  readonly rateWindowMs: number;

  readonly maxInboundContentBytes: number;
}

export const DEFAULT_PEERS_SETTINGS: Readonly<PeersSettings> = Object.freeze({
  heartbeatIntervalMs: 15_000,
  staleAfterMs: 60_000,
  cleanupAfterMs: 300_000,
  listEntryLimit: 200,
  maxFrameBytes: 65_536,
  connectTimeoutMs: 2_000,
  writeTimeoutMs: 5_000,
  dedupeWindowMs: 300_000,
  largeContentThresholdBytes: 8_192,
  fileTtlMs: 86_400_000,
  inboundQueueLimit: 100,
  senderRateLimit: 10,
  rateWindowMs: 60_000,
  maxInboundContentBytes: 8_388_608,
});

export const PEERS_SETTINGS_RANGES: Readonly<
  Record<keyof PeersSettings, { readonly min: number; readonly max: number }>
> = Object.freeze({
  heartbeatIntervalMs: { min: 5_000, max: 60_000 },
  staleAfterMs: { min: 10_000, max: 300_000 },
  cleanupAfterMs: { min: 60_000, max: 3_600_000 },
  listEntryLimit: { min: 10, max: 1_000 },
  maxFrameBytes: { min: 16_384, max: 1_048_576 },
  connectTimeoutMs: { min: 500, max: 60_000 },
  writeTimeoutMs: { min: 1_000, max: 300_000 },

  dedupeWindowMs: { min: 60_000, max: 3_600_000 },

  largeContentThresholdBytes: { min: 1_024, max: 65_536 },

  fileTtlMs: { min: 60_000, max: 604_800_000 },
  inboundQueueLimit: { min: 1, max: 10_000 },
  senderRateLimit: { min: 1, max: 1_000 },

  rateWindowMs: { min: 1_000, max: 600_000 },

  maxInboundContentBytes: { min: 65_536, max: 268_435_456 },
});

export function peersSharedDir(agentDir: string): string {
  return join(agentDir, "cache", "pi-toolkit", "peers");
}
