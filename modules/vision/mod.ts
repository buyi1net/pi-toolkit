// vision 模块实现入口（工单 12 按规格决策 11 的模块模板拆分落地）。
//
// 职责：
// - `context` 钩子：纯文本模型会话注入结构化视觉笔记（原生多模态模型旁路）
// - `vision_query` 工具：主模型针对最近一张截图追问辅助视觉模型
// - 服务句柄 `vision.query-latest`：供其它模块查询（本单只注册，不做联动）
// 旧视觉命令按合并决策不再注册；交互式视觉配置由 menu.ts 的原生子菜单承担。

import {
  getAgentDir,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getToolkitConfigPath } from "../../kit/config.ts";
import type { ModuleContext } from "../../kit/module.ts";
import { VisionChain } from "./chain.ts";
import { VisionRouteFacade, type VisionFacadePatch, type VisionSaveOptions } from "./facade.ts";
import type { VisionMenuRuntime } from "./menu.ts";
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

/** 装配入口与菜单读取面共用同一个门面实例 */
export interface VisionRuntime {
  readonly menu: VisionMenuRuntime;
  readonly register: (context: ModuleContext) => void;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function registerVision(context: ModuleContext, facade: VisionRouteFacade): void {
  const chain = new VisionChain();
  const bridge = new VisionBridge(chain, context.t);

  // 合并路由只有一个生效点：门面把合并结果交给链；菜单只读门面快照
  facade.attach(context, (routing) => chain.setRouting(routing));

  context.services.register(VISION_SERVICE_NAME, {
    id: "vision",
    queryLatest: (question: string, ctx: ExtensionContext) => bridge.queryLatest(question, ctx),
  } satisfies VisionService);

  registerVisionQuery(context.pi, bridge);
  registerVisionContext(context.pi, bridge);

  context.pi.on("session_start", async (_event, ctx) => {
    try {
      await facade.refresh(ctx, true);
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
  context.pi.on("agent_start", async () => {
    chain.beginTurn();
  });
}

/** 建一个模块实例的门面；register 与菜单项闭包共享同一个实例 */
export function createVisionRuntime(): VisionRuntime {
  const facade = new VisionRouteFacade();

  return {
    menu: {
      snapshot: () => facade.snapshot(),
      save: (patch: VisionFacadePatch, options?: VisionSaveOptions) => facade.save(patch, options),
    },
    register: (context: ModuleContext): void => {
      registerVision(context, facade);
    },
  };
}
