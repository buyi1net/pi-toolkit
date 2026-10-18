// 子代理模块的配置落点：pi-toolkit.json 的 `modules.subagents` 节。
//
// 归一裁决（工单 04）：tier 模型路由（`models.fast` / `models.balanced` /
// `models.flagship` 的有序候选池，工单 21）与状态显示开关（`status.enabled`）的
// 菜单读写都落这一节；
// 原 pi-subagents 包内 config.json 的 status.enabled 只作兜底默认。
//
// tier 解析保留六级覆盖链（外部显式配置优先，包内文件兜底），工单 00 起为
// 逐档合并而非首个文件终局（每一档的候选池与思考等级各自独立取最高优先
// 级的合法声明层，非法声明记入问题清单后落低层）：
//   1. env PI_SUBAGENTS_CONFIG（硬错误 + 整份锁定，不与低层合并）
//   2. 项目 <cwd>/.pi/agent/pi-subagents.json
//   3. 全局 <agentDir>/pi-subagents.json
//   4. pi-toolkit.json 的 modules.subagents 节（本文件负责读写；声明了
//      models 或 thinking 任一键即参与，非法取值落低层并入问题清单）
//   5. 模块目录 config.json
//   6. 模块目录 config.json.example
// 候选链的逐档拼接在 routing.ts，本文件只负责本节的读写与校验；菜单读
// 生效值也经 loadEffectiveTierConfig 走同一读口。

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getToolkitConfigPath } from "../../kit/config.ts";
import type { ModuleConfigRecord } from "../../kit/module.ts";
import {
  MODEL_TIERS,
  THINKING_LEVELS,
  effectiveTierMapping,
  normalizeTier,
  parseTierConfig,
  parseTierConfigLenient,
  resolveTierForParams,
  loadTierRouteConfig,
  type EffectiveTierRouteConfig,
  type ModelTier,
  type ThinkingLevel,
  type TierConfigLoadResult,
} from "./routing.ts";
import { getAgentConfigDir, resolveHostTierSources } from "./mod.ts";

/** 模块 id：同时是配置节名与菜单项 id 前缀 */
export const SUBAGENTS_MODULE_ID = "subagents";

export { MODEL_TIERS, THINKING_LEVELS, effectiveTierMapping, normalizeTier };
export type { EffectiveTierRouteConfig, ModelTier, ThinkingLevel, TierConfigLoadResult };

export type TierMapping = Partial<Record<ModelTier, string[]>>;

/** 档位默认思考等级映射（工单 23）：本节第 4 级的本地写点 */
export type TierThinkingMapping = Partial<Record<ModelTier, ThinkingLevel>>;

export interface SubagentsSectionView {
  /** 已校验的 tier 映射；非法项被丢弃并记录在 problems 里 */
  readonly tier: TierMapping;
  /** 已校验的档位默认思考等级；非法项被丢弃并记录在 problems 里 */
  readonly tierThinking: TierThinkingMapping;
  /** `status.enabled`；未声明时为 undefined（落回包内 config.json 的兜底默认） */
  readonly statusEnabled: boolean | undefined;
  readonly problems: readonly string[];
  /**
   * 本节 models/thinking 树的逐档问题（工单 05）：候选池编辑器的锁定条
   * 件——混合合法/非法档时编辑器整体锁进错误态，不出现「部分正常」的
   * 可编辑假象（problems 还包含 status 的问题，不能直接当锁定条件用）。
   */
  readonly tierProblems: readonly string[];
}

const SECTION_LABEL = `modules.${SUBAGENTS_MODULE_ID}`;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 读 `modules.subagents` 节。逐档宽容解析（工单 47）：一档坏值只丢该档，
 * 其余合法档照常读出。单档校验规则与错误文案与严格入口逐字一致，
 * spawn 路径（loadEffectiveTierConfig）仍从严，不静默降级。
 */
export function readSubagentsSection(section: Record<string, unknown>): SubagentsSectionView {
  const lenient = parseTierConfigLenient(section, SECTION_LABEL);
  const tier: TierMapping = { ...lenient.models };
  const tierThinking: TierThinkingMapping = { ...lenient.thinking };
  const tierProblems: readonly string[] = [...lenient.problems];
  const problems: string[] = [...tierProblems];

  let statusEnabled: boolean | undefined;
  const status = section.status;
  if (status !== undefined) {
    if (!isPlainObject(status)) {
      problems.push(`${SECTION_LABEL}.status must be an object`);
    } else if (status.enabled !== undefined) {
      if (typeof status.enabled === "boolean") statusEnabled = status.enabled;
      else problems.push(`${SECTION_LABEL}.status.enabled must be a boolean`);
    }
  }

  return { tier, tierThinking, statusEnabled, problems, tierProblems };
}

