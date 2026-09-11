// pi-toolkit 状态中枢：持有配置、语言、服务注册表与已装配模块，向菜单层提供读写入口。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { assembleModules, resolveModuleConfig, type ActiveModule } from "./assembler.ts";
import { getToolkitConfigPath, loadToolkitConfig, saveToolkitConfig, type ToolkitConfig } from "./config.ts";
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
  /** 配置文件路径或模块 id */
  readonly source: string;
  /** 原始错误说明，直接展示在菜单问题行里 */
  readonly detail: string;
}

export interface Toolkit {
  readonly configPath: string;
  readonly services: ServiceRegistry;
  /** 已通过 enabled 开关并成功注册的模块 */
  readonly modules: readonly ActiveModule[];
  readonly problems: readonly ToolkitProblem[];
  getConfig(): ToolkitConfig;
  getLanguage(): LanguageSetting;
  getResolvedLanguage(): ResolvedLanguage;
  getTranslator(): Translator;
  getModuleDefinitions(): readonly ModuleDefinition[];
  getModuleDefinition(moduleId: string): ModuleDefinition | undefined;
  /** 实时解析的本模块配置（schema 默认值 + 磁盘取值） */
  getModuleConfig(moduleId: string): ModuleConfigRecord;
  /** 重新从磁盘读整份配置，刷新内存副本（模块自己写盘後靠它刷新菜单展示与后续读取） */
  reloadConfig(): Promise<void>;
  setLanguage(value: string): Promise<LanguageSetting>;
  /** 写单个模块字段并持久化，返回规范化后的值（只接受 schema 声明的字段） */
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
  // 译者读的是实时语言，语言切换后菜单重建即可刷新全部文案。
  const translator = createTranslator(() => resolveLanguage(config.language));

  const getModuleDefinition = (moduleId: string): ModuleDefinition | undefined =>
    options.modules.find((definition) => definition.id === moduleId);

  const getModuleConfig = (moduleId: string): ModuleConfigRecord => {
    const definition = getModuleDefinition(moduleId);
    return definition ? resolveModuleConfig(definition, config.modules[moduleId]) : {};
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
    config = await saveToolkitConfig(configPath, { modules: { [moduleId]: section } });
    return normalized;
  };

  const setLanguage = async (value: string): Promise<LanguageSetting> => {
    if (!isLanguageSetting(value)) throw new Error(`未知语言设置：${value}`);
    config = await saveToolkitConfig(configPath, { language: value });
    return config.language;
  };

  const reloadConfig = async (): Promise<void> => {
    config = (await loadToolkitConfig(configPath)).config;
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
