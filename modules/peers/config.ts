// peers 模块的配置节解析（工单 33 骨架）。
//
// 配置落点：pi-toolkit.json 的 `modules.peers` 节。
// 菜单 schema 只放 `enabled`（入站策略已废除；模块在一级菜单不出行）；
// 阈值类数值参数（心跳、stale 判定、注册清理、列表上限、单帧上限、连接/写入超时、
// 去重窗口，以及工单 40 的大内容转文件阈值、文件存活期、队列/速率/读取上限）
// 是模块私有结构化配置，由本解析器校验默认值与范围：非法值逐条记警告并回退默认，
// 绝不因单点配置错误拖垮模块。
// 解析结果中的警告在模块初始化时归入 init 诊断，走会话启动的呈现路径。

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

/**
 * 把 `modules.peers` 节（context.getConfig() 的合并记录，非 schema 键原样透传）
 * 规范化成 PeersSettings。除逐字段范围校验外，还保严格序约束：
 * heartbeatIntervalMs > 0、staleAfterMs > heartbeatIntervalMs、cleanupAfterMs > staleAfterMs
 * （规格「过期清理」双阈值，相等也非法）。序非法时按锚点回退（回退值保证严格大于前一级
 * 且在自身范围内），回退后按最终值重新校验；仍非法则整体回退出厂默认组合。
 */
export function readPeersSettings(section: Record<string, unknown> | undefined): LoadedPeersSettings {
  const warnings: string[] = [];
  const source = section !== null && typeof section === "object" ? section : {};
  let settings: PeersSettings = {
    heartbeatIntervalMs: readNumberField("heartbeatIntervalMs", source, warnings),
    staleAfterMs: readNumberField("staleAfterMs", source, warnings),
    cleanupAfterMs: readNumberField("cleanupAfterMs", source, warnings),
    listEntryLimit: readNumberField("listEntryLimit", source, warnings),
    // 通讯侧阈值（工单 37）：与心跳/清理序列无序约束，仅逐字段范围校验
    maxFrameBytes: readNumberField("maxFrameBytes", source, warnings),
    connectTimeoutMs: readNumberField("connectTimeoutMs", source, warnings),
    writeTimeoutMs: readNumberField("writeTimeoutMs", source, warnings),
    // 去重窗口（工单 39）：与心跳/清理序列无序约束，仅逐字段范围校验
    dedupeWindowMs: readNumberField("dedupeWindowMs", source, warnings),
    // 大内容与限流防护阈值（工单 40）：同样无序约束，仅逐字段范围校验
    largeContentThresholdBytes: readNumberField("largeContentThresholdBytes", source, warnings),
    fileTtlMs: readNumberField("fileTtlMs", source, warnings),
    inboundQueueLimit: readNumberField("inboundQueueLimit", source, warnings),
    senderRateLimit: readNumberField("senderRateLimit", source, warnings),
    rateWindowMs: readNumberField("rateWindowMs", source, warnings),
    maxInboundContentBytes: readNumberField("maxInboundContentBytes", source, warnings),
  };

  // 锚点回退：范围字段回退默认值可能仍违反严格序（如心跳配到上限 60s 时默认 stale 60s
  // 依然相等），改用心跳/上一级之上加一个默认间隔，必落在该字段自身范围内。
  const fixOrder = (field: keyof PeersSettings, anchor: number, reason: string): void => {
    const anchored = Math.min(PEERS_SETTINGS_RANGES[field].max, anchor + DEFAULT_PEERS_SETTINGS[field]);
    settings = { ...settings, [field]: anchored };
    warnings.push(`peers.${field} ${reason}，已调整为 ${anchored}`);
  };
  if (settings.staleAfterMs <= settings.heartbeatIntervalMs) {
    fixOrder("staleAfterMs", settings.heartbeatIntervalMs, "必须大于 peers.heartbeatIntervalMs");
  }
  // 用修正后的最终 stale 值重新校验 cleanup（相等也非法）
  if (settings.cleanupAfterMs <= settings.staleAfterMs) {
    fixOrder("cleanupAfterMs", settings.staleAfterMs, "必须大于 peers.staleAfterMs");
  }

  // 兜底重验：任意输入下最终结果必须满足全部序约束；推导不可达时整体回退出厂默认组合
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
