// 视觉模块的配置解析与保存：读写 pi-toolkit.json 里 `modules.eyes` 节。
//
// 结构照搬 pi-eyes（`backend.route.{mode,allowedModels,fixedModel}`），语言不再重复存——
// 界面语言用骨架的顶层 `language` 键，本模块只保留视觉路由。
// 按规格决策 8，不做旧配置迁移：只认 automatic / fixed 两种模式。
// 项目层覆盖沿用 pi-eyes 语义：仅当项目受信任时读取 `<cwd>/.pi/pi-toolkit.json` 的同一节，
// 按字段（mode / allowedModels / fixedModel）逐项覆盖全局；非法层整体忽略并给出告警。

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { getToolkitConfigPath, loadToolkitConfig, saveToolkitConfig, TOOLKIT_CONFIG_FILENAME } from "../../config.ts";
import type { MessageKey, Translator } from "../../i18n.ts";
import type { ModuleConfigRecord, ModuleConfigValue } from "../../module.ts";
import type { VisionRoutingConfig } from "./chain.ts";

/** 模块 id：同时是配置节名与菜单项 id 前缀 */
export const EYES_MODULE_ID = "eyes";

const SECTION_FIELD = `modules.${EYES_MODULE_ID}`;
const ROUTE_FIELD = `${SECTION_FIELD}.backend.route`;

export type VisionRouteMode = "automatic" | "fixed";

export interface VisionModelSelection {
  provider: string;
  model: string;
}

export interface EyesRouteConfig {
  mode: VisionRouteMode;
  /** null 表示不限制候选；空数组表示关闭视觉辅助（pi-eyes 的 off 语义） */
  allowedModels: VisionModelSelection[] | null;
  fixedModel?: VisionModelSelection;
}

export interface EyesConfig {
  route: EyesRouteConfig;
}

export const DEFAULT_EYES_CONFIG: EyesConfig = {
  route: { mode: "automatic", allowedModels: null },
};

/** 配置告警码：文案在 i18n 键表，配置层不带语言 */
export type EyesConfigProblemCode =
  | "notObject"
  | "notNonEmptyString"
  | "badMode"
  | "allowedModelsNotArray"
  | "fixedRequired";

export interface EyesConfigProblem {
  readonly code: EyesConfigProblemCode;
  /** 出问题的字段路径，如 modules.eyes.backend.route.mode */
  readonly field: string;
}

export type EyesConfigWarning =
  | { readonly kind: "problem"; readonly source: string; readonly problem: EyesConfigProblem }
  | { readonly kind: "detail"; readonly detail: string };

const PROBLEM_KEYS: Record<EyesConfigProblemCode, MessageKey> = {
  notObject: "module.eyes.configError.notObject",
  notNonEmptyString: "module.eyes.configError.notNonEmptyString",
  badMode: "module.eyes.configError.badMode",
  allowedModelsNotArray: "module.eyes.configError.allowedModelsNotArray",
  fixedRequired: "module.eyes.configError.fixedRequired",
};

export function formatEyesProblem(problem: EyesConfigProblem, t: Translator): string {
  return t(PROBLEM_KEYS[problem.code], { field: problem.field });
}

export function formatEyesConfigWarning(warning: EyesConfigWarning, t: Translator): string {
  if (warning.kind === "detail") return warning.detail;
  return t("problem.summary", {
    label: t("problem.config"),
    source: warning.source,
    detail: formatEyesProblem(warning.problem, t),
  });
}

