import {
  DEFAULT_PEERS_SETTINGS,
  PEERS_SETTINGS_RANGES,
  type PeersSettings,
} from "./api.ts";

function readNumberField(
  field: keyof PeersSettings,
  source: Record<string, unknown>,
  warnings: string[],
): number {
  const fallback = DEFAULT_PEERS_SETTINGS[field];
  const raw = source[field];
  if (raw === undefined) return fallback;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    warnings.push(`peers.${field} 必须是数字，已使用默认值 ${fallback}`);
    return fallback;
  }
  const range = PEERS_SETTINGS_RANGES[field];
  if (raw < range.min || raw > range.max) {
    warnings.push(`peers.${field} 超出允许范围 ${range.min}～${range.max}，已使用默认值 ${fallback}`);
    return fallback;
  }
  return raw;
}

export interface LoadedPeersSettings {
  readonly settings: PeersSettings;
  readonly warnings: string[];
}

export function readPeersSettings(section: Record<string, unknown> | undefined): LoadedPeersSettings {
  const warnings: string[] = [];
  const source = section !== null && typeof section === "object" ? section : {};
  let settings: PeersSettings = {
    heartbeatIntervalMs: readNumberField("heartbeatIntervalMs", source, warnings),
    staleAfterMs: readNumberField("staleAfterMs", source, warnings),
    cleanupAfterMs: readNumberField("cleanupAfterMs", source, warnings),
    listEntryLimit: readNumberField("listEntryLimit", source, warnings),

    maxFrameBytes: readNumberField("maxFrameBytes", source, warnings),
    connectTimeoutMs: readNumberField("connectTimeoutMs", source, warnings),
    writeTimeoutMs: readNumberField("writeTimeoutMs", source, warnings),

    dedupeWindowMs: readNumberField("dedupeWindowMs", source, warnings),

    largeContentThresholdBytes: readNumberField("largeContentThresholdBytes", source, warnings),
    fileTtlMs: readNumberField("fileTtlMs", source, warnings),
    inboundQueueLimit: readNumberField("inboundQueueLimit", source, warnings),
    senderRateLimit: readNumberField("senderRateLimit", source, warnings),
    rateWindowMs: readNumberField("rateWindowMs", source, warnings),
    maxInboundContentBytes: readNumberField("maxInboundContentBytes", source, warnings),
  };

  const fixOrder = (field: keyof PeersSettings, anchor: number, reason: string): void => {
    const anchored = Math.min(PEERS_SETTINGS_RANGES[field].max, anchor + DEFAULT_PEERS_SETTINGS[field]);
    settings = { ...settings, [field]: anchored };
    warnings.push(`peers.${field} ${reason}，已调整为 ${anchored}`);
  };
  if (settings.staleAfterMs <= settings.heartbeatIntervalMs) {
    fixOrder("staleAfterMs", settings.heartbeatIntervalMs, "必须大于 peers.heartbeatIntervalMs");
  }

  if (settings.cleanupAfterMs <= settings.staleAfterMs) {
    fixOrder("cleanupAfterMs", settings.staleAfterMs, "必须大于 peers.staleAfterMs");
  }

  if (
    settings.heartbeatIntervalMs <= 0 ||
    settings.staleAfterMs <= settings.heartbeatIntervalMs ||
    settings.cleanupAfterMs <= settings.staleAfterMs
  ) {
    settings = { ...DEFAULT_PEERS_SETTINGS };
    warnings.push("peers 阈值组合无法满足心跳 > 0、stale > 心跳、清理 > stale，已整体回退默认值");
  }

  return { settings, warnings };
}
