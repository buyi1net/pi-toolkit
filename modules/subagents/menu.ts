// 子代理菜单（工单 46 一级化 + 工单 47 候选池编辑器）：一级三行——模块开关、
// 运行状态显示与「模型与候选池」入口；入口行打开候选池编辑器。模型池只维护
// 候选模型与分组，不保存档位默认思考等级。
//
// 档位显示名与固定排序（工单 22）：设置界面按 旗舰模型 → 均衡模型 → 快速模型
// 从高到低显示；内部键 flagship/balanced/fast 不改名（与配置、工具参数和报错
// 原文兼容；deep/quick 等旧名只剩别名），显示名走 i18n 三语键
// （module.subagents.tier.name.*）。
//
// 写盘落点（工单 04 归一裁决）全在 pi-toolkit.json 的 `modules.subagents` 节；
// tier 解析是六级逐档合并链（工单 00），编辑器只写第 4 级（每次改动立即落
// 盘，读侧回读盘上真相）。入口行读工单 00 的单一读口（逐档生效值 + 生效
// 层来源 + 配置问题清单）：计数与缺档判断看逐档合并后的生效值，不再只看
// 本地节——本地配了却被更高层旧文件占档、或本地非法落低层，都能从问题清
// 单与生效层来源里看出来（与 spawn 读同一份）。思考等级（工单 23）只写
// 档位默认：spawn 时的覆盖优先级（任务显式 > 代理 frontmatter > 档位默认）
// 在启动事务里裁决，不在这里。

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SettingItem } from "@earendil-works/pi-tui";
import type { Translator } from "../../i18n/index.ts";
import { schemaFieldRow } from "../../kit/menu/items.ts";
import { ChoicePicker, SettingsPanel } from "../../kit/menu/panels.ts";
import type { MenuTheme } from "../../kit/menu/theme.ts";
import {
  enabledField,
  normalizeConfigValue,
  type ModuleConfigRecord,
  type ModuleMenuContext,
} from "../../kit/module.ts";
import {
  displayModePatch,
  readDisplayModeConfig,
  resolveDisplayMode,
  type DisplayContext,
  type DisplayMode,
} from "./config.ts";
import { detectDisplayContext, detectDisplayModeAvailability } from "./surface.ts";
import {
  effectiveTierMapping,
  loadEffectiveTierConfig,
  MODEL_TIERS,
  subagentsSectionPath,
  tierRouteError,
  type EffectiveTierRouteConfig,
  type TierConfigLoadResult,
  type TierMapping,
} from "./config.ts";
import {
  type EffectivePanelView,
  type PoolEditorRow,
  type SaveOutcome,
  type SubagentsPanelOptions,
  type SubagentsPanelState,
  type TierCandidate,
  type TierEditorView,
  type TierMenuRegistry,
  type TierPoolOwnership,
  SubagentsPanel,
  TIER_DISPLAY_ORDER,
  buildEffectivePanelView,
  buildPoolEditorRows,
  configuredCountValue,
  discoverTierCandidates,
  effectiveMappingFromView,
  poolAfterMove,
  poolEditorRowId,
  poolEditorRowIds,
  readPanelState,
  saveTierPool,
  tierCandidateValue,
  tierDisplayName,
  tierForeignEffective,
  tierNameKey,
  tierPoolEditable,
} from "./pool-editor.ts";

// 编辑器与面板纯逻辑在 pool-editor.ts（组件自绘，工单 47）；这里 re-export 维持
// 菜单侧（harness / 一级装配）从 menu.ts 取物的既有口径。
export {
  type EffectivePanelView,
  type PoolEditorRow,
  type SaveOutcome,
  type SubagentsPanelOptions,
  type SubagentsPanelState,
  type TierCandidate,
  type TierEditorView,
  type TierMenuRegistry,
  type TierPoolOwnership,
  SubagentsPanel,
  TIER_DISPLAY_ORDER,
  buildEffectivePanelView,
  buildPoolEditorRows,
  configuredCountValue,
  discoverTierCandidates,
  effectiveMappingFromView,
  poolAfterMove,
  poolEditorRowId,
  poolEditorRowIds,
  readPanelState,
  saveTierPool,
  tierCandidateValue,
  tierDisplayName,
  tierForeignEffective,
  tierNameKey,
  tierPoolEditable,
} from "./pool-editor.ts";

