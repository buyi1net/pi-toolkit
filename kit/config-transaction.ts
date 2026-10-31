import { saveToolkitConfig, type ToolkitConfig, type ToolkitConfigUpdate } from "./config.ts";

export interface ConfigWriteHooks {

  readonly reapply?: () => void | Promise<void>;
}

export type ConfigPersist = (path: string, update: ToolkitConfigUpdate) => Promise<ToolkitConfig>;

export interface ConfigTransactionOptions {
  readonly configPath: string;

  readonly reload: () => Promise<void>;

  readonly requestRender?: () => void;
  readonly persist?: ConfigPersist;
}

export interface ConfigTransaction {

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
