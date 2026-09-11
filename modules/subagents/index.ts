// 子代理模块：把 pi-subagents 整体装进 pi-toolkit。
//
// 迁入原则是搬移优先于重写：模块根下是原 pi-subagents 的全部实现（工单 13 平掉
// `src/` 夹层后按模块模板落位：本文件是装配定义，`mod.ts` 是实现入口，实现文件
// 平铺，`tools/` 保持子目录；只加了宿主配置注入点与命令注册开关），`agents/`
// 是随包代理定义，`config.json.example` 是包内兜底配置。平层后按 src 相对深度
// 硬算的常量（SUBAGENTS_DIR、PACKAGE_ROOT、package.json 上溯层数、agents
// 发现路径）已同步修正；`-e` 装载路径与 trustedRoots containment 语义不变。
//
// 这里只做装配：
//   - 6 个模型侧工具（subagent / subagent_message / subagents_list /
//     subagent_inspect / subagent_stop / team_dispatch）+ 4 个消息渲染器 +
//     状态 widget + 2 个事件钩子（session_start / session_shutdown）按
//     ModuleDefinition 注册；enabled=false 时装配器根本不调用 register
//   - 旧 `/subagent` 命令不再注册（合并决策 5）
//   - tier 模型路由与状态显示开关读写 pi-toolkit.json 的 `modules.subagents` 节
//   - 服务句柄 `subagents.running`：供其它模块查询子代理运行状态

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getToolkitConfigPath } from "../../kit/config.ts";
import { enabledField, type ModuleContext, type ModuleDefinition } from "../../kit/module.ts";
import { SUBAGENTS_MODULE_ID } from "./config.ts";
import { buildSubagentsMenuItems, type SubagentsMenuRuntime } from "./menu.ts";
import subagentsExtension, {
  listRunningSubagents,
  runtimeRegistryPathForSession,
  type SubagentsHostSection,
} from "./mod.ts";
import { readRuntimeRecords, type RuntimeRecord } from "./runtime-registry.ts";

export { SUBAGENTS_MODULE_ID } from "./config.ts";

/** 服务句柄名（注册表要求全小写） */
export const SUBAGENTS_SERVICE_NAME = "subagents.running";

export interface SubagentsService {
  readonly id: "subagents";
  /** 进程内运行中的子代理数量（与状态 widget 同源，实时） */
  runningCount(): number;
  /** 进程内运行中的子代理名（便于其它模块做哨兵判断） */
  runningNames(): readonly string[];
  /** 会话作用域的持久化运行态登记：沿用 runtime-registry 的既有数据 */
  runtimeRecords(sessionDir: string, sessionId: string): RuntimeRecord[];
}

function registerSubagents(context: ModuleContext, runtime: SubagentsMenuRuntime): void {
  runtime.reload = () => context.reloadConfig();

  // 宿主注入：本节点就是 pi-toolkit.json 的 `modules.subagents` 节。
  // getConfig() 返回状态中枢解析后的本模块配置（schema 默认值 + 磁盘取值），
  // 非 schema 键原样透传，因此 models / status 直接可用；写盘后由 reloadConfig 刷新。
  subagentsExtension(context.pi, {
    registerCommand: false,
    readHostSection: (): SubagentsHostSection => ({
      source: `${getToolkitConfigPath(getAgentDir())} (modules.${SUBAGENTS_MODULE_ID})`,
      section: context.getConfig(),
    }),
  });

  context.services.register(SUBAGENTS_SERVICE_NAME, {
    id: "subagents",
    runningCount: () => listRunningSubagents().length,
    runningNames: () => listRunningSubagents().map((running) => running.name),
    runtimeRecords: (sessionDir, sessionId) =>
      readRuntimeRecords(runtimeRegistryPathForSession(sessionDir, sessionId)),
  } satisfies SubagentsService);
}

export function createSubagentsModule(): ModuleDefinition {
  // 菜单写盘后要让状态中枢重新读盘，否则 getConfig() 还是旧副本
  const runtime: SubagentsMenuRuntime = { reload: async () => {} };

  return {
    id: SUBAGENTS_MODULE_ID,
    labelKey: "module.subagents.label",
    descriptionKey: "module.subagents.description",
    group: "subagents",
    // schema 只放总开关；tier 路由与 status 开关是结构化配置（非 schema 键），
    // 由本模块的菜单与配置层读写。
    configSchema: {
      enabled: enabledField("module.subagents.enabled.label", "module.subagents.enabled.description"),
    },
    register(context): void {
      registerSubagents(context, runtime);
    },
    menuItems(context): ReturnType<typeof buildSubagentsMenuItems> {
      return buildSubagentsMenuItems(context, runtime);
    },
  };
}

export const subagentsModule: ModuleDefinition = createSubagentsModule();
