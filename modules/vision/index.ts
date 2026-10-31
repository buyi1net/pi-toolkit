import { type ModuleContext, type ModuleDefinition } from "../../kit/module.ts";
import { VISION_MODULE_ID } from "./config.ts";
import { buildVisionMenuItems, VISION_ENABLED_FIELD } from "./menu.ts";
import { createVisionRuntime } from "./mod.ts";

export { VISION_MODULE_ID } from "./config.ts";
export { VISION_SERVICE_NAME, type VisionService } from "./mod.ts";

export function createVisionModule(): ModuleDefinition {

  const runtime = createVisionRuntime();

  return {
    id: VISION_MODULE_ID,
    labelKey: "module.vision.label",
    descriptionKey: "module.vision.description",

    group: "models",

    configSchema: {
      enabled: VISION_ENABLED_FIELD,
    },
    register(context: ModuleContext): void {
      runtime.register(context);
    },

    topLevel(context): ReturnType<typeof buildVisionMenuItems> {
      return buildVisionMenuItems(context, runtime.menu);
    },
  };
}

export const visionModule: ModuleDefinition = createVisionModule();
