import type { PeerActivity, PeerLiveEntry, PeerLiveness, PeerOfflineEntry, PeersScanResult } from "./api.ts";
import type { PeerRegistration, PeerRegistrationRead } from "./registry.ts";
import type { PeersDiskSession } from "./scan.ts";

export type PeerDisplayStatus = "working" | "idle" | "sluggish" | "offline";

export function peerDisplayStatus(liveness: PeerLiveness, activity: PeerActivity): PeerDisplayStatus {
  if (liveness === "offline") return "offline";
  if (liveness === "stale") return "sluggish";
  return activity;
}

export interface PeersDiscoveryMergeDiskInput {
  readonly sessions: readonly PeersDiskSession[];
  readonly truncated: boolean;
}

export interface PeersDiscoveryMergeInput {

  readonly registrations: readonly PeerRegistrationRead[];
  readonly disk: PeersDiscoveryMergeDiskInput;

  readonly limit: number;
}

function winsDiskDedup(candidate: PeersDiskSession, incumbent: PeersDiskSession): boolean {
  if (candidate.modifiedAt !== incumbent.modifiedAt) return candidate.modifiedAt > incumbent.modifiedAt;
  return candidate.sessionFile > incumbent.sessionFile;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface PeerLiveCandidate {
  readonly registration: PeerRegistration;
  readonly liveness: "online" | "stale";
}

export interface PeerSessionCandidate {
  readonly sessionId: string;

  readonly live: readonly PeerLiveCandidate[];

  readonly newestDisk: PeersDiskSession | null;
}

export function collectPeerSessionCandidates(input: {
  readonly registrations: readonly PeerRegistrationRead[];
  readonly disk: readonly PeersDiskSession[];
}): ReadonlyMap<string, PeerSessionCandidate> {
  const newestDisk = new Map<string, PeersDiskSession>();
  for (const session of input.disk) {
    const incumbent = newestDisk.get(session.sessionId);
    if (incumbent === undefined || winsDiskDedup(session, incumbent)) {
      newestDisk.set(session.sessionId, session);
    }
  }
  const bySession = new Map<string, PeerSessionCandidate>();
  for (const [sessionId, disk] of newestDisk) {
    bySession.set(sessionId, { sessionId, live: [], newestDisk: disk });
  }
  for (const read of input.registrations) {
    if (read.liveness === "offline") continue;
    const existing = bySession.get(read.registration.sessionId);
    const candidate: PeerLiveCandidate = { registration: read.registration, liveness: read.liveness };
    if (existing) bySession.set(read.registration.sessionId, { ...existing, live: [...existing.live, candidate] });
    else bySession.set(read.registration.sessionId, { sessionId: read.registration.sessionId, live: [candidate], newestDisk: null });
  }
  return bySession;
}

export function mergePeerDiscovery(input: PeersDiscoveryMergeInput): PeersScanResult {
  const candidates = collectPeerSessionCandidates({ registrations: input.registrations, disk: input.disk.sessions });

  const live = [...candidates.values()].flatMap((candidate) => candidate.live);
  live.sort(
    (a, b) =>
      b.registration.heartbeatAt - a.registration.heartbeatAt ||
      compareText(a.registration.sessionId, b.registration.sessionId) ||
      compareText(a.registration.instanceId, b.registration.instanceId),
  );
  const online: PeerLiveEntry[] = live.map((read) => ({
    sessionId: read.registration.sessionId,
    instanceId: read.registration.instanceId,
    name: read.registration.name,
    cwd: read.registration.cwd,
    sessionFile: candidates.get(read.registration.sessionId)?.newestDisk?.sessionFile ?? null,
    liveness: read.liveness,
    activity: read.registration.activity,
  }));

  const offlineCandidates: PeerOfflineEntry[] = [...candidates.values()]
    .filter((candidate) => candidate.live.length === 0 && candidate.newestDisk !== null)
    .map(({ newestDisk }) => newestDisk as PeersDiskSession)
    .sort((a, b) => (winsDiskDedup(a, b) ? -1 : winsDiskDedup(b, a) ? 1 : 0))
    .map((session) => ({
      sessionId: session.sessionId,
      name: session.name,
      cwd: session.cwd,
      sessionFile: session.sessionFile,
    }));

  const keepOnline = online.slice(0, input.limit);
  const offline = offlineCandidates.slice(0, Math.max(0, input.limit - keepOnline.length));
  const truncated = input.disk.truncated || online.length + offlineCandidates.length > input.limit;
  return { online: keepOnline, offline, truncated };
}
