import { type SettingItem } from "@earendil-works/pi-tui";
import type { MenuTheme } from "../../kit/menu/theme.ts";
import type { ModuleMenuContext } from "../../kit/module.ts";
import { AcpSettingsPanel, acpManagementRowValue } from "./acp-editor.ts";
import { detectCodexCapability } from "./codex/capability.ts";
import { buildCodexManagementRow } from "./codex-settings-panel.ts";
import { readCompressionSettings } from "./config.ts";
import { formatCompressionProblem } from "./messages/index.ts";
import { CompressionRulesPanel, rulesCountValue } from "./rules-editor.ts";
import {
  COMPRESSION_SETTINGS_ROW_ID,
  CompressionSettingsPanel,
  compressionEnabledLabel,
} from "./settings-panel.ts";
import { sessionCompressionOverride } from "./session-override.ts";

function codexOverrideAvailable(context: ModuleMenuContext): boolean {
  const model = context.context.model;
  if (!model) return false;
  return detectCodexCapability({
    provider: model.provider,
    api: model.api,
    modelBaseUrl: model.baseUrl,
  }).capable;
}

export const COMPRESSION_RULES_ROW_ID = "compression.rules";

export const ROW_ACP_MANAGEMENT = "compression.acpManagement";

export function buildCompressionTopItems(context: ModuleMenuContext): readonly SettingItem[] {
  const t = context.t;
  return [
    {
      id: COMPRESSION_SETTINGS_ROW_ID,
      label: t("module.compression.label"),
      description: t("module.compression.settings.description"),
      currentValue: compressionEnabledLabel(context.getConfig(), t),
      submenu: (_currentValue: string, done: (value?: string) => void) =>
        new CompressionSettingsPanel({
          t,
          theme: context.theme,
          context: context.context,
          getSection: () => context.getConfig(),
          saveConfig: (patch, hooks) => context.saveConfig(patch, hooks),
          requestRender: () => context.requestRender(),
          codexManagementRow: () => buildCodexManagementRow(context),
          detailRows: () => buildCompressionMenuItems(context),
          codexOverrideAvailable: codexOverrideAvailable(context),

          readSessionOverride: () => sessionCompressionOverride.get(),
          writeSessionOverride: (next) => sessionCompressionOverride.set(next),
          onDone: (value) => done(value),
        }),
    },
  ];
}

function buildAcpManagementRow(context: ModuleMenuContext, theme: MenuTheme): SettingItem {
  const t = context.t;
  return {
    id: ROW_ACP_MANAGEMENT,
    label: t("module.compression.acpAdvanced.label"),
    description: t("module.compression.acpAdvanced.description"),
    currentValue: acpManagementRowValue(context.getConfig(), t),
    submenu: (_currentValue: string, done: (value?: string) => void) =>
      new AcpSettingsPanel({
        t,
        theme,
        context: context.context,
        saveConfig: (patch, hooks) => context.saveConfig(patch, hooks),
        requestRender: () => context.requestRender(),
        getSection: () => context.getConfig(),
        onDone: (value) => done(value),
      }),
  };
}

export function buildCompressionMenuItems(context: ModuleMenuContext): readonly SettingItem[] {
  const t = context.t;
  const { settings, problems } = readCompressionSettings(context.getConfig());
  const firstProblem = problems[0];
  return [
    buildAcpManagementRow(context, context.theme),
    {
      id: COMPRESSION_RULES_ROW_ID,
      label: t("module.compression.rules.label"),
      description: firstProblem
        ? formatCompressionProblem(firstProblem, t)
        : t("module.compression.rules.description"),
      currentValue: rulesCountValue(settings.modelRules.length, t),
      submenu: (_currentValue: string, done: (value: string) => void) =>
        new CompressionRulesPanel({
          t,
          theme: context.theme,
          context: context.context,
          saveConfig: (patch, hooks) => context.saveConfig(patch, hooks),
          requestRender: () => context.requestRender(),
          getSection: () => context.getConfig(),
          onDone: (value) => done(value),
        }),
    },
  ];
}
