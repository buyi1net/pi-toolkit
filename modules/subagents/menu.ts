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

export function displayModeMenuState(section: Record<string, unknown>): DisplayModeMenuState {
  const context = detectDisplayContext();
  const config = readDisplayModeConfig(section);
  return {
    context,
    current: resolveDisplayMode({ context, config }),
    options: detectDisplayModeAvailability(),
  };
}

export function isDisplayModeSelectable(state: DisplayModeMenuState, mode: DisplayMode): boolean {
  return state.options.find((option) => option.mode === mode)?.available === true;
}

export const SUBAGENTS_MENU_ITEM_ID = "subagents.settings";

export const SUBAGENTS_POOL_ROW_ID = "subagents.pool";

export const SUBAGENTS_ENABLED_FIELD = enabledField(
  "module.subagents.enabled.label",
  "module.subagents.enabled.description",
);

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

export function buildSubagentsPageItems(context: ModuleMenuContext): readonly SettingItem[] {
  const t = context.t;
  const section = context.getConfig();
  const state = readPanelState(section);
  const load = () =>
    loadEffectiveTierConfig({ cwd: context.context.cwd, agentDir: context.agentDir });

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
