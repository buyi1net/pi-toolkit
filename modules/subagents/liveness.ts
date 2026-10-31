import { statSync } from "node:fs";

export interface SessionLivenessProbe {

  probe(sessionFile: string, now: number): { lastChangeAtMs: number } | null;
  dispose(): void;
}

interface ProbeCacheEntry {

  fingerprint: string | null;

  lastChangeAtMs: number | null;
}

function sessionFingerprint(sessionFile: string): string | null {
  try {
    const stats = statSync(sessionFile, { bigint: true });
    return `${stats.mtimeNs}:${stats.size}`;
  } catch {
    return null;
  }
}

export function createSessionFileLivenessProbe(): SessionLivenessProbe {
  const cache = new Map<string, ProbeCacheEntry>();

  return {
    probe(sessionFile, now) {
      const fingerprint = sessionFingerprint(sessionFile);
      const entry = cache.get(sessionFile);

      if (fingerprint == null) {
        cache.set(sessionFile, { fingerprint: null, lastChangeAtMs: null });
        return null;
      }
      const changed = entry?.fingerprint != null && entry.fingerprint !== fingerprint;
      const lastChangeAtMs = changed ? now : entry?.lastChangeAtMs ?? null;
      cache.set(sessionFile, { fingerprint, lastChangeAtMs });
      return lastChangeAtMs == null ? null : { lastChangeAtMs };
    },

    dispose() {
      cache.clear();
    },
  };
}
