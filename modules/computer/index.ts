import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ComputerBackend } from "./backend.ts";
import { createNativeComputerBackend } from "./native-backend.ts";
import { computerActionLogPath, createFileActionLog, type ComputerActionLogSink } from "./log.ts";
import { COMPUTER_SCREENSHOT_DIR_LIMIT_BYTES, computerScreenshotDir, type ComputerScreenshotSettings } from "./screenshots.ts";
import type { ComputerStateStore } from "./state.ts";
import { registerComputerTools } from "./tools.ts";
import { enabledField, type ModuleContext, type ModuleDefinition } from "../../kit/module.ts";

export const COMPUTER_MODULE_ID = "computer";

export interface ComputerModuleOptions {

  readonly backend?: ComputerBackend;

  readonly actionLog?: ComputerActionLogSink;

  readonly screenshotDir?: string;

  readonly screenshotDirLimitBytes?: number;

  readonly state?: ComputerStateStore;
}

export function createComputerModule(options: ComputerModuleOptions = {}): ModuleDefinition {
  const backend = options.backend ?? createNativeComputerBackend();
  return {
    id: COMPUTER_MODULE_ID,
    labelKey: "module.computer.label",
    descriptionKey: "module.computer.description",
    group: "general",

    configSchema: {
      enabled: enabledField("module.computer.enabled.label", "module.computer.enabled.description"),
    },

    register(context: ModuleContext): void {
      const actionLog = options.actionLog ?? createFileActionLog(computerActionLogPath(getAgentDir()));
      const screenshots: ComputerScreenshotSettings = {
        dir: options.screenshotDir ?? computerScreenshotDir(getAgentDir()),
        limitBytes: options.screenshotDirLimitBytes ?? COMPUTER_SCREENSHOT_DIR_LIMIT_BYTES,
      };
      registerComputerTools(context, backend, actionLog, screenshots, options.state);
    },
  };
}

export const computerModule: ModuleDefinition = createComputerModule();
