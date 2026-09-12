// 视觉模块的配置解析与保存：读写 pi-toolkit.json 里 `modules.vision` 节。
//
// 结构：`backend.route.{mode,allowedModels,fixedModel}`，语言不再重复存——
// 界面语言用骨架的顶层 `language` 键，本模块只保留视觉路由。
// 按规格决策 8，不做旧配置迁移：只认 automatic / fixed 两种模式。
// 项目层覆盖语义：仅当项目受信任时读取 `<cwd>/.pi/pi-toolkit.json` 的同一节，
// 按字段（mode / allowedModels / fixedModel）逐项覆盖全局；非法层整体忽略并给出告警。

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { getToolkitConfigPath, loadToolkitConfig, TOOLKIT_CONFIG_FILENAME } from "../../kit/config.ts";
import type { Translator } from "../../i18n/index.ts";
import type { ModuleConfigRecord, ModuleConfigValue } from "../../kit/module.ts";
import type { VisionRoutingConfig } from "./chain.ts";
import type { VisionMessageKey } from "./messages/index.ts";

/** 模块 id：同时是配置节名与菜单项 id 前缀 */
export const VISION_MODULE_ID = "vision";

const SECTION_FIELD = `modules.${VISION_MODULE_ID}`;
const ROUTE_FIELD = `${SECTION_FIELD}.backend.route`;

export type VisionRouteMode = "automatic" | "fixed";

export interface VisionModelSelection {
  provider: string;
  model: string;
}

export interface VisionRouteConfig {
  mode: VisionRouteMode;
  /** null 表示不限制候选；空数组表示关闭视觉辅助（off 语义） */
  allowedModels: VisionModelSelection[] | null;
  fixedModel?: VisionModelSelection;
}

export interface VisionConfig {
  route: VisionRouteConfig;
}

export const DEFAULT_VISION_CONFIG: VisionConfig = {
  route: { mode: "automatic", allowedModels: null },
};

/** 配置告警码：文案在 i18n 键表，配置层不带语言 */
export type VisionConfigProblemCode =
  | "notObject"
  | "notNonEmptyString"
  | "badMode"
  | "allowedModelsNotArray"
  | "fixedRequired";

export interface VisionConfigProblem {
  readonly code: VisionConfigProblemCode;
  /** 出问题的字段路径，如 modules.vision.backend.route.mode */
  readonly field: string;
}

export type VisionConfigWarning =
  | { readonly kind: "problem"; readonly source: string; readonly problem: VisionConfigProblem }
  | { readonly kind: "detail"; readonly detail: string };

const PROBLEM_KEYS: Record<VisionConfigProblemCode, VisionMessageKey> = {
  notObject: "module.vision.configError.notObject",
  notNonEmptyString: "module.vision.configError.notNonEmptyString",
  badMode: "module.vision.configError.badMode",
  allowedModelsNotArray: "module.vision.configError.allowedModelsNotArray",
  fixedRequired: "module.vision.configError.fixedRequired",
};

export function formatVisionProblem(problem: VisionConfigProblem, t: Translator): string {
  return t(PROBLEM_KEYS[problem.code], { field: problem.field });
}

export function formatVisionConfigWarning(warning: VisionConfigWarning, t: Translator): string {
  if (warning.kind === "detail") return warning.detail;
  return t("problem.summary", {
    label: t("problem.config"),
    source: warning.source,
    detail: formatVisionProblem(warning.problem, t),
  });
}

