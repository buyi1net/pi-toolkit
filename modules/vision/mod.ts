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

export const VISION_SERVICE_NAME = "vision.query-latest";

export interface VisionService {
  readonly id: "vision";

  queryLatest: VisionBridge["queryLatest"];
}

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

  facade.attach(context, (routing) => chain.setRouting(routing));

  context.services.register(VISION_SERVICE_NAME, {
    id: "vision",
    queryLatest: (question: string, ctx: ExtensionContext) => bridge.queryLatest(question, ctx),
  } satisfies VisionService);

  const visionQueryExposure = registerVisionQuery(context.pi, bridge, context.t);
  registerVisionContext(context.pi, bridge);

  context.pi.on("session_start", async (_event, ctx) => {
    visionQueryExposure.sync(ctx.model);
    try {
      await facade.refresh(ctx, true);
    } catch (error) {

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

  context.pi.on("model_select", (event) => {
    visionQueryExposure.sync(event.model);
  });

  context.pi.on("agent_start", async () => {
    chain.beginTurn();
  });
}

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
