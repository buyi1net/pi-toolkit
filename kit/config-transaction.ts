// 结构化配置写入事务（工单 19 / C5）：四个模块的保存流程统一收在这里。
//
// 事务步骤固定为：写入补丁到目标配置节 → 落盘 → 内存重载 → 模块 reapply 回调 → 重绘请求。
// - 落盘与内存重载是 kit 的唯一出口：模块不再直接持有 saveToolkitConfig；
// - reapply 是模块自己的重生效动作（刷新路由链 / 原子重装界面 / 重建数据控制器），
//   事务不解释它，只在内存副本跟上磁盘之后按序调用；
// - 重绘请求由调用方（菜单层）注入，kit 不依赖 tui；
// - 任一步失败即中止（后面的步骤不跑）并上抛：落盘可能已经完成，失败提示由调用方负责。

import { saveToolkitConfig, type ToolkitConfig, type ToolkitConfigUpdate } from "./config.ts";

/** 事务钩子：模块补丁语义之外的模块侧动作 */
export interface ConfigWriteHooks {
  /**
   * 模块的重生效回调：落盘与内存重载之后调用（如把新路由交给链、按新配置重装界面）。
   * 抛出即视为事务失败并上抛（磁盘与内存副本已更新，调用方按失败提示）。
   */
  readonly reapply?: () => void | Promise<void>;
}

/** 落盘实现签名；默认 kit 的唯一写口 saveToolkitConfig，测试注入替身观察顺序与失败路径 */
export type ConfigPersist = (path: string, update: ToolkitConfigUpdate) => Promise<ToolkitConfig>;

export interface ConfigTransactionOptions {
  readonly configPath: string;
  /** 内存重载：把状态中枢的内存副本刷成刚写入的盘上内容 */
  readonly reload: () => Promise<void>;
  /** 重绘请求：由调用方（菜单层）注入；kit 不依赖 tui */
  readonly requestRender?: () => void;
  readonly persist?: ConfigPersist;
}

export interface ConfigTransaction {
  /** 写入补丁：落盘 → 内存重载 → reapply 回调 → 重绘请求 */
  write(update: ToolkitConfigUpdate, hooks?: ConfigWriteHooks): Promise<void>;
}

export function createConfigTransaction(options: ConfigTransactionOptions): ConfigTransaction {
  const persist = options.persist ?? saveToolkitConfig;
  return {
    async write(update, hooks = {}) {
      await persist(options.configPath, update);
      await options.reload();
      await hooks.reapply?.();
      options.requestRender?.();
    },
  };
}