export const SUBAGENTS_DISPLAY_MODE_ROW_ID = "subagents.displayMode";

export interface DisplayModeMenuState {
  readonly context: DisplayContext;
  readonly current: DisplayMode;
  readonly options: readonly {
    readonly mode: DisplayMode;
    readonly available: boolean;
    readonly reason: string | null;
  }[];
}

/** 菜单读口：始终返回三种模式，缺环境/CLI 的项保留并标为不可用。 */
export function displayModeMenuState(section: Record<string, unknown>): DisplayModeMenuState {
  const context = detectDisplayContext();
  const config = readDisplayModeConfig(section);
  return {
    context,
    current: resolveDisplayMode({ context, config }),
    options: detectDisplayModeAvailability(),
  };
}

/** 不可用模式不隐藏；调用方在保存前拒绝，避免菜单选择静默回退。 */
export function isDisplayModeSelectable(state: DisplayModeMenuState, mode: DisplayMode): boolean {
  return state.options.find((option) => option.mode === mode)?.available === true;
}

export const SUBAGENTS_MENU_ITEM_ID = "subagents.settings";

/** 页内「模型与候选池」入口行 id（打开候选池编辑器） */
export const SUBAGENTS_POOL_ROW_ID = "subagents.pool";

/** 模块开关字段（工单 46）：一级开关行与 schema 同源 */
export const SUBAGENTS_ENABLED_FIELD = enabledField(
  "module.subagents.enabled.label",
  "module.subagents.enabled.description",
);

/**
 * 按显示顺序（旗舰 → 均衡 → 快速）第一个缺映射档的原版报错文案。按工单
 * 00 的单一读口看逐档合并后的生效档（不再只看本地节）；取 routing.ts 的
 * resolveTierForParams 输出，与真正 spawn 时的判定同源；三档都在生效链上
 * 配齐时返回 undefined。
 */
export function firstTierProblem(
  effective: EffectiveTierRouteConfig,
  load: () => TierConfigLoadResult,
): string | undefined {
  for (const tier of TIER_DISPLAY_ORDER) {
    if (effective.tiers[tier].pool) continue;
    const error = tierRouteError(tier, load);
    if (error) return error;
  }
  return undefined;
}

/**
 * 池入口行的描述文案（工单 05）：配置问题永远优先（先是单一读口问题清单里
 * 的链上问题，再回退本节非路由问题如 status），没有问题才明示外层生效档
 * （本层不是最终生效层），都无则用默认描述。菜单与编辑器从此说同一件事：
 * 显示的就是 spawn 生效的。
 */
export function poolEntryDescription(
  effective: TierConfigLoadResult,
  localSource: string,
  state: SubagentsPanelState,
  t: Translator,
): string {
  const problem =
    (effective.config ? firstTierProblem(effective.config, () => effective) : effective.error) ??
    effective.config?.problems[0] ??
    state.problems[0];
  if (problem) return problem;
  const view: EffectivePanelView | null = effective.config
    ? buildEffectivePanelView({ effective, localSource })
    : null;
  const foreignCount = view
    ? MODEL_TIERS.filter((tier) => tierForeignEffective(view, tier)).length
    : 0;
  if (foreignCount > 0) return t("module.subagents.menu.foreignTiers", { count: foreignCount });
  return t("module.subagents.menu.description");
}

