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
import { USAGE_RECORDER_SERVICE_NAME, type UsageRecorderService } from "../usage/api.ts";
import { loadEffectiveTierConfig, MODEL_TIERS, SUBAGENTS_MODULE_ID, type ModelTier } from "./config.ts";
import {
  createModelErrorJournal,
  createProvidersHealthGateway,
  poolBaseRefs,
  type ModelHealthMap,
} from "./model-health.ts";
import { buildSubagentsMenuItems } from "./menu.ts";
import subagentsExtension, {
  subagentsRunningView,
  type SubagentsHostSection,
} from "./mod.ts";
import type { RuntimeRecord } from "./registry.ts";

export { SUBAGENTS_MODULE_ID } from "./config.ts";
export type { ModelHealthMap, ModelRuntimeStatus } from "./model-health.ts";

/** 服务句柄名（注册表要求全小写） */
export const SUBAGENTS_SERVICE_NAME = "subagents.running";
/** 工单 28：候选池 + 运行状态只读句柄（模型与用量面板的快照输入） */
export const SUBAGENTS_MODELS_SERVICE_NAME = "subagents.models";

export interface SubagentsService {
  readonly id: "subagents";
  /** 进程内运行中的子代理数量（与状态 widget 同源，实时） */
  runningCount(): number;
  /** 进程内运行中的子代理名（便于其它模块做哨兵判断） */
  runningNames(): readonly string[];
  /** 会话作用域的持久化运行态登记：沿用 runtime-registry 的既有数据 */
  runtimeRecords(sessionDir: string, sessionId: string): RuntimeRecord[];
}

/** 单个档位的候选池只读视图（models 已剥思考等级后缀且去重） */
export interface SubagentsModelPoolView {
  readonly tier: ModelTier;
  readonly models: readonly string[];
}

/**
 * 候选池与候选运行状态句柄（工单 28）：模型与用量快照据此确定统计范围
 * （只含当前候选池模型）与编排判定（工单 25/26 的网关口径，含错误观测）。
 * 只读：不提供写入口，候选池仍只经配置写入事务修改。
 */
export interface SubagentsModelsService {
  readonly id: "subagents";
  /** 当前生效的候选池（配置链解析后；无配置返回空数组） */
  pools(cwd?: string): readonly SubagentsModelPoolView[];
  /** 候选运行状态（未知不在表内，由消费方按 unknown 处理） */
  health(pool: readonly string[]): ModelHealthMap;
}

function registerSubagents(context: ModuleContext): void {
  // 工单 26：模型错误观测日志（会话内内存态）：子代理临时性路由失败分类
  // 写入，网关读取合并成 unstable/持续不稳定判定；网关与降级重试工具
  // 共享同一实例（ADR 0007：选择与观测读同一份状态）。session_shutdown 清空。
  const modelErrorJournal = createModelErrorJournal();
  // 工单 25：候选池运行状态网关。句柄查找延迟到每次读取时（providers
  // 在 subagents 之后装配，且可能被禁用）：缺席即空表，选择行为不受影响。
  // 工单 26：并入错误观测日志。工单 28：同一实例注册成 `subagents.models`
  // 句柄，用量快照与编排选择读同一份状态（ADR 0007 决策 2）。
  const modelHealth = createProvidersHealthGateway(context.services, modelErrorJournal);
  // 宿主注入：本节点就是 pi-toolkit.json 的 `modules.subagents` 节。
  // getConfig() 返回状态中枢解析后的本模块配置（schema 默认值 + 磁盘取值），
  // 非 schema 键原样透传，因此 models / status 直接可用；写盘由菜单保存的配置写入事务重载。
  subagentsExtension(context.pi, {
    registerCommand: false,
    readHostSection: (): SubagentsHostSection => ({
      source: `${getToolkitConfigPath(getAgentDir())} (modules.${SUBAGENTS_MODULE_ID})`,
      section: context.getConfig(),
    }),
    modelHealth,
    modelErrorJournal,
    // 工单 28：终态统计写入。usage 模块在 subagents 之后装配（且可禁用），
    // 句柄延迟查找；缺席时统计不沉淀，子代理行为不变。
    recordUsage: (event) => {
      context.services.get<UsageRecorderService>(USAGE_RECORDER_SERVICE_NAME)?.record(event);
    },
    // 工单 44：渲染层译者（widget / 状态通知 / 终态行），读实时语言；
    // 模型侧工具输出不经它（原因码冻结口径不变）。
    t: context.t,
  });

  context.services.register(SUBAGENTS_SERVICE_NAME, {
    id: "subagents",
    // 登记表只读投影：count/names 取内存实时态，records 取会话磁盘记录。
    ...subagentsRunningView,
  } satisfies SubagentsService);

  context.services.register(SUBAGENTS_MODELS_SERVICE_NAME, {
    id: "subagents",
    pools(cwd?: string): readonly SubagentsModelPoolView[] {
      const loaded = loadEffectiveTierConfig({ cwd: cwd ?? process.cwd() });
      if (loaded.error || !loaded.config) return [];
      const config = loaded.config;
      return MODEL_TIERS.flatMap((tier: ModelTier) => {
        const models = config.models[tier];
        return models && models.length > 0 ? [{ tier, models: poolBaseRefs(models) }] : [];
      });
    },
    health(pool: readonly string[]): ModelHealthMap {
      return modelHealth.read(pool);
    },
  } satisfies SubagentsModelsService);
}

export function createSubagentsModule(): ModuleDefinition {
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
      registerSubagents(context);
    },
    menuItems(context): ReturnType<typeof buildSubagentsMenuItems> {
      return buildSubagentsMenuItems(context);
    },
  };
}

export const subagentsModule: ModuleDefinition = createSubagentsModule();
