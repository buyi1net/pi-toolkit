// 压缩降级记账（工单 06）：状态栏 fallback 标记的唯一写口与幂等清除总线。
//
// 口径（规格「TUI 状态栏跨模块协同与 Fallback 生命周期真实接缝」）：
// - 记录面只有一个：降级来源（codex / acp）+ 非空机读原因。状态服务（status.ts）
//   经 readFallback / clearFallback 两个读口消费它，装配层（mod.ts）负责接线；
// - 清除是幂等的：三路成功接缝（Pi session_compact 原生压缩成功、Codex owner
//   finalize、ACP compress 工具成功落盘）都可以放心重复调用，已无降级记录时是
//   空操作——快照内容不变，revision 不递增（幂等由 status.ts 的 clearFallback
//   与本层共同保证：先读后写，没有记录就不写）；
// - 复位只发生在会话/环境边界：session_start、session_shutdown 与 model_select
//   （模型切换后旧的降级结论不再适用）；这些边界不碰当前会话覆盖
//   （session-override.ts 自己有复位时机，两者互不替代）；
// - 原因必须非空：降级若无可解释的原因，状态栏的 [fallback] 就成了无法查证的
//   噪音，因此空原因不记账（写方负责给出机读值）。

import type { CompressionFallbackRecord } from "./status.ts";

/** 降级记账接缝（装配层注入给状态服务、owner 与 ACP 工具） */
export interface CompressionFallbackLedger {
  /** 当前降级记录；无降级时 undefined */
  read(): CompressionFallbackRecord | undefined;
  /** 记一次降级（同源同原因重复记录不产生内容变化）；空原因不记账 */
  record(record: CompressionFallbackRecord): void;
  /** 幂等清除：已无降级记录时为空操作 */
  clear(): void;
  /** 会话/环境边界复位（与 clear 同效，语义上区分「边界」与「成功接缝」） */
  reset(): void;
}

export function createCompressionFallbackLedger(): CompressionFallbackLedger {
  let current: CompressionFallbackRecord | undefined;
  return {
    read: () => current,
    record: (record) => {
      const reason = record.reason.trim();
      if (reason === "") return;
      current = { from: record.from, reason };
    },
    clear: () => {
      current = undefined;
    },
    reset: () => {
      current = undefined;
    },
  };
}
