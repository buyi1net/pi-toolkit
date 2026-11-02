import type { PeersSubscriptionState } from "./protocol.ts";

export const PEERS_IDLE_SUBSCRIPTION_DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;

export const PEERS_IDLE_SUBSCRIPTION_MAX_TTL_MS = 12 * 60 * 60 * 1000;

export const PEERS_IDLE_SUBSCRIPTION_MIN_TTL_MS = 60 * 1000;

export interface PeersIdleSubscription {
  readonly subscriptionId: string;
  readonly sessionId: string;
  readonly instanceId: string;
  readonly armedAt: number;
  readonly expiresAt: number;
}

export function clampPeersIdleSubscriptionTtl(ttlMs: number | undefined): number {
  if (ttlMs === undefined || !Number.isFinite(ttlMs)) return PEERS_IDLE_SUBSCRIPTION_DEFAULT_TTL_MS;
  const floored = Math.floor(ttlMs);
  return Math.min(PEERS_IDLE_SUBSCRIPTION_MAX_TTL_MS, Math.max(PEERS_IDLE_SUBSCRIPTION_MIN_TTL_MS, floored));
}

export interface PeersIdleSubscriptionArmInput {
  readonly subscriptionId: string;
  readonly sessionId: string;
  readonly instanceId: string;
  readonly ttlMs: number;
  readonly targetIdle: boolean;
}

export interface PeersIdleSubscriptionArmResult {
  readonly subscription: PeersIdleSubscription;
  readonly state: PeersSubscriptionState;
}

export interface PeersIdleSubscriptionTable {
  arm(input: PeersIdleSubscriptionArmInput): PeersIdleSubscriptionArmResult;

  takeTriggered(now: number): readonly PeersIdleSubscription[];

  maintain(now: number): number;

  size(): number;
}

export function createPeersIdleSubscriptionTable(options: {
  readonly now: () => number;
}): PeersIdleSubscriptionTable {
  const entries = new Map<string, PeersIdleSubscription>();

  return {
    arm(input: PeersIdleSubscriptionArmInput): PeersIdleSubscriptionArmResult {
      const now = options.now();
      const subscription: PeersIdleSubscription = {
        subscriptionId: input.subscriptionId,
        sessionId: input.sessionId,
        instanceId: input.instanceId,
        armedAt: now,
        expiresAt: now + clampPeersIdleSubscriptionTtl(input.ttlMs),
      };
      if (input.targetIdle) return { subscription, state: "fired" };
      entries.set(subscription.subscriptionId, subscription);
      return { subscription, state: "armed" };
    },

    takeTriggered(now: number): readonly PeersIdleSubscription[] {
      const triggered: PeersIdleSubscription[] = [];
      for (const [id, subscription] of entries) {
        entries.delete(id);
        if (subscription.expiresAt > now) triggered.push(subscription);
      }
      return triggered;
    },

    maintain(now: number): number {
      let removed = 0;
      for (const [id, subscription] of entries) {
        if (subscription.expiresAt > now) continue;
        entries.delete(id);
        removed += 1;
      }
      return removed;
    },

    size(): number {
      return entries.size;
    },
  };
}