/** 一层路由配置（低优先级在前，高优先级在后） */
export interface EyesRouteLayer {
  readonly source: string;
  readonly route: Partial<EyesRouteConfig>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneModels(models: VisionModelSelection[] | null): VisionModelSelection[] | null {
  return models === null ? null : models.map((model) => ({ ...model }));
}

function cloneRoute(route: EyesRouteConfig): EyesRouteConfig {
  return {
    mode: route.mode,
    allowedModels: cloneModels(route.allowedModels),
    ...(route.fixedModel ? { fixedModel: { ...route.fixedModel } } : {}),
  };
}

function cloneConfig(config: EyesConfig): EyesConfig {
  return { route: cloneRoute(config.route) };
}

function parseModelSelection(value: unknown, field: string, problems: EyesConfigProblem[]): VisionModelSelection | undefined {
  if (!isRecord(value)) {
    problems.push({ code: "notObject", field });
    return undefined;
  }
  if (typeof value.provider !== "string" || value.provider.trim() === "") {
    problems.push({ code: "notNonEmptyString", field: `${field}.provider` });
    return undefined;
  }
  if (typeof value.model !== "string" || value.model.trim() === "") {
    problems.push({ code: "notNonEmptyString", field: `${field}.model` });
    return undefined;
  }
  return { provider: value.provider, model: value.model };
}

/** 从 pi-toolkit.json 的一个模块节里取出路由层；只保留通过校验的字段 */
function routeFromSection(
  section: ModuleConfigRecord | undefined,
  source: string,
): { layer?: EyesRouteLayer; warnings: EyesConfigWarning[] } {
  const warnings: EyesConfigWarning[] = [];
  if (section === undefined) return { warnings };

  const backend = section.backend;
  if (backend === undefined) return { warnings };
  if (!isRecord(backend)) {
    warnings.push({ kind: "problem", source, problem: { code: "notObject", field: `${SECTION_FIELD}.backend` } });
    return { warnings };
  }
  if (backend.route === undefined) return { warnings };
  if (!isRecord(backend.route)) {
    warnings.push({ kind: "problem", source, problem: { code: "notObject", field: ROUTE_FIELD } });
    return { warnings };
  }

  const raw = backend.route;
  const problems: EyesConfigProblem[] = [];
  const layer: {
    mode?: VisionRouteMode;
    allowedModels?: VisionModelSelection[] | null;
    fixedModel?: VisionModelSelection;
  } = {};

  if (raw.mode !== undefined) {
    if (raw.mode === "automatic" || raw.mode === "fixed") layer.mode = raw.mode;
    else problems.push({ code: "badMode", field: `${ROUTE_FIELD}.mode` });
  }

  if (raw.allowedModels !== undefined) {
    if (raw.allowedModels === null) {
      layer.allowedModels = null;
    } else if (Array.isArray(raw.allowedModels)) {
      const parsed: VisionModelSelection[] = [];
      raw.allowedModels.forEach((entry, index) => {
        const selection = parseModelSelection(entry, `${ROUTE_FIELD}.allowedModels[${index}]`, problems);
        if (selection) parsed.push(selection);
      });
      // 有非法项就整条白名单不采用，避免悄悄改变候选集合
      if (parsed.length === raw.allowedModels.length) layer.allowedModels = parsed;
    } else {
      problems.push({ code: "allowedModelsNotArray", field: `${ROUTE_FIELD}.allowedModels` });
    }
  }

  if (raw.fixedModel !== undefined) {
    const fixed = parseModelSelection(raw.fixedModel, `${ROUTE_FIELD}.fixedModel`, problems);
    if (fixed) layer.fixedModel = fixed;
  }

  for (const problem of problems) warnings.push({ kind: "problem", source, problem });
  const used = layer.mode !== undefined || layer.allowedModels !== undefined || layer.fixedModel !== undefined;
  return { layer: used ? { source, route: layer } : undefined, warnings };
}

/** 逐字段合并各层路由：高优先级层没写的字段保留低优先级取值 */
export function resolveEyesLayers(
  layers: readonly EyesRouteLayer[],
): { config: EyesConfig; warnings: EyesConfigWarning[] } {
  const warnings: EyesConfigWarning[] = [];
  let route = cloneRoute(DEFAULT_EYES_CONFIG.route);

  for (const layer of layers) {
    const next = cloneRoute(route);
    if (layer.route.mode !== undefined) next.mode = layer.route.mode;
    if (layer.route.allowedModels !== undefined) next.allowedModels = cloneModels(layer.route.allowedModels);
    if (layer.route.fixedModel !== undefined) next.fixedModel = { ...layer.route.fixedModel };
    if (next.mode === "fixed" && !next.fixedModel) {
      // 该层把配置推到非法状态：整层忽略，保留上一层的可用取值
      warnings.push({
        kind: "problem",
        source: layer.source,
        problem: { code: "fixedRequired", field: `${ROUTE_FIELD}.fixedModel` },
      });
      continue;
    }
    route = next;
  }

  return { config: { route }, warnings };
}

export interface LoadEyesConfigOptions {
  /** 骨架解析出的全局模块节（ModuleContext.getConfig()） */
  readonly section: ModuleConfigRecord | undefined;
  readonly cwd: string;
  readonly projectTrusted: boolean;
  /** 全局配置来源，用于告警里的出处；默认取模块节名 */
  readonly source?: string;
}

export interface LoadedEyesConfig {
  readonly config: EyesConfig;
  readonly warnings: readonly EyesConfigWarning[];
  /** 项目层是否实际提供了路由配置 */
  readonly projectLayer: boolean;
}

/** 全局节 + 受信任的项目层逐字段合并，得到本会话实际生效的视觉配置 */
export async function loadEyesConfig(options: LoadEyesConfigOptions): Promise<LoadedEyesConfig> {
  const source = options.source ?? getToolkitConfigPath(getAgentDir());
  const warnings: EyesConfigWarning[] = [];
  const layers: EyesRouteLayer[] = [];

  const global = routeFromSection(options.section, source);
  warnings.push(...global.warnings);
  if (global.layer) layers.push(global.layer);

  let projectLayer = false;
  if (options.projectTrusted) {
    const projectPath = join(options.cwd, CONFIG_DIR_NAME, TOOLKIT_CONFIG_FILENAME);
    const loadedProject = await loadToolkitConfig(projectPath);
    for (const detail of loadedProject.problems) warnings.push({ kind: "detail", detail });
    const project = routeFromSection(loadedProject.config.modules[EYES_MODULE_ID], projectPath);
    warnings.push(...project.warnings);
    if (project.layer) {
      layers.push(project.layer);
      projectLayer = true;
    }
  }

  const resolved = resolveEyesLayers(layers);
  warnings.push(...resolved.warnings);
  return { config: resolved.config, warnings, projectLayer };
}

export function toChainRouting(config: EyesConfig): VisionRoutingConfig {
  return {
    route: {
      mode: config.route.mode,
      allowedModels: config.route.allowedModels?.map((model) => ({
        provider: model.provider,
        modelId: model.model,
      })) ?? null,
      ...(config.route.fixedModel
        ? { fixedModel: { provider: config.route.fixedModel.provider, modelId: config.route.fixedModel.model } }
        : {}),
    },
  };
}

/** 只读展示当前路由（菜单行用） */
export function describeEyesRoute(config: EyesConfig, t: Translator): string {
  const route = config.route;
  if (route.mode === "fixed" && route.fixedModel) {
    return t("module.eyes.route.fixed", { model: `${route.fixedModel.provider}/${route.fixedModel.model}` });
  }
  if (route.allowedModels !== null && route.allowedModels.length === 0) return t("module.eyes.route.off");
  return t("module.eyes.route.auto");
}

/** 菜单渲染时同步解析全局节（不做 IO，拿不到项目层；项目层在会话启动时应用） */
export function resolveEyesSection(section: ModuleConfigRecord | undefined): EyesConfig {
  const parsed = routeFromSection(section, SECTION_FIELD);
  return resolveEyesLayers(parsed.layer ? [parsed.layer] : []).config;
}

function routeForWrite(patch: Partial<EyesRouteConfig>): ModuleConfigValue {
  return {
    ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
    ...(patch.allowedModels !== undefined
      ? {
          allowedModels: patch.allowedModels === null
            ? null
            : patch.allowedModels.map((model) => ({ provider: model.provider, model: model.model })),
        }
      : {}),
    ...(patch.fixedModel !== undefined
      ? { fixedModel: { provider: patch.fixedModel.provider, model: patch.fixedModel.model } }
      : {}),
  };
}

export interface SaveEyesRouteOptions {
  /** 配置目录；默认 pi 的 agentDir */
  readonly agentDir?: string;
}

/**
 * 写视觉路由到 `<agentDir>/pi-toolkit.json`。
 * 走骨架的原子写 + 剥敏感键，另有 `mergeRaw` 深合并：只覆盖 patch 里出现的字段。
 */
export async function saveEyesRoute(
  patch: Partial<EyesRouteConfig>,
  options: SaveEyesRouteOptions = {},
): Promise<void> {
  const path = getToolkitConfigPath(options.agentDir ?? getAgentDir());
  await saveToolkitConfig(path, {
    modules: { [EYES_MODULE_ID]: { backend: { route: routeForWrite(patch) } } },
  });
}
