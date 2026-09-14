// computer 模块装配定义（工单 01；工具接线在工单 05；动作日志默认落点在工单 06；接入装配在工单 07）：模块身份证、对外契约与工具注册。
//
// 接入装配（工单 07）：本模块已登记进 modules/index.ts 的 BUILT_IN_MODULES 与 MODULE_MESSAGE_TABLES，
// 菜单开关由 schema 的 enabled 字段生成，三语键表随模块目录自包含。
// 契约在 ./contract.ts，三语键表在 ./messages/，状态层在 ./state.ts，原生层接缝在 ./backend.ts，
// P1 真后端在 ./native-backend.ts，动作日志在 ./log.ts。

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
  /** 原生层接缝；不注入时用 P1 真后端（桥 + Rust helper），helper 缺失时如实报不可用 */
  readonly backend?: ComputerBackend;
  /**
   * 动作日志 sink（工单 06）；默认写 <agentDir>/pi-computer/actions.jsonl。
   * 测试要注入内存 sink，不能让动作日志落到真实 agentDir。
   */
  readonly actionLog?: ComputerActionLogSink;
  /**
   * 截图落点（工单 19）；默认 <agentDir>/pi-computer/screenshots。
   * 测试必须注入临时目录，不能让带图观察把截图写进真实 agentDir。
   */
  readonly screenshotDir?: string;
  /**
   * 截图目录总量上限（工单 19）；默认 COMPUTER_SCREENSHOT_DIR_LIMIT_BYTES（128MiB）。
   * 测试注入小上限验证淘汰顺序，生产不改默认。
   */
  readonly screenshotDirLimitBytes?: number;
  /**
   * 状态层接缝（工单 28 修复轮）；不注入时工具层自建默认实现。
   * 测试包一层计数代理，直接断言状态层 observe 次数（等待恰物化一份快照），
   * 不再靠元素编号间接推断。
   */
  readonly state?: ComputerStateStore;
}

export function createComputerModule(options: ComputerModuleOptions = {}): ModuleDefinition {
  const backend = options.backend ?? createNativeComputerBackend();
  return {
    id: COMPUTER_MODULE_ID,
    labelKey: "module.computer.label",
    descriptionKey: "module.computer.description",
    group: "general",
    // schema 只放总开关；能力、引用规则与动作目录是契约常量（contract.ts），不是用户可调项
    configSchema: {
      enabled: enabledField("module.computer.enabled.label", "module.computer.enabled.description"),
    },
    // 工单 05 起接线：工具注册到状态层、后端与动作日志上；接入装配（模块清单/菜单/三语聚合）在工单 07 已落地
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
