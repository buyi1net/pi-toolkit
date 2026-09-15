// 子代理菜单（工单 46 一级化 + 工单 47 候选池编辑器）：一级三行——模块开关
// （subagents.enabled，走统一改动入口）、运行状态显示（modules.subagents.status.enabled，
// 一级直接开关）与「模型与候选池」入口；入口行打开候选池编辑器（pool-editor.ts
// 的 SubagentsPanel，工单 47 方案 C）：每档一个分区，头行显示档位名与该档默认
// 思考等级（←→ 调整），下面是候选模型行（Enter 换模型、Shift+↑↓ 排序、Ctrl+D
// 待删 → Enter 确认删除）与「＋ 添加模型」行（Enter 追加候选）。
//
// 档位显示名与固定排序（工单 22）：设置界面按 旗舰模型 → 均衡模型 → 快速模型
// 从高到低显示；内部键 deep/balanced/fast 不改名（与配置、工具参数和报错原文
// 兼容），显示名走 i18n 三语键（module.subagents.tier.name.*）。
//
// 写盘落点（工单 04 归一裁决）全在 pi-toolkit.json 的 `modules.subagents` 节；
// tier 解析仍是六级覆盖链，编辑器只写第 4 级（每次改动立即落盘，读侧回读盘上
// 真相）。缺映射或本节配置非法时，原版报错文案摆在一级入口行的描述里，不进
// 编辑器也能看见（与 spawn 时抛出的字符串逐字一致）。思考等级（工单 23）只写
// 档位默认：spawn 时的覆盖优先级（任务显式 > 代理 frontmatter > 档位默认）在
// 启动事务里裁决，不在这里。

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SettingItem } from "@earendil-works/pi-tui";
import type { Translator } from "../../i18n/index.ts";
import type { ConfigWriteHooks } from "../../kit/config-transaction.ts";
import { schemaFieldRow } from "../../kit/menu/items.ts";
import { SettingsPanel } from "../../kit/menu/panels.ts";
import type { MenuTheme } from "../../kit/menu/theme.ts";
import {
  enabledField,
  normalizeConfigValue,
  type ModuleConfigRecord,
  type ModuleMenuContext,
  type RowChangeEntry,
} from "../../kit/module.ts";
import {
  loadEffectiveTierConfig,
  statusEnabledPatch,
  tierRouteError,
  type TierConfigLoadResult,
  type TierMapping,
} from "./config.ts";
import { loadStatusConfig } from "./status.ts";
import {
  type PoolEditorRow,
  type SaveOutcome,
  type SubagentsPanelOptions,
  type SubagentsPanelState,
  type TierCandidate,
  type TierMenuRegistry,
  SubagentsPanel,
  TIER_DISPLAY_ORDER,
  buildPoolEditorRows,
  configuredCountValue,
  discoverTierCandidates,
  poolAfterMove,
  poolEditorRowId,
  poolEditorRowIds,
  nextThinkingLevel,
  readPanelState,
  saveTierPool,
  saveTierThinking,
  tierCandidateValue,
  tierDisplayName,
  tierNameKey,
  tierThinkingRowValue,
} from "./pool-editor.ts";

// 编辑器与面板纯逻辑在 pool-editor.ts（组件自绘，工单 47）；这里 re-export 维持
// 菜单侧（harness / 一级装配）从 menu.ts 取物的既有口径。
export {
  type PoolEditorRow,
  type SaveOutcome,
  type SubagentsPanelOptions,
  type SubagentsPanelState,
  type TierCandidate,
  type TierMenuRegistry,
  SubagentsPanel,
  TIER_DISPLAY_ORDER,
  buildPoolEditorRows,
  configuredCountValue,
  discoverTierCandidates,
  poolAfterMove,
  poolEditorRowId,
  poolEditorRowIds,
  nextThinkingLevel,
  readPanelState,
  saveTierPool,
  saveTierThinking,
  tierCandidateValue,
  tierDisplayName,
  tierNameKey,
  tierThinkingRowValue,
} from "./pool-editor.ts";

/**
 * 包内 config.json（→ config.json.example）的 status.enabled：
 * 本节点未声明时的兜底默认。读不出来时按开启处理（与 example 一致）。
 */
export function readPackageStatusEnabled(): boolean {
  try {
    return loadStatusConfig().enabled;
  } catch {
    return true;
  }
}

/** 一级「模型编排」入口行 id（打开模块开关 / 运行状态显示 / 候选池的设置页） */
export const SUBAGENTS_MENU_ITEM_ID = "subagents.settings";

/** 页内「模型与候选池」入口行 id（打开候选池编辑器） */
export const SUBAGENTS_POOL_ROW_ID = "subagents.pool";

/** 一级「运行状态显示」行 id（非 schema 字段，保存走本模块的配置事务） */
export const SUBAGENTS_STATUS_ROW_ID = "subagents.status";

/** 模块开关字段（工单 46）：一级开关行与 schema 同源 */
export const SUBAGENTS_ENABLED_FIELD = enabledField(
  "module.subagents.enabled.label",
  "module.subagents.enabled.description",
);

/**
 * 按显示顺序（旗舰 → 均衡 → 快速）第一个缺映射档的原版报错文案。取 routing.ts
 * 的 resolveTierForParams 输出，与真正 spawn 时抛出的字符串逐字一致；三档都
 * 配齐时返回 undefined。
 */
