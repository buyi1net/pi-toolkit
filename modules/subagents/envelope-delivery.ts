import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AGENT_QUEUE_DELIVERY, AGENT_TURN_DELIVERY } from "./agent-envelope.ts";
import { debugLog } from "./diagnostics.ts";

export interface OutboundEnvelope {
  key: string;
  customType: string;
  content: string;
  details: Record<string, unknown>;
}

export interface EnvelopeDelivery {
  deliver(envelope: OutboundEnvelope, isIdle: () => boolean, host?: unknown): Promise<void>;
  flushBeforeSettle(host?: unknown): Promise<boolean>;
  flushAfterSettle(aborted: boolean, host?: unknown): Promise<boolean>;
  pendingCount(): number;
  loadPending(dir: string | null | undefined): void;
}

export interface EnvelopeDeliveryDeps {
  send: (message: Record<string, unknown>, options: Record<string, unknown>, host?: unknown) => Promise<void> | void;
}

interface StoredEnvelope extends OutboundEnvelope {
  created_at: number;
}

const PENDING_FILE = "pending-envelopes.jsonl";
const BATCHED_CUSTOM_TYPE = "subagent_batch_result";

export function pendingEnvelopesPath(artifactDir: string): string {
  return join(artifactDir, PENDING_FILE);
}

function readStored(path: string): StoredEnvelope[] {
  try {
    if (!existsSync(path)) return [];
    const stored: StoredEnvelope[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as Partial<StoredEnvelope>;
        if (typeof parsed.key !== "string" || !parsed.key) continue;
        if (typeof parsed.customType !== "string" || typeof parsed.content !== "string") continue;
        stored.push({
          key: parsed.key,
          customType: parsed.customType,
          content: parsed.content,
          details: parsed.details && typeof parsed.details === "object" ? parsed.details : {},
          created_at: typeof parsed.created_at === "number" ? parsed.created_at : 0,
        });
      } catch {
        continue;
      }
    }
    return stored;
  } catch (error) {
    debugLog("Could not read pending envelopes", error);
    return [];
  }
}

export function createEnvelopeDelivery(deps: EnvelopeDeliveryDeps): EnvelopeDelivery {
  const pending = new Map<string, StoredEnvelope>();
  const inFlight = new Set<string>();
  let artifactDir: string | null = null;

  const persist = (items: StoredEnvelope[] = [...pending.values()]): boolean => {
    if (!artifactDir) {
      debugLog("Skipped persisting pending envelopes: artifact directory is not ready.");
      return false;
    }
    const path = pendingEnvelopesPath(artifactDir);
    try {
      mkdirSync(dirname(path), { recursive: true });
      const body = items.sort((a, b) => a.created_at - b.created_at).map((item) => JSON.stringify(item)).join("\n");
      writeFileSync(path, body.length > 0 ? `${body}\n` : "", { encoding: "utf8", mode: 0o600 });
      return true;
    } catch (error) {
      debugLog("Could not persist pending envelopes", error);
      return false;
    }
  };

  const send = (message: Record<string, unknown>, options: Record<string, unknown>, host?: unknown) =>
    Promise.resolve(deps.send(message, options, host));

  const flushWith = async (
    options: Record<string, unknown>,
    delivery: string,
    host?: unknown,
  ): Promise<boolean> => {
    const items = [...pending.values()].filter((item) => !inFlight.has(item.key)).sort((a, b) => a.created_at - b.created_at);
    if (items.length === 0) return false;
    const single = items.length === 1 ? items[0]! : null;
    const message = single
      ? { customType: single.customType, content: single.content, display: true, details: single.details }
      : {
        customType: BATCHED_CUSTOM_TYPE,
        content: items.map((item) => item.content).join("\n\n"),
        display: true,
        details: {
          batched: true,
          count: items.length,
          delivery,
          results: items.map((item) => ({ key: item.key, ...item.details })),
        },
      };
    for (const item of items) inFlight.add(item.key);
    try {
      await send(message, options, host);
    } catch (error) {
      for (const item of items) inFlight.delete(item.key);
      debugLog("Could not deliver pending envelopes", error);
      return false;
    }
    for (const item of items) {
      inFlight.delete(item.key);
      if (pending.get(item.key) === item) pending.delete(item.key);
    }
    persist([...pending.values()]);
    return true;
  };

  return {
    async deliver(envelope, isIdle, host) {
      pending.set(envelope.key, { ...envelope, created_at: Date.now() });
      persist();
      if (!isIdle()) return;
      await flushWith(AGENT_TURN_DELIVERY, "idle", host);
    },
    flushBeforeSettle(host) {
      return flushWith(AGENT_QUEUE_DELIVERY, "before-settle", host);
    },
    flushAfterSettle(aborted, host) {
      if (aborted) return Promise.resolve(false);
      return flushWith(AGENT_TURN_DELIVERY, "settled", host);
    },
    pendingCount() {
      return pending.size;
    },
    loadPending(dir) {
      const next = dir && dir.length > 0 ? dir : null;
      if (next === artifactDir) return;
      if (artifactDir && pending.size > 0) persist();
      pending.clear();
      artifactDir = next;
      if (!artifactDir) return;
      for (const stored of readStored(pendingEnvelopesPath(artifactDir))) {
        if (!pending.has(stored.key)) pending.set(stored.key, stored);
      }
    },
  };
}
