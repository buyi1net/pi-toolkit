// 装配器：把模块定义按配置落成实际注册。
// 关键约束：enabled=false 的模块在这里被完全跳过，register 与 menuItems 都不会被触碰。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ToolkitConfig } from "./config.ts";
import type { Translator } from "./i18n.ts";
import {
  assertModuleDefinition,
  ENABLED_FIELD,
  normalizeConfigValue,
  type ModuleConfigRecord,
  type ModuleConfigScalar,
  type ModuleContext,
  type ModuleDefinition,
} from "./module.ts";
import type { ServiceRegistry } from "./services.ts";

/** 通过校验并成功注册的模块 */
export interface ActiveModule {
  readonly definition: ModuleDefinition;
}

export interface ModuleFailure {
  readonly definition: ModuleDefinition;
  readonly error: unknown;
}

export interface ModuleContextOptions {
  readonly pi: ExtensionAPI;
  readonly services: ServiceRegistry;
  readonly t: Translator;
  readonly getModuleConfig: (moduleId: string) => ModuleConfigRecord;
  readonly reloadConfig: () => Promise<void>;
  readonly setModuleConfig: (moduleId: string, key: string, value: ModuleConfigScalar) => Promise<ModuleConfigScalar>;
}

export interface AssembleOptions extends ModuleContextOptions {
  readonly modules: readonly ModuleDefinition[];
  readonly config: ToolkitConfig;
}

export interface AssemblyResult {
  readonly loaded: readonly ActiveModule[];
  readonly failures: readonly ModuleFailure[];
}

export function moduleDefaults(definition: ModuleDefinition): ModuleConfigRecord {
  const defaults: ModuleConfigRecord = {};
  for (const [key, field] of Object.entries(definition.configSchema)) {
    defaults[key] = field.default;
  }
  return defaults;
}

/**
 * schema 默认值 + 磁盘取值。
 * schema 声明的键做规范化（非法值丢弃并用默认值兜底）；schema 之外的键原样透传，
 * 供模块读取自己的结构化配置（如视觉路由），菜单不渲染这些键。
 */
export function resolveModuleConfig(
  definition: ModuleDefinition,
  stored: ModuleConfigRecord | undefined,
): ModuleConfigRecord {
  const resolved = moduleDefaults(definition);
  if (!stored) return resolved;
  for (const [key, value] of Object.entries(stored)) {
    const field = definition.configSchema[key];
    if (!field) {
      resolved[key] = value;
      continue;
    }
    const normalized = normalizeConfigValue(field, value);
    if (normalized !== undefined) resolved[key] = normalized;
  }
  return resolved;
}

export function isModuleEnabled(config: ModuleConfigRecord): boolean {
  return config[ENABLED_FIELD] !== false;
}

/** 模块菜单项 id：`<moduleId>.<field>`，模块自定义行自行避让该前缀 */
export function moduleFieldId(moduleId: string, field: string): string {
  return `${moduleId}.${field}`;
}

function createModuleContext(
  definition: ModuleDefinition,
  options: ModuleContextOptions,
): ModuleContext {
  return {
    moduleId: definition.id,
    pi: options.pi,
    services: options.services,
    t: options.t,
    getConfig: () => options.getModuleConfig(definition.id),
    reloadConfig: () => options.reloadConfig(),
    setConfig: (key, value) => options.setModuleConfig(definition.id, key, value),
  };
}

export function assembleModules(options: AssembleOptions): AssemblyResult {
  const loaded: ActiveModule[] = [];
  const failures: ModuleFailure[] = [];
  const seen = new Set<string>();

  for (const definition of options.modules) {
    assertModuleDefinition(definition);
    if (seen.has(definition.id)) {
      throw new Error(`模块 id 重复：${definition.id}`);
    }
    seen.add(definition.id);

    const config = resolveModuleConfig(definition, options.config.modules[definition.id]);
    if (!isModuleEnabled(config)) continue;

    try {
      definition.register(createModuleContext(definition, options));
    } catch (error) {
      failures.push({ definition, error });
      continue;
    }
    loaded.push({ definition });
  }

  return { loaded, failures };
}