export function displayModeRow(options: {
  readonly t: Translator;
  readonly theme: MenuTheme;
  readonly context: ModuleMenuContext;
}): SettingItem {
  const state = displayModeMenuState(options.context.getConfig());
  const modeLabel = (mode: DisplayMode) => options.t(`module.subagents.display.${mode}` as any);
  const contextLabel = options.t(`module.subagents.display.context.${state.context}` as any);
  const preferenceLabel = modeLabel(state.current);
  return {
    id: SUBAGENTS_DISPLAY_MODE_ROW_ID,
    label: options.t("module.subagents.display.label"),
    description: options.t("module.subagents.display.description", { context: contextLabel, preference: preferenceLabel }),
    currentValue: preferenceLabel,
    submenu: (_currentValue, done) => new ChoicePicker({
      title: options.t("module.subagents.display.title"),
      theme: options.theme,
      t: options.t,
      options: state.options.map((item) => ({
        value: item.mode,
        label: item.available ? modeLabel(item.mode) : options.t("module.subagents.display.unavailable", { mode: modeLabel(item.mode) }),
        description: item.available ? undefined : options.t("module.subagents.display.unavailableReason", { mode: modeLabel(item.mode) }),
      })),
      onSelect: (value) => {
        const mode = value as DisplayMode;
        if (!isDisplayModeSelectable(state, mode)) {
          options.context.context.ui.notify(options.t("module.subagents.display.unavailableReason", { mode: modeLabel(mode) }), "warning");
          return;
        }
        void options.context.saveConfig(displayModePatch(mode, state.context), { reapply: () => undefined })
          .then(() => done(mode))
          .catch((error) => options.context.context.ui.notify(String(error), "error"));
      },
      onCancel: () => done(state.current),
    }),
  };
}
/**
 * 「模型编排」页内四行：模块开关、显示模式、运行状态显示、模型与候选池入口。
 * 单独导出供测试与二级页装配直取（与视觉模块 buildVisionMenuItems 同口径）。
 */
export function buildSubagentsPageItems(context: ModuleMenuContext): readonly SettingItem[] {
  const t = context.t;
  const section = context.getConfig();
  const state = readPanelState(section);
  const load = () =>
    loadEffectiveTierConfig({ cwd: context.context.cwd, agentDir: context.agentDir });
  // 单一读口（工单 00）：计数与缺档判断看逐档合并后的生效值，问题清单优先
  // 展示链上各层逐档问题（本节 status 等非路由问题作次级回退）；本层不是
  // 最终生效层时明示外层生效档数（工单 05）。
  const effective = load();
  const effectiveMapping: TierMapping = effective.config ? effectiveTierMapping(effective.config) : {};
  const description = poolEntryDescription(
    effective,
    subagentsSectionPath(context.agentDir),
    state,
    t,
  );

  return [
    schemaFieldRow({
      t,
      id: "subagents.enabled",
      field: SUBAGENTS_ENABLED_FIELD,
      current: section["enabled"],
    }),
    displayModeRow({ t, theme: context.theme, context }),
    {
      id: SUBAGENTS_POOL_ROW_ID,
      label: t("module.subagents.menu.label"),
      description,
      currentValue: configuredCountValue(effectiveMapping, t),
      submenu: (_currentValue, done) =>
        new SubagentsPanel({
          t,
          theme: context.theme,
          context: context.context,
          agentDir: context.agentDir,
          saveConfig: (patch, hooks) => context.saveConfig(patch, hooks),
          requestRender: () => context.requestRender(),
          getSection: () => context.getConfig(),
          loadEffective: load,
          onDone: (value) => done(value),
        }),
    },
  ];
}

/**
 * 顶层行（本单起）：模块开关、运行状态显示与模型候选池合并为一个「模型编排」入口，
 * 值位显示模块总开关的已开启/已关闭；页内三行保持原名（二级菜单统一编排另行处理）。
 */
export function buildSubagentsTopLevel(context: ModuleMenuContext): readonly SettingItem[] {
  const t = context.t;
  const enabledText = () => {
    const current = normalizeConfigValue(SUBAGENTS_ENABLED_FIELD, context.getConfig()["enabled"]);
    return (current ?? SUBAGENTS_ENABLED_FIELD.default) === true
      ? t("module.subagents.entry.on")
      : t("module.subagents.entry.off");
  };

  const pageItems: readonly SettingItem[] = buildSubagentsPageItems(context);

  return [
    {
      id: SUBAGENTS_MENU_ITEM_ID,
      label: t("module.subagents.entry.label"),
      description: t("module.subagents.entry.description"),
      currentValue: enabledText(),
      submenu: (_currentValue, done) =>
        new SettingsPanel({
          items: [...pageItems],
          theme: context.theme,
          t,
          onChange: context.onChange,
          onClose: () => done(enabledText()),
        }),
    },
  ];
}
