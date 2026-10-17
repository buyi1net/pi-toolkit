// 压缩模块的菜单行。
//
// 一级菜单（工单 01）：只一行入口 `compression.settings`，值位只显示 开 / 关；回车打开
// 二级设置页 CompressionSettingsPanel（settings-panel.ts）。
//
// 二级页里的模块专属行（工单 07 定稿：排在规格行之后，不挤进 Codex → ACP 的相邻关系）：
// - ACP 管理页（工单 03 收编工单 10 的高级设置页）：预设切换 + 自动检测开关与
//   分流阈值，高级参数只在自定义进阶下展开。紧跟在 Codex 模式管理之后，正好是
//   规格最终行序的大、七两行；
// - 模型规则：打开规则编辑器（结构化对象走模块自己的编辑页）。显式规则三种模式都能
//   在这里增删改，是规则数据的编辑入口；Codex 管理页另提供从已认证模型向导式添加
//   codex 规则的做法，两边共用 modelRules 这一份真相，所以这一行不能并入 Codex 页；
// - 当前模型压缩策略：对当前会话模型跑一次策略解析，行值位显示实际模式，
//   回车进详情页看完整诊断（实际模式、来源、命中规则、contextWindow、协议、回退原因）。
//
// 诊断解析是纯函数调用（不读网络、不改 session）；行在菜单构建时求值一次。

import { getKeybindings, truncateToWidth, type Component, type SettingItem } from "@earendil-works/pi-tui";
import type { Translator } from "../../i18n/index.ts";
import type { MenuTheme } from "../../kit/menu/theme.ts";
import type { ModuleMenuContext } from "../../kit/module.ts";
import { AcpSettingsPanel, acpManagementRowValue } from "./acp-editor.ts";
import { buildCodexManagementRow } from "./codex-settings-panel.ts";
import { readCompressionSettings } from "./config.ts";
import {
  compressionModeLabel,
  compressionSourceLabel,
  formatCompressionProblem,
  formatResolutionDiagnosis,
  resolutionDiagnosisLines,
} from "./messages/index.ts";
import {
  CompressionRulesPanel,
  modelIdentityFromModel,
  rulesCountValue,
} from "./rules-editor.ts";
import {
  COMPRESSION_SETTINGS_ROW_ID,
  CompressionSettingsPanel,
  compressionEnabledLabel,
} from "./settings-panel.ts";
import { sessionCompressionOverride } from "./session-override.ts";
import { resolveCompressionStrategy } from "./strategy.ts";

export const COMPRESSION_RULES_ROW_ID = "compression.rules";
export const COMPRESSION_DIAGNOSIS_ROW_ID = "compression.diagnosis";
/** ACP 管理页在设置页的入口行 id（工单 03） */
export const ROW_ACP_MANAGEMENT = "compression.acpManagement";

/**
 * 模块在一级菜单的行（工单 01 的 topLevel 钩子）：唯一一行入口，值位只显示开 / 关。
 * 全部配置项和诊断都收进它打开的设置页，一级不再被生僻术语占位。
 */
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
          // 工单 05：会话覆盖是内存单例，面板读写的都是它（不经过配置事务）
          readSessionOverride: () => sessionCompressionOverride.get(),
          writeSessionOverride: (next) => sessionCompressionOverride.set(next),
          onDone: (value) => done(value),
        }),
    },
  ];
}

/** 诊断详情页：逐行展示策略解析的可读诊断，Esc 返回 */
class DiagnosisPanel implements Component {
  private readonly options: {
    readonly t: Translator;
    readonly theme: MenuTheme;
    readonly lines: readonly string[];
    readonly onClose: () => void;
  };

  constructor(options: DiagnosisPanel["options"]) {
    this.options = options;
  }

  render(width: number): string[] {
    const theme = this.options.theme;
    const lines = [truncateToWidth(theme.title(this.options.t("module.compression.diagnosis.title")), width), ""];
    for (const line of this.options.lines) {
      lines.push(truncateToWidth(line, width));
    }
    lines.push("", truncateToWidth(theme.hint(this.options.t("hint.back")), width));
    return lines;
  }

  invalidate(): void {
    // 纯展示组件，无需失效处理
  }

  handleInput(data: string): void {
    if (getKeybindings().matches(data, "tui.select.cancel")) {
      this.options.onClose();
    }
  }
}

/** 当前会话模型的解析结果行：值位 = 模式 · 来源；描述位 = 单行诊断；回车看全文 */
function buildDiagnosisRow(context: ModuleMenuContext, theme: MenuTheme): SettingItem {
  const t = context.t;
  const model = context.context.model;
  const label = t("module.compression.diagnosis.label");
  const description = t("module.compression.diagnosis.description");
  if (!model) {
    return {
      id: COMPRESSION_DIAGNOSIS_ROW_ID,
      label,
      description,
      currentValue: t("module.compression.diagnosis.noModel"),
    };
  }
  const { settings } = readCompressionSettings(context.getConfig());
  // 诊断与调度器、状态快照同源：会话覆盖也参与解析（工单 05）
  const resolution = resolveCompressionStrategy(
    modelIdentityFromModel(model),
    settings,
    sessionCompressionOverride.get(),
  );
  const short = `${compressionModeLabel(resolution.mode, t)} · ${compressionSourceLabel(resolution.source, t)}`;
  return {
    id: COMPRESSION_DIAGNOSIS_ROW_ID,
    label,
    description: formatResolutionDiagnosis(resolution, t),
    currentValue: short,
    submenu: (_currentValue: string, done: (value?: string) => void) =>
      new DiagnosisPanel({
        t,
        theme,
        lines: resolutionDiagnosisLines(resolution, t),
        onClose: () => done(short),
      }),
  };
}

/**
 * ACP 管理页入口行（工单 03，收编工单 10 的 ACP 高级设置行）：值位显示预设档位与
 * 自动检测状态；子菜单 = ACP 管理页（预设切换 + 自动检测开关 + 阈值，高级参数只在
 * 自定义进阶下展开）。
 */
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

/**
 * 设置页里的模块专属行（规格最终行序之后的工具行）：
 * ACP 管理页入口（紧跟 Codex 管理页，凑齐规格的第五、六行）、模型规则编辑器入口
 * （显式规则的编辑入口，三值模式都在这里建）与当前模型策略诊断入口（只读诊断，层级
 * 固定在设置页这一层，不再上一级）。Codex 模式管理的入口行不在这里：它由 settings-panel 的
 * 专属插槽排在 ACP 管理页之前（工单 02）。配置节有问题时，入口行描述位换成第一条
 * 问题文案——不进编辑器也能看见。
 */
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
    buildDiagnosisRow(context, context.theme),
  ];
}
