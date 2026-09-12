// 视觉路由门面（工单 17 / C3）：解析、合并、写盘、描述收成一个读口。
//
// 职责边界：
// - 解析：读骨架状态中枢里的全局 `modules.vision` 节（解析原语在 config.ts）；
// - 合并：全局层 + 受信任项目层逐字段合并，合并结果交给视觉链（唯一生效点）；
// - 写盘：路由补丁永远只写全局 `<agentDir>/pi-toolkit.json`，项目层只读（模块约束）；
// - 描述：给菜单提供可显示的当前值与文案（按决策 7 显示全局值，另带项目层覆盖标记）；
// - 目录版本号与诊断缓存协议由门面持有：路由变更或目录刷新都让诊断缓存失效。
//
// 菜单只画界面：它对门面只需要两个动作——snapshot()（取快照）与 save()（存补丁）。

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

/** 一次自检的诊断缓存（菜单只读；写入走门面补丁） */
export interface VisionDiagnostic {
  readonly key: string;
  readonly passed: boolean;
  readonly elapsedMs: number;
  readonly detail: string;
}

/** 门面快照：菜单渲染与判断覆盖提示所需的全部当前值 */
export interface VisionRouteSnapshot {
  /** 全局层当前路由：菜单显示、编辑与写盘目标（决策 7） */
  readonly route: VisionRouteConfig;
  /** 受信任项目层是否提供了路由：true 时菜单显示覆盖提示（不预设值与全局不同） */
  readonly projectLayer: boolean;
  /** 模型目录版本号：刷新目录成功后递增，是诊断缓存失效依据 */
  readonly catalogueGeneration: number;
  /** 最近一次自检的诊断缓存 */
  readonly diagnostic: VisionDiagnostic | undefined;
}

/** 门面补丁：route 写盘（且只写全局层），其余字段只更新内存里的缓存协议 */
export interface VisionFacadePatch {
  readonly route?: Partial<VisionRouteConfig>;
  /** 模型目录刷新成功：版本号 +1，诊断缓存失效 */
  readonly catalogueRefreshed?: boolean;
  /** 记录一次自检结果 */
  readonly diagnostic?: VisionDiagnostic;
}

export interface VisionSaveOptions {
  /** 路由补丁需要会话上下文（cwd、项目信任状态与告警通知面都从这里取） */
  readonly context?: ExtensionContext;
}

export interface VisionRouteFacadeOptions {
  /** 写盘目标目录；测试夹具可注入临时目录 */
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

  /** 装配时注入骨架上下文与视觉链的收口；菜单不经过这里 */
  attach(context: ModuleContext, applyRouting: (routing: VisionRoutingConfig) => void): void {
    this.context = context;
    this.applyRouting = applyRouting;
  }

  /** 重新解析全局节 + 受信任项目层：合并结果交给视觉链，全局值与覆盖标记进快照 */
  async refresh(ctx: ExtensionContext, notifyWarnings: boolean): Promise<void> {
    const context = this.context;
    if (!context) throw new Error("视觉路由门面尚未装配，无法刷新路由");
    // 会话启动时内存副本可能落后于磁盘：读之前先重载（菜单保存路径由配置写入事务负责重载）
    await context.reloadConfig();
    await this.applyLayers(ctx, notifyWarnings);
  }

  /**
   * 取当前内存副本重新合并并交给视觉链（事务的 reapply）：不自己读盘。
   * 全局值给菜单快照，合并值给链（唯一生效点）。
   */
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

  /** 取门面快照（菜单只读口）：返回副本，调用方改不坏门面状态 */
  snapshot(): VisionRouteSnapshot {
    return {
      route: cloneVisionRoute(this.globalRoute),
      projectLayer: this.projectLayer,
      catalogueGeneration: this.generation,
      diagnostic: this.diagnostic,
    };
  }

  /** 保存补丁：路由事务写全局层（落盘 → 重载 → 重新合并交给链）；目录刷新与自检结果只更新缓存协议 */
  async save(patch: VisionFacadePatch, options: VisionSaveOptions = {}): Promise<VisionRouteSnapshot> {
    if (patch.route) {
      const ctx = options.context;
      if (!ctx) throw new Error("保存视觉路由需要会话上下文");
      const context = this.context;
      if (!context) throw new Error("视觉路由门面尚未装配，无法保存路由");
      // 补丁语义在本模块（visionRoutePatch），写盘与内存重载走 kit 的配置写入事务
      await context.saveConfig(visionRoutePatch(patch.route), {
        reapply: () => this.applyLayers(ctx, false),
      });
      // 路由变了，旧诊断不再可信（回切路由时也不命中过期结果）
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

/** 描述：菜单里显示的当前视觉模型（全局值，不带 fixed 前缀） */
export function modelValueLabel(route: VisionRouteConfig, t: Translator): string {
  if (route.allowedModels !== null && route.allowedModels.length === 0) {
    return t("module.vision.model.off");
  }
  if (route.mode === "fixed" && route.fixedModel) {
    return `${route.fixedModel.provider}/${route.fixedModel.model}`;
  }
  return t("module.vision.model.auto");
}

/** 描述：菜单里的只读路由文案（全局值） */
export function routeValueLabel(route: VisionRouteConfig, t: Translator): string {
  return describeVisionRoute({ route }, t);
}
