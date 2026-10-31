import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { assembleModules, resolveModuleConfig, type ActiveModule } from "./assembler.ts";
import { getToolkitConfigPath, loadToolkitConfig, type ToolkitConfig } from "./config.ts";
import { createConfigTransaction, type ConfigWriteHooks } from "./config-transaction.ts";
import {
  createTranslator,
  isLanguageSetting,
  resolveLanguage,
  type LanguageSetting,
  type ResolvedLanguage,
  type Translator,
} from "../i18n/index.ts";
import {
  normalizeConfigValue,
  type ModuleConfigRecord,
  type ModuleConfigScalar,
  type ModuleDefinition,
} from "./module.ts";
import { createServiceRegistry, type ServiceRegistry } from "./services.ts";

export interface ToolkitProblem {
  readonly kind: "config" | "module";

  readonly source: string;

  readonly detail: string;
}

export interface Toolkit {
  readonly configPath: string;
  readonly services: ServiceRegistry;

  readonly modules: readonly ActiveModule[];
  readonly problems: readonly ToolkitProblem[];
  getConfig(): ToolkitConfig;
  getLanguage(): LanguageSetting;
  getResolvedLanguage(): ResolvedLanguage;
  getTranslator(): Translator;
  getModuleDefinitions(): readonly ModuleDefinition[];
  getModuleDefinition(moduleId: string): ModuleDefinition | undefined;

  getModuleConfig(moduleId: string): ModuleConfigRecord;

  reloadConfig(): Promise<void>;
  setLanguage(value: string): Promise<LanguageSetting>;

  setModuleField(moduleId: string, field: string, value: ModuleConfigScalar): Promise<ModuleConfigScalar>;
}

export interface CreateToolkitOptions {
  readonly pi: ExtensionAPI;
  readonly agentDir: string;
  readonly modules: readonly ModuleDefinition[];
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function createToolkit(options: CreateToolkitOptions): Promise<Toolkit> {
  const configPath = getToolkitConfigPath(options.agentDir);
  const loaded = await loadToolkitConfig(configPath);
  let config = loaded.config;

  const problems: ToolkitProblem[] = loaded.problems.map((detail) => ({
    kind: "config" as const,
    source: configPath,
    detail,
  }));

  const services = createServiceRegistry();

  const translator = createTranslator(() => resolveLanguage(config.language));

  const getModuleDefinition = (moduleId: string): ModuleDefinition | undefined =>
    options.modules.find((definition) => definition.id === moduleId);

  const getModuleConfig = (moduleId: string): ModuleConfigRecord => {
    const definition = getModuleDefinition(moduleId);
    return definition ? resolveModuleConfig(definition, config.modules[moduleId]) : {};
  };

  const reloadConfig = async (): Promise<void> => {
    config = (await loadToolkitConfig(configPath)).config;
  };

  const configTransaction = createConfigTransaction({ configPath, reload: reloadConfig });

  const saveModuleSection = async (
    moduleId: string,
    patch: ModuleConfigRecord,
    hooks?: ConfigWriteHooks,
  ): Promise<void> => {
    await configTransaction.write({ modules: { [moduleId]: patch } }, hooks);
  };

  const setModuleField = async (
    moduleId: string,
    field: string,
    value: ModuleConfigScalar,
  ): Promise<ModuleConfigScalar> => {
    const definition = getModuleDefinition(moduleId);
    if (!definition) throw new Error(`未知模块：${moduleId}`);
    const schemaField = definition.configSchema[field];
    if (!schemaField) throw new Error(`未知配置字段：${moduleId}.${field}`);
    const normalized = normalizeConfigValue(schemaField, value);
    if (normalized === undefined) {
      throw new Error(`配置字段 ${moduleId}.${field} 不接受取值 ${JSON.stringify(value)}`);
    }
    const section = { ...(config.modules[moduleId] ?? {}), [field]: normalized };
    await saveModuleSection(moduleId, section);
    return normalized;
  };

  const setLanguage = async (value: string): Promise<LanguageSetting> => {
    if (!isLanguageSetting(value)) throw new Error(`未知语言设置：${value}`);
    await configTransaction.write({ language: value });
    return config.language;
  };

  const assembly = assembleModules({
    modules: options.modules,
    config,
    pi: options.pi,
    services,
    t: translator,
    getModuleConfig,
    reloadConfig,
    setModuleConfig: setModuleField,
    saveModuleSection,
  });

  for (const failure of assembly.failures) {
    problems.push({
      kind: "module",
      source: failure.definition.id,
      detail: describeError(failure.error),
    });
  }

  return {
    configPath,
    services,
    modules: assembly.loaded,
    problems,
    getConfig: () => config,
    getLanguage: () => config.language,
    getResolvedLanguage: () => resolveLanguage(config.language),
    getTranslator: () => translator,
    getModuleDefinitions: () => options.modules,
    getModuleDefinition,
    getModuleConfig,
    reloadConfig,
    setLanguage,
    setModuleField,
  };
}