export function firstTierProblem(
  mapping: TierMapping,
  load: () => TierConfigLoadResult,
): string | undefined {
  for (const tier of TIER_DISPLAY_ORDER) {
    if (mapping[tier]) continue;
    const error = tierRouteError(tier, load);
    if (error) return error;
  }
  return undefined;
}

/** 状态显示开关的显示值：本节点未声明时展示包内兜底默认 */
export function statusRowValue(
  state: SubagentsPanelState,
  fallbackEnabled: boolean,
  t: Translator,
): string {
  const enabled = state.statusEnabled ?? fallbackEnabled;
  return enabled ? t("common.on") : t("common.off");
}

/** 状态开关行的保存依赖（一级状态行与回归 harness 共用） */
interface StatusSaveOptions {
  readonly saveConfig: (patch: ModuleConfigRecord, hooks?: ConfigWriteHooks) => Promise<void>;
}

/** 写状态显示开关：补丁语义在本模块，落盘与重载走配置写入事务 */
export async function saveStatus(
  options: StatusSaveOptions,
  enabled: boolean,
): Promise<SaveOutcome> {
  try {
    await options.saveConfig(statusEnabledPatch(enabled));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 运行状态显示行（本单起为就地切换）：值位即当前开关，回车/空格直接切；
 * 写盘走本模块的配置事务，失败提示并把显示回滚（菜单层按 read 回读）。
 * 本节点未声明时展示包内兜底默认。
 */
function subagentsStatusRow(options: {
  readonly t: Translator;
  readonly context: ExtensionContext;
  readonly getSection: () => Record<string, unknown>;
  readonly saveConfig: (patch: ModuleConfigRecord, hooks?: ConfigWriteHooks) => Promise<void>;
  readonly requestRender: () => void;
  readonly registerRowChange: (id: string, entry: RowChangeEntry) => void;
  readonly packageStatusEnabled: boolean;
}): SettingItem {
  const t = options.t;
  const label = t("module.subagents.status.label");
  const read = () =>
    statusRowValue(readPanelState(options.getSection()), options.packageStatusEnabled, t);
  options.registerRowChange(SUBAGENTS_STATUS_ROW_ID, {
    read,
    change: async (value) => {
      const outcome = await saveStatus(options, value === t("common.on"));
      if (!outcome.ok) {
        options.context.ui.notify(t("notify.saveFailed", { reason: outcome.error ?? "" }), "error");
      }
      options.requestRender();
      return outcome.ok;
    },
  });
  return {
    id: SUBAGENTS_STATUS_ROW_ID,
    label,
    description: t("module.subagents.status.description"),
    currentValue: read(),
    values: [t("common.on"), t("common.off")],
  };
}

/**
 * 顶层行（本单起）：模块开关、运行状态显示与模型候选池合并为一个「模型编排」入口，
 * 值位显示模块总开关的已开启/已关闭；页内三行保持原名（二级菜单统一编排另行处理）。
 */
export function buildSubagentsTopLevel(context: ModuleMenuContext): readonly SettingItem[] {
  const t = context.t;
  const section = context.getConfig();
  const state = readPanelState(section);
  const load = () =>
    loadEffectiveTierConfig({ cwd: context.context.cwd, agentDir: context.agentDir });
  // 缺映射（或本节点配置非法）时把原版报错摆在池入口行的描述里，不进编辑器也能看见
  const problem = firstTierProblem(state.mapping, load) ?? state.problems[0];

  const enabledText = () => {
    const current = normalizeConfigValue(SUBAGENTS_ENABLED_FIELD, context.getConfig()["enabled"]);
    return (current ?? SUBAGENTS_ENABLED_FIELD.default) === true
      ? t("module.subagents.entry.on")
      : t("module.subagents.entry.off");
  };

  const pageItems: SettingItem[] = [
    schemaFieldRow({
      t,
      id: "subagents.enabled",
      field: SUBAGENTS_ENABLED_FIELD,
      current: section["enabled"],
    }),
    subagentsStatusRow({
      t,
      context: context.context,
      getSection: () => context.getConfig(),
      saveConfig: (patch, hooks) => context.saveConfig(patch, hooks),
      requestRender: () => context.requestRender(),
      registerRowChange: (id, entry) => context.registerRowChange(id, entry),
      packageStatusEnabled: readPackageStatusEnabled(),
    }),
    {
      id: SUBAGENTS_POOL_ROW_ID,
      label: t("module.subagents.menu.label"),
      description: problem ?? t("module.subagents.menu.description"),
      currentValue: configuredCountValue(state.mapping, t),
      submenu: (_currentValue, done) =>
        new SubagentsPanel({
          t,
          theme: context.theme,
          context: context.context,
          agentDir: context.agentDir,
          saveConfig: (patch, hooks) => context.saveConfig(patch, hooks),
          requestRender: () => context.requestRender(),
          getSection: () => context.getConfig(),
          onDone: (value) => done(value),
        }),
    },
  ];

  return [
    {
      id: SUBAGENTS_MENU_ITEM_ID,
      label: t("module.subagents.entry.label"),
      description: t("module.subagents.entry.description"),
      currentValue: enabledText(),
      submenu: (_currentValue, done) =>
        new SettingsPanel({
          items: pageItems,
          theme: context.theme,
          t,
          onChange: context.onChange,
          onClose: () => done(enabledText()),
        }),
    },
  ];
}
