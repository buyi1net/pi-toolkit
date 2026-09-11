// 视觉模块：把 pi-eyes 的核心能力装进 pi-toolkit。
// - `context` 钩子：纯文本模型会话注入结构化视觉笔记（原生多模态模型旁路）
// - `vision_query` 工具：主模型针对最近一张截图追问辅助视觉模型
// - 服务句柄 `eyes.query-latest`：供其它模块查询（本单只注册，不做联动）
// 旧 `/pi-eyes` 命令按合并决策不再注册；交互式视觉配置由 modules/eyes/menu.ts 的原生子菜单承担。

import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getToolkitConfigPath } from "../../config.ts";
import { enabledField, type ModuleContext, type ModuleDefinition } from "../../module.ts";
import { VisionChain } from "./chain.ts";
import {
  DEFAULT_EYES_CONFIG,
  EYES_MODULE_ID,
  formatEyesConfigWarning,
  loadEyesConfig,
  resolveEyesSection,
  toChainRouting,
  type EyesConfig,
  type EyesRouteConfig,
} from "./config.ts";
import { buildEyesMenuItems, type EyesMenuRuntime, type VisionDiagnostic } from "./menu.ts";
import { registerVisionContext, VisionBridge } from "./vision-bridge.ts";
import { registerVisionQuery } from "./vision-tool.ts";

/**
 * 服务句柄名。注册表要求全小写（服务名模式不允许大写字母），
 * 句柄上暴露的方法沿用 pi-eyes 的 API 名 queryLatest。
 */
export const EYES_SERVICE_NAME = "eyes.query-latest";

export interface EyesService {
  readonly id: "eyes";
  /** 针对当前会话最近一张截图向辅助视觉模型提问 */
  queryLatest: VisionBridge["queryLatest"];
}

/** 模块私有运行态：菜单展示的路由镜像、目录版本号与诊断缓存 */
interface EyesRuntimeState {
  globalRoute: EyesRouteConfig;
  /** 由 register 装上：重载配置并刷新视觉链，返回刷新后的全局路由 */
  reapply: ((ctx: ExtensionContext) => Promise<EyesRouteConfig>) | undefined;
  generation: number;
  diagnostic: VisionDiagnostic | undefined;
}

function createMenuRuntime(state: EyesRuntimeState): EyesMenuRuntime {
  return {
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
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function registerEyes(pi: ExtensionAPI, context: ModuleContext, state: EyesRuntimeState): void {
  const chain = new VisionChain();
  const bridge = new VisionBridge(chain, context.t);

  /** 全局节 + 受信任的项目层 → 生效配置；顺带把路由交给视觉链，并把全局路由镜像给菜单 */
  const applyConfig = async (ctx: ExtensionContext, notifyWarnings: boolean): Promise<EyesConfig> => {
    // 视觉路由由模块自己的配置层写盘，状态中枢的内存副本可能落后：读之前先重载
    await context.reloadConfig();
    const section = context.getConfig();
    const loaded = await loadEyesConfig({
      section,
      cwd: ctx.cwd,
      projectTrusted: ctx.isProjectTrusted(),
      source: getToolkitConfigPath(getAgentDir()),
    });
    chain.setRouting(toChainRouting(loaded.config));
    state.globalRoute = resolveEyesSection(section).route;
    if (notifyWarnings && ctx.hasUI) {
      for (const warning of loaded.warnings) {
        ctx.ui.notify(formatEyesConfigWarning(warning, context.t), "warning");
      }
    }
    return loaded.config;
  };

  state.reapply = async (ctx: ExtensionContext): Promise<EyesRouteConfig> => {
    await applyConfig(ctx, false);
    return state.globalRoute;
  };

  context.services.register(EYES_SERVICE_NAME, {
    id: "eyes",
    queryLatest: (question: string, ctx: ExtensionContext) => bridge.queryLatest(question, ctx),
  } satisfies EyesService);

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

export function createEyesModule(): ModuleDefinition {
  const state: EyesRuntimeState = {
    globalRoute: DEFAULT_EYES_CONFIG.route,
    reapply: undefined,
    generation: 0,
    diagnostic: undefined,
  };
  const runtime = createMenuRuntime(state);

  return {
    id: EYES_MODULE_ID,
    labelKey: "module.eyes.label",
    descriptionKey: "module.eyes.description",
    group: "general",
    // schema 只放总开关；视觉路由是结构化配置（非 schema 键），由本模块的菜单与配置层读写
    configSchema: {
      enabled: enabledField("module.eyes.enabled.label", "module.eyes.enabled.description"),
    },
    register(context): void {
      registerEyes(context.pi, context, state);
    },
    menuItems(context): ReturnType<typeof buildEyesMenuItems> {
      return buildEyesMenuItems(context, runtime);
    },
  };
}

export const eyesModule: ModuleDefinition = createEyesModule();
