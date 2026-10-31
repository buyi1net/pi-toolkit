import { enabledField, type ModuleContext, type ModuleDefinition } from "../../kit/module.ts";
import { buildUsageMenuItems } from "./menu.ts";
import { registerUsage } from "./mod.ts";

export const USAGE_MODULE_ID = "usage";

export {
  USAGE_RECORDER_SERVICE_NAME,
  USAGE_SNAPSHOT_SERVICE_NAME,
  type UsageRecord,
  type UsageRecorderService,
  type UsageRunEvent,
  type UsageSnapshotService,
  type UsageSnapshotView,
} from "./api.ts";

export function createUsageModule(): ModuleDefinition {
  return {
    id: USAGE_MODULE_ID,
    labelKey: "module.usage.label",
    descriptionKey: "module.usage.description",

    group: "models",
    pageId: "providers-usage",
    topLevel: () => [],
    configSchema: {
      enabled: enabledField("module.usage.enabled.label", "module.usage.enabled.description"),
    },
    register(context: ModuleContext): void {
      registerUsage(context);
    },
    menuItems(context): ReturnType<typeof buildUsageMenuItems> {
      return buildUsageMenuItems(context);
    },
  };
}

export const usageModule: ModuleDefinition = createUsageModule();
