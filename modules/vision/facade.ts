import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getToolkitConfigPath } from "../../kit/config.ts";
import type { ModuleContext } from "../../kit/module.ts";
import type { Translator } from "../../i18n/index.ts";
import type { VisionRoutingConfig } from "./chain.ts";
import {
  DEFAULT_VISION_CONFIG,
  cloneVisionRoute,
  describeVisionRoute,
  formatVisionConfigWarning,
  loadVisionConfig,
  resolveVisionSection,
  toChainRouting,
  visionRoutePatch,
  type VisionRouteConfig,
} from "./config.ts";

export interface VisionDiagnostic {
  readonly key: string;
  readonly passed: boolean;
  readonly elapsedMs: number;
  readonly detail: string;
}

export interface VisionRouteSnapshot {

  readonly route: VisionRouteConfig;

  readonly projectLayer: boolean;

  readonly catalogueGeneration: number;

  readonly diagnostic: VisionDiagnostic | undefined;
}

export interface VisionFacadePatch {
  readonly route?: Partial<VisionRouteConfig>;

  readonly catalogueRefreshed?: boolean;

  readonly diagnostic?: VisionDiagnostic;
}

export interface VisionSaveOptions {

  readonly context?: ExtensionContext;
}

export interface VisionRouteFacadeOptions {

  readonly agentDir?: string;
}

export class VisionRouteFacade {
  private context: ModuleContext | undefined;
  private applyRouting: ((routing: VisionRoutingConfig) => void) | undefined;
  private globalRoute: VisionRouteConfig = cloneVisionRoute(DEFAULT_VISION_CONFIG.route);
  private projectLayer = false;
  private generation = 0;
  private diagnostic: VisionDiagnostic | undefined;
  private readonly agentDir: string | undefined;

  constructor(options: VisionRouteFacadeOptions = {}) {
    this.agentDir = options.agentDir;
  }

  attach(context: ModuleContext, applyRouting: (routing: VisionRoutingConfig) => void): void {
    this.context = context;
    this.applyRouting = applyRouting;
  }

  async refresh(ctx: ExtensionContext, notifyWarnings: boolean): Promise<void> {
    const context = this.context;
    if (!context) throw new Error("视觉路由门面尚未装配，无法刷新路由");

    await context.reloadConfig();
    await this.applyLayers(ctx, notifyWarnings);
  }

  private async applyLayers(ctx: ExtensionContext, notifyWarnings: boolean): Promise<void> {
    const context = this.context;
    if (!context) throw new Error("视觉路由门面尚未装配，无法刷新路由");
    const section = context.getConfig();
    const loaded = await loadVisionConfig({
      section,
      cwd: ctx.cwd,
      projectTrusted: ctx.isProjectTrusted(),
      source: getToolkitConfigPath(this.agentDir ?? getAgentDir()),
    });
    this.applyRouting?.(toChainRouting(loaded.config));
    this.globalRoute = resolveVisionSection(section).route;
    this.projectLayer = loaded.projectLayer;
    if (notifyWarnings && ctx.hasUI) {
      for (const warning of loaded.warnings) {
        ctx.ui.notify(formatVisionConfigWarning(warning, context.t), "warning");
      }
    }
  }

  snapshot(): VisionRouteSnapshot {
    return {
      route: cloneVisionRoute(this.globalRoute),
      projectLayer: this.projectLayer,
      catalogueGeneration: this.generation,
      diagnostic: this.diagnostic,
    };
  }

  async save(patch: VisionFacadePatch, options: VisionSaveOptions = {}): Promise<VisionRouteSnapshot> {
    if (patch.route) {
      const ctx = options.context;
      if (!ctx) throw new Error("保存视觉路由需要会话上下文");
      const context = this.context;
      if (!context) throw new Error("视觉路由门面尚未装配，无法保存路由");

      await context.saveConfig(visionRoutePatch(patch.route), {
        reapply: () => this.applyLayers(ctx, false),
      });

      this.diagnostic = undefined;
    }
    if (patch.catalogueRefreshed) {
      this.generation += 1;
      this.diagnostic = undefined;
    }
    if (patch.diagnostic) {
      this.diagnostic = patch.diagnostic;
    }
    return this.snapshot();
  }
}

export function modelValueLabel(route: VisionRouteConfig, t: Translator): string {
  if (route.allowedModels !== null && route.allowedModels.length === 0) {
    return t("module.vision.value.off");
  }
  if (route.mode === "fixed" && route.fixedModel) {
    return `${route.fixedModel.provider}/${route.fixedModel.model}`;
  }
  return t("module.vision.value.auto");
}

export function visionEntryValue(route: VisionRouteConfig, t: Translator): string {
  if (route.allowedModels !== null && route.allowedModels.length === 0) {
    return t("module.vision.value.off");
  }
  if (route.mode === "fixed" && route.fixedModel) {
    return t("module.vision.value.configured");
  }
  return t("module.vision.value.auto");
}

export function routeValueLabel(route: VisionRouteConfig, t: Translator): string {
  return describeVisionRoute({ route }, t);
}
