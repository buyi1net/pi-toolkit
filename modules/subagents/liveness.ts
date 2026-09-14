// 工单 45：子代理存活证据采集（读侧三态判定的证据面）。
//
// 采集与判定分离：本模块只做 IO 与指纹缓存，判定全部在 status.ts 的纯函数
// 里做（status.ts 不做任何 IO）。指纹形态复用 43 descendants tracker 的
// `mtimeNs:size`（bigint stat——毫秒粒度会漏掉同毫秒的写入）。
//
// 证据语义（保守）：只有「采集到指纹变化」才算证据——首次看见、缺失后
// 重新出现都不伪造变化时刻（拿不到历史就不能断言它在长），证据缺失时
// 判定一律回落现行行为（stale 只提示不定罪）。锚点用调用方传入的观测
// 时刻而不是文件 mtime：判定时钟（测试注入/宿主时钟）与文件系统时钟
// 不保证同源，用 mtime 会在逻辑时钟下产生负静默时长。

import { statSync } from "node:fs";

export interface SessionLivenessProbe {
  /**
   * 探测一次会话文件：指纹有变化时返回锚定本次观测时刻的证据，
   * 无历史/文件缺失/未变化沿缓存返回（无证据时为 null）。
   */
  probe(sessionFile: string, now: number): { lastChangeAtMs: number } | null;
  dispose(): void;
}

interface ProbeCacheEntry {
  /** 上次看到的指纹；null = 文件缺失或从未看见。 */
  fingerprint: string | null;
  /** 上次观察到指纹变化的时刻（调用方时钟）；从未观察到变化为 null。 */
  lastChangeAtMs: number | null;
}

/** 会话文件指纹：`mtimeNs:size`；stat 失败（缺失/不可读）为 null。 */
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
      // 文件缺失时遇忘历史：旧锚点不能跨缺失沿用（缺失后重新出现会伪造
      // 「一直在长」的假证据），证据置空让判定回落现行行为。
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
