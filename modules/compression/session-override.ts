// 当前会话压缩覆盖（工单 05）：内存级就地调节，生命周期随当前会话。
//
// 口径（规格「会话级覆盖（Session Override）契约」）：
// - 只改内存：不写盘、不进配置写入事务、不动全局模型规则（内存隔离）；
// - 复位时机：session_start（新会话 / 会话切换 / resume 都以它到达）、
//   session_shutdown（会话结束）与宿主重置（reload 重新装配扩展时 registerCompression
//   重新执行即复位）；
// - model_select 只重新解析策略，不复位覆盖——换模型不该丢掉用户在本会话里的选择。
//
// 单例而不是实例状态：覆盖没有自己的子结构，读口（策略解析、面板行、状态快照）都按
// 「当前进程的当前会话」取值；装配期复位保证上一个会话的值不会跨会话残留。前提是
// 单进程单次装配 = 一个当前会话（子代理另起进程，不共享这份状态）。

import {
  DEFAULT_SESSION_COMPRESSION_OVERRIDE,
  SESSION_COMPRESSION_OVERRIDES,
  type SessionCompressionOverride,
} from "./api.ts";

/** 取值是不是合法的会话覆盖（面板回传的文案反查结果要过这一关） */
export function isSessionCompressionOverride(value: unknown): value is SessionCompressionOverride {
  return (
    typeof value === "string" && (SESSION_COMPRESSION_OVERRIDES as readonly string[]).includes(value)
  );
}

let current: SessionCompressionOverride = DEFAULT_SESSION_COMPRESSION_OVERRIDE;

/** 当前会话覆盖的内存单例：读口给策略解析 / 面板 / 状态服务，写口只开给面板与生命周期 */
export const sessionCompressionOverride = {
  get(): SessionCompressionOverride {
    return current;
  },
  set(next: SessionCompressionOverride): void {
    current = next;
  },
  /** 回到 follow-global（会话边界与宿主重置调用；幂等） */
  reset(): void {
    current = DEFAULT_SESSION_COMPRESSION_OVERRIDE;
  },
};
