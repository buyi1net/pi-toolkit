// 压缩模块的菜单行（工单 02）：schema 自动行（enabled / defaultMode / nativeTrigger /
// acpAutoDetect）之外的两行入口——
// - 模型规则：打开规则编辑器（结构化对象走模块自己的编辑页）；
// - 当前模型压缩策略：对当前会话模型跑一次策略解析，行值位显示实际模式，
//   回车进详情页看完整诊断（实际模式、来源、命中规则、contextWindow、协议、回退原因）。
//
// 诊断解析是纯函数调用（不读网络、不改 session）；行在菜单构建时求值一次。

import { getKeybindings, truncateToWidth, type Component, type SettingItem } from "@earendil-works/pi-tui";
import type { Translator } from "../../i18n/index.ts";
import type { MenuTheme } from "../../kit/menu/theme.ts";
import type { ModuleMenuContext } from "../../kit/module.ts";
import { AcpSettingsPanel, acpAdvancedRowValue } from "./acp-editor.ts";
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
import { resolveCompressionStrategy } from "./strategy.ts";

export const COMPRESSION_RULES_ROW_ID = "compression.rules";
export const COMPRESSION_DIAGNOSIS_ROW_ID = "compression.diagnosis";
export const COMPRESSION_ACP_ADVANCED_ROW_ID = "compression.acpAdvanced";

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
  const resolution = resolveCompressionStrategy(modelIdentityFromModel(model), settings);
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
 * ACP 高级设置入口行（工单 10）：值位显示覆盖概览，子菜单 = 结构化编辑页
 * （阈值/枚举走输入编辑器与有限枚举，复杂对象走分组子页；写入经 kit 事务）。
 */
function buildAcpAdvancedRow(context: ModuleMenuContext, theme: MenuTheme): SettingItem {
  const t = context.t;
  return {
    id: COMPRESSION_ACP_ADVANCED_ROW_ID,
    label: t("module.compression.acpAdvanced.label"),
    description: t("module.compression.acpAdvanced.description"),
    currentValue: acpAdvancedRowValue(context.getConfig(), t),
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
 * 模块在一级菜单的专属行（schema 自动行之后）：
 * 模型规则入口（子菜单 = 规则编辑器）、当前模型策略诊断入口与 ACP 高级设置入口。
 * 配置节有问题时，入口行描述位换成第一条问题文案——不进编辑器也能看见。
 */
export function buildCompressionMenuItems(context: ModuleMenuContext): readonly SettingItem[] {
  const t = context.t;
  const { settings, problems } = readCompressionSettings(context.getConfig());
  const firstProblem = problems[0];
  return [
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
    buildAcpAdvancedRow(context, context.theme),
    buildDiagnosisRow(context, context.theme),
  ];
}
