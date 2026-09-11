// 子代理模块的配置落点：pi-toolkit.json 的 `modules.subagents` 节。
//
// 归一裁决（工单 04）：tier 模型路由（`models.fast` / `models.balanced` /
// `models.deep`）与状态显示开关（`status.enabled`）的菜单读写都落这一节；
// 原 pi-subagents 包内 config.json 的 status.enabled 只作兜底默认。
//
// tier 解析保留覆盖优先级链，共六级（外部显式配置优先，包内文件兜底）：
//   1. env PI_SUBAGENTS_CONFIG
//   2. 项目 <cwd>/.pi/agent/pi-subagents.json
//   3. 全局 <agentDir>/pi-subagents.json
//   4. pi-toolkit.json 的 modules.subagents 节（本文件负责读写）
//   5. 模块目录 config.json
//   6. 模块目录 config.json.example
// 第 4 级只在真的声明了 models 对象时参与（否则让链继续落到包内兜底）；
// 候选链的拼接在 src/routing.ts，本文件只负责本节的读写与校验。

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getToolkitConfigPath, saveToolkitConfig } from "../../config.ts";
import {
  MODEL_TIERS,
  normalizeTier,
  parseTierConfig,
  resolveTierForParams,
  loadTierRouteConfig,
  type ModelTier,
  type TierConfigLoadResult,
} from "./src/routing.ts";
import { getAgentConfigDir, resolveHostTierSources } from "./src/index.ts";

/** 模块 id：同时是配置节名与菜单项 id 前缀 */
export const SUBAGENTS_MODULE_ID = "subagents";

export { MODEL_TIERS, normalizeTier };
export type { ModelTier, TierConfigLoadResult };

export type TierMapping = Partial<Record<ModelTier, string>>;

export interface SubagentsSectionView {
  /** 已校验的 tier 映射；非法项被丢弃并记录在 problems 里 */
  readonly tier: TierMapping;
  /** `status.enabled`；未声明时为 undefined（落回包内 config.json 的兜底默认） */
  readonly statusEnabled: boolean | undefined;
  readonly problems: readonly string[];
}

const SECTION_LABEL = `modules.${SUBAGENTS_MODULE_ID}`;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 读 `modules.subagents` 节。校验直接复用 src/routing.ts 的 parseTierConfig，
 * 保证菜单里看到的判定与 spawn 时的判定完全一致（同一份严格规则）。
 */
export function readSubagentsSection(section: Record<string, unknown>): SubagentsSectionView {
  const problems: string[] = [];

  const tier: TierMapping = {};
  const rawModels = section.models;
  if (rawModels !== undefined) {
    const parsed = parseTierConfig({ models: rawModels }, SECTION_LABEL);
    if ("error" in parsed) problems.push(parsed.error);
    else Object.assign(tier, parsed.config.models);
  }

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

  return { tier, statusEnabled, problems };
}

/**
 * 本节点路径。菜单写盘与错误提示定位共用它——spawn 时的同一级来源也指向这里。
 */
export function subagentsSectionPath(agentDir?: string): string {
  return `${getToolkitConfigPath(agentDir ?? getAgentDir())} (${SECTION_LABEL})`;
}

/**
 * 按 spawn 时的同一规则解析生效的 tier 配置（含第 4 级本节点注入），
 * 供菜单展示与缺映射报错使用。
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
 * 某一档缺映射时的报错文案。走 src/routing.ts 的 resolveTierForParams，
 * 与真正 spawn 时抛出的字符串逐字一致（含"Add models.x to <path>"与
 * "No pi-subagents config was found (looked at …)"两条原文）。
 */
export function tierRouteError(tier: ModelTier, load: () => TierConfigLoadResult): string | undefined {
  const resolution = resolveTierForParams({ tier }, load);
  return "error" in resolution ? resolution.error : undefined;
}

function assertModelValue(tier: ModelTier, model: string, source: string): void {
  const checked = parseTierConfig({ models: { [tier]: model } }, source);
  if ("error" in checked) throw new Error(checked.error);
}

export interface SubagentsWriteOptions {
  readonly agentDir?: string;
}

/** 写一档 tier 的模型映射到本节点 */
export async function saveTierModel(
  tier: ModelTier,
  model: string,
  options: SubagentsWriteOptions = {},
): Promise<void> {
  const path = getToolkitConfigPath(options.agentDir ?? getAgentDir());
  assertModelValue(tier, model, path);
  await saveToolkitConfig(path, {
    modules: { [SUBAGENTS_MODULE_ID]: { models: { [tier]: model } } },
  });
}

/** 写状态显示开关到本节点 */
export async function saveStatusEnabled(
  enabled: boolean,
  options: SubagentsWriteOptions = {},
): Promise<void> {
  const path = getToolkitConfigPath(options.agentDir ?? getAgentDir());
  await saveToolkitConfig(path, {
    modules: { [SUBAGENTS_MODULE_ID]: { status: { enabled } } },
  });
}