/**
 * 本节点路径。菜单写盘与错误提示定位共用它——spawn 时的同一级来源也指向这里。
 */
export function subagentsSectionPath(agentDir?: string): string {
  return `${getToolkitConfigPath(agentDir ?? getAgentDir())} (${SECTION_LABEL})`;
}

/**
 * 按 spawn 时的同一规则解析逐档合并后的生效 tier 配置（含第 4 级本节点
 * 注入），供菜单展示与缺映射报错使用——与 spawn 共用工单 00 的单一读口。
 */
export function loadEffectiveTierConfig(options?: {
  readonly cwd?: string;
  readonly agentDir?: string;
}): TierConfigLoadResult {
  return loadTierRouteConfig({
    cwd: options?.cwd ?? process.cwd(),
    agentConfigDir: options?.agentDir ?? getAgentConfigDir(),
    injected: resolveHostTierSources(),
  });
}

/**
 * 某一档缺映射时的报错文案。走 routing.ts 的 resolveTierForParams，
 * 与真正 spawn 时抛出的字符串逐字一致（含"Add models.x to <path>"与
 * "No pi-subagents config was found (looked at …)"两条原文）。
 */
export function tierRouteError(tier: ModelTier, load: () => TierConfigLoadResult): string | undefined {
  const resolution = resolveTierForParams({ tier }, load);
  return "error" in resolution ? resolution.error : undefined;
}

function assertModelPool(tier: ModelTier, pool: readonly string[], source: string): void {
  const checked = parseTierConfig({ models: { [tier]: [...pool] } }, source);
  if ("error" in checked) throw new Error(checked.error);
}

/**
 * 写盘补丁语义（工单 23）：一档的默认思考等级。level 传 null 表示显式清除
 * （配置写 null 墓碑，深合并不会误删同对象其它档的取值）。写前按 spawn 时
 * 的同一严格规则校验，非法取值直接抛出（不产生写盘）。
 */
export function tierThinkingPatch(
  tier: ModelTier,
  level: ThinkingLevel | null,
  source: string,
): ModuleConfigRecord {
  const checked = parseTierConfig({ thinking: { [tier]: level } }, source);
  if ("error" in checked) throw new Error(checked.error);
  return { thinking: { [tier]: level } };
}

/**
 * 写盘补丁语义（工单 19 / 工单 21）：一档 tier 的完整有序候选池，首选在前。
 * 写前按 spawn 时的同一严格规则校验（含空候选池与无效模型标识），非法取值
 * 直接抛出（不产生写盘）。source 用于错误文案定位本节点（与 spawn 时的报错
 * 逐字一致）。
 */
export function tierPoolPatch(
  tier: ModelTier,
  pool: readonly string[],
  source: string,
): ModuleConfigRecord {
  assertModelPool(tier, pool, source);
  return { models: { [tier]: [...pool] } };
}

/** 写盘补丁语义（工单 19）：状态显示开关 */
export function statusEnabledPatch(enabled: boolean): ModuleConfigRecord {
  return { status: { enabled } };
}

/**
 * 写盘补丁语义（工单 05 显式接管）：把一档当前生效的候选池连同生效思考
 * 等级写进本节，让本节成为该档的声明层。thinking 传 undefined 表示任何
 * 层都没声明过该档思考等级（不写 thinking 键）；传 null 写显式清除墓碑；
 * 传具体等级原样写入。写前按 spawn 时的同一严格规则校验，非法取值直接
 * 抛出（不产生写盘）。
 */
export function tierTakeoverPatch(
  tier: ModelTier,
  pool: readonly string[],
  thinking: ThinkingLevel | null | undefined,
  source: string,
): ModuleConfigRecord {
  assertModelPool(tier, pool, source);
  if (thinking === undefined) return { models: { [tier]: [...pool] } };
  const checked = parseTierConfig({ thinking: { [tier]: thinking } }, source);
  if ("error" in checked) throw new Error(checked.error);
  return { models: { [tier]: [...pool] }, thinking: { [tier]: thinking } };
}
