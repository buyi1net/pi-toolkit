// vision 模块实现入口（工单 12 按规格决策 11 的模块模板拆分落地）。
//
// 职责：
// - `context` 钩子：纯文本模型会话注入结构化视觉笔记（原生多模态模型旁路）
// - `vision_query` 工具：主模型针对最近一张截图追问辅助视觉模型
// - 服务句柄 `vision.query-latest`：供其它模块查询（本单只注册，不做联动）
// 旧视觉命令按合并决策不再注册；交互式视觉配置由 menu.ts 的原生子菜单承担。

import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getToolkitConfigPath } from "../../kit/config.ts";
import type { ModuleContext } from "../../kit/module.ts";
import { VisionChain } from "./chain.ts";
import {
  DEFAULT_VISION_CONFIG,
  formatVisionConfigWarning,
  loadVisionConfig,
  resolveVisionSection,
  toChainRouting,
  type VisionConfig,
  type VisionRouteConfig,
} from "./config.ts";
import type { VisionDiagnostic, VisionMenuRuntime } from "./menu.ts";
import { registerVisionContext, VisionBridge } from "./vision-bridge.ts";
import { registerVisionQuery } from "./vision-tool.ts";

/**
 * 服务句柄名（工单 07 定案）。注册表要求全小写
 * （服务名模式不允许大写字母），句柄上暴露的方法名 queryLatest 保持不变。
 */
export const VISION_SERVICE_NAME = "vision.query-latest";

export interface VisionService {
  readonly id: "vision";
  /** 针对当前会话最近一张截图向辅助视觉模型提问 */
  queryLatest: VisionBridge["queryLatest"];
}

/** 模块实例的运行态：菜单展示的路由镜像、目录版本号与诊断缓存 */
interface VisionRuntimeState {
  globalRoute: VisionRouteConfig;
  /** 由 register 装上：重载配置并刷新视觉链，返回刷新后的全局路由 */
  reapply: ((ctx: ExtensionContext) => Promise<VisionRouteConfig>) | undefined;
  generation: number;
  diagnostic: VisionDiagnostic | undefined;
}

/** 装配入口与菜单读取面共用同一份运行态 */
export interface VisionRuntime {
  readonly menu: VisionMenuRuntime;
  readonly register: (context: ModuleContext) => void;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function registerVision(
  pi: ExtensionAPI,
  context: ModuleContext,
  state: VisionRuntimeState,
): void {
  const chain = new VisionChain();
  const bridge = new VisionBridge(chain, context.t);

  /** 全局节 + 受信任的项目层 → 生效配置；顺带把路由交给视觉链，并把全局路由镜像给菜单 */
  const applyConfig = async (ctx: ExtensionContext, notifyWarnings: boolean): Promise<VisionConfig> => {
    // 视觉路由由模块自己的配置层写盘，状态中枢的内存副本可能落后：读之前先重载
    await context.reloadConfig();
    const section = context.getConfig();
    const loaded = await loadVisionConfig({
      section,
      cwd: ctx.cwd,
      projectTrusted: ctx.isProjectTrusted(),
      source: getToolkitConfigPath(getAgentDir()),
    });
    chain.setRouting(toChainRouting(loaded.config));
    state.globalRoute = resolveVisionSection(section).route;
    if (notifyWarnings && ctx.hasUI) {
      for (const warning of loaded.warnings) {
        ctx.ui.notify(formatVisionConfigWarning(warning, context.t), "warning");
      }
    }
    return loaded.config;
  };

  state.reapply = async (ctx: ExtensionContext): Promise<VisionRouteConfig> => {
    await applyConfig(ctx, false);
    return state.globalRoute;
  };

  context.services.register(VISION_SERVICE_NAME, {
    id: "vision",
    queryLatest: (question: string, ctx: ExtensionContext) => bridge.queryLatest(question, ctx),
  } satisfies VisionService);

  registerVisionQuery(pi, bridge);
  registerVisionContext(pi, bridge);

  pi.on("session_start", async (_event, ctx) => {
    try {
      await applyConfig(ctx, true);
    } catch (error) {
      // 配置读取意外失败不能拖垮会话：只提示，后续按默认路由工作
      if (ctx.hasUI) {
        ctx.ui.notify(
          context.t("problem.summary", {
            label: context.t("problem.config"),
            source: getToolkitConfigPath(getAgentDir()),
            detail: describeError(error),
          }),
          "warning",
        );
      }
    }
  });

  // 一次 agent run 记一轮：清掉上一轮的失败短路与熔断
  pi.on("agent_start", async () => {
    chain.beginTurn();
  });
}

/** 建一个模块实例的运行态；register 与菜单项闭包共享这份状态 */
export function createVisionRuntime(): VisionRuntime {
  const state: VisionRuntimeState = {
    globalRoute: DEFAULT_VISION_CONFIG.route,
    reapply: undefined,
    generation: 0,
    diagnostic: undefined,
  };

  const menu: VisionMenuRuntime = {
    globalRoute: () => state.globalRoute,
    reapply: (ctx) => {
      if (!state.reapply) throw new Error("视觉模块尚未完成注册，无法刷新视觉路由");
      return state.reapply(ctx);
    },
    catalogueGeneration: () => state.generation,
    bumpCatalogueGeneration: () => {
      state.generation += 1;
    },
    diagnostic: () => state.diagnostic,
    setDiagnostic: (diagnostic) => {
      state.diagnostic = diagnostic;
    },
  };

  return {
    menu,
    register: (context: ModuleContext): void => {
      registerVision(context.pi, context, state);
    },
  };
}
