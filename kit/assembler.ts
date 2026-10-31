import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ToolkitConfig } from "./config.ts";
import type { ConfigWriteHooks } from "./config-transaction.ts";
import type { Translator } from "../i18n/index.ts";
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

  readonly saveModuleSection: (
    moduleId: string,
    patch: ModuleConfigRecord,
    hooks?: ConfigWriteHooks,
  ) => Promise<void>;
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
    saveConfig: (patch, hooks) => options.saveModuleSection(definition.id, patch, hooks),
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
    if (!isModuleEnabled(config) && definition.alwaysAssemble !== true) continue;

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