/** 一层路由配置（低优先级在前，高优先级在后） */
export interface VisionRouteLayer {
  readonly source: string;
  readonly route: Partial<VisionRouteConfig>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneModels(models: VisionModelSelection[] | null): VisionModelSelection[] | null {
  return models === null ? null : models.map((model) => ({ ...model }));
}

/** 复制一份路由：门面快照与分层合并都靠它隔离调用方对内部状态的写入 */
export function cloneVisionRoute(route: VisionRouteConfig): VisionRouteConfig {
  return {
    mode: route.mode,
    allowedModels: cloneModels(route.allowedModels),
    ...(route.fixedModel ? { fixedModel: { ...route.fixedModel } } : {}),
  };
}

function cloneConfig(config: VisionConfig): VisionConfig {
  return { route: cloneVisionRoute(config.route) };
}

function parseModelSelection(value: unknown, field: string, problems: VisionConfigProblem[]): VisionModelSelection | undefined {
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
): { layer?: VisionRouteLayer; warnings: VisionConfigWarning[] } {
  const warnings: VisionConfigWarning[] = [];
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
  const problems: VisionConfigProblem[] = [];
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
export function resolveVisionLayers(
  layers: readonly VisionRouteLayer[],
): { config: VisionConfig; warnings: VisionConfigWarning[] } {
  const warnings: VisionConfigWarning[] = [];
  let route = cloneVisionRoute(DEFAULT_VISION_CONFIG.route);

  for (const layer of layers) {
    const next = cloneVisionRoute(route);
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

export interface LoadVisionConfigOptions {
  /** 骨架解析出的全局模块节（ModuleContext.getConfig()） */
  readonly section: ModuleConfigRecord | undefined;
  readonly cwd: string;
  readonly projectTrusted: boolean;
  /** 全局配置来源，用于告警里的出处；默认取模块节名 */
  readonly source?: string;
}

export interface LoadedVisionConfig {
  readonly config: VisionConfig;
  readonly warnings: readonly VisionConfigWarning[];
  /** 项目层是否实际提供了路由配置 */
  readonly projectLayer: boolean;
}

/** 全局节 + 受信任的项目层逐字段合并，得到本会话实际生效的视觉配置 */
export async function loadVisionConfig(options: LoadVisionConfigOptions): Promise<LoadedVisionConfig> {
  const source = options.source ?? getToolkitConfigPath(getAgentDir());
  const warnings: VisionConfigWarning[] = [];
  const layers: VisionRouteLayer[] = [];

  const global = routeFromSection(options.section, source);
  warnings.push(...global.warnings);
  if (global.layer) layers.push(global.layer);

  let projectLayer = false;
  if (options.projectTrusted) {
    const projectPath = join(options.cwd, CONFIG_DIR_NAME, TOOLKIT_CONFIG_FILENAME);
    // 项目层按约定只读（该文件归用户/项目维护）：旧节只在内存里正名，不回写项目文件
    const loadedProject = await loadToolkitConfig(projectPath, { writeBackLegacyMigration: false });
    for (const detail of loadedProject.problems) warnings.push({ kind: "detail", detail });
    const project = routeFromSection(loadedProject.config.modules[VISION_MODULE_ID], projectPath);
    warnings.push(...project.warnings);
    if (project.layer) {
      layers.push(project.layer);
      projectLayer = true;
    }
  }

  const resolved = resolveVisionLayers(layers);
  warnings.push(...resolved.warnings);
  return { config: resolved.config, warnings, projectLayer };
}

export function toChainRouting(config: VisionConfig): VisionRoutingConfig {
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
export function describeVisionRoute(config: VisionConfig, t: Translator): string {
  const route = config.route;
  if (route.mode === "fixed" && route.fixedModel) {
    return t("module.vision.route.fixed", { model: `${route.fixedModel.provider}/${route.fixedModel.model}` });
  }
  if (route.allowedModels !== null && route.allowedModels.length === 0) return t("module.vision.route.off");
  return t("module.vision.route.auto");
}

/** 菜单渲染时同步解析全局节（不做 IO，拿不到项目层；项目层在会话启动时应用） */
export function resolveVisionSection(section: ModuleConfigRecord | undefined): VisionConfig {
  const parsed = routeFromSection(section, SECTION_FIELD);
  return resolveVisionLayers(parsed.layer ? [parsed.layer] : []).config;
}

function routeForWrite(patch: Partial<VisionRouteConfig>): ModuleConfigValue {
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

/**
 * 写盘补丁语义（工单 19）：路由补丁 → `modules.vision` 节补丁。
 * 只带 patch 里出现的字段（深合并交给 kit 的事务），供 ModuleContext.saveConfig 写入。
 */
export function visionRoutePatch(patch: Partial<VisionRouteConfig>): ModuleConfigRecord {
  return { backend: { route: routeForWrite(patch) } };
}
