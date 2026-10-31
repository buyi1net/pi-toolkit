import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { getToolkitConfigPath, loadToolkitConfig, TOOLKIT_CONFIG_FILENAME } from "../../kit/config.ts";
import type { Translator } from "../../i18n/index.ts";
import type { ModuleConfigRecord, ModuleConfigValue } from "../../kit/module.ts";
import type { VisionRoutingConfig } from "./chain.ts";
import type { VisionMessageKey } from "./messages/index.ts";

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

  allowedModels: VisionModelSelection[] | null;
  fixedModel?: VisionModelSelection;
}

export interface VisionConfig {
  route: VisionRouteConfig;
}

export const DEFAULT_VISION_CONFIG: VisionConfig = {
  route: { mode: "automatic", allowedModels: null },
};

export type VisionConfigProblemCode =
  | "notObject"
  | "notNonEmptyString"
  | "badMode"
  | "allowedModelsNotArray"
  | "fixedRequired";

export interface VisionConfigProblem {
  readonly code: VisionConfigProblemCode;

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

  readonly section: ModuleConfigRecord | undefined;
  readonly cwd: string;
  readonly projectTrusted: boolean;

  readonly source?: string;
}

export interface LoadedVisionConfig {
  readonly config: VisionConfig;
  readonly warnings: readonly VisionConfigWarning[];

  readonly projectLayer: boolean;
}

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

export function describeVisionRoute(config: VisionConfig, t: Translator): string {
  const route = config.route;
  if (route.mode === "fixed" && route.fixedModel) {
    return t("module.vision.route.fixed", { model: `${route.fixedModel.provider}/${route.fixedModel.model}` });
  }
  if (route.allowedModels !== null && route.allowedModels.length === 0) return t("module.vision.route.off");
  return t("module.vision.route.auto");
}

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

export function visionRoutePatch(patch: Partial<VisionRouteConfig>): ModuleConfigRecord {
  return { backend: { route: routeForWrite(patch) } };
}
