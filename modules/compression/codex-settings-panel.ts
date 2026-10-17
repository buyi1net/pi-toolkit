// Codex 模式管理页（工单 02）：设置页里的 ROW_CODEX_MANAGEMENT 打开它。
//
// 页内三块（规格「Codex 模式专有化与向导式管理」）：
// - codexAutoDetect 开关：schema 同源的布尔行，就地切换后先写盘、成功才重建行集
//   （与设置页总开关同一条写盘时序，失败回滚显示并提示）；
// - 受支持模型列表：modelRules 里 mode=codex 的规则，值位是模式 · 协议，描述位是
//   规则的完整身份（api / baseUrl），多中转站下同名模型不会看着一样；
// - 「添加模型」：从 ModelRegistry.getAvailable()（用户已配置且认证可用）里勾选，
//   写入完整身份 provider / model / api / baseUrl，防止多镜像之间串规则。
//
// 空列表与探测器失败都不静默：没有任何已认证可用模型时给出原因与下一步；取不到
// 认证信息时不落盘并说明要先修凭据；非官方链路（中转站 / 自定义路径）照常添加，
// 但选择器逐条标出「不会自动检测」的原因——显式规则仍然是用户的正当手段。
//
// 选模型的既有能力直接复用 rules-editor.ts（discoverCompressionCandidates /
// ruleRowValue），写盘走 kit 配置事务（modelRulesPatch 写前校验）。

import {
  getKeybindings,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
  type SettingItem,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Translator } from "../../i18n/index.ts";
import type { ConfigWriteHooks } from "../../kit/config-transaction.ts";
import { fieldDisplayValue, fieldValueFromLabel, schemaFieldRow } from "../../kit/menu/items.ts";
import { ChoicePicker } from "../../kit/menu/panels.ts";
import { I18nSettingsList } from "../../kit/menu/settings-list.ts";
import type { MenuTheme } from "../../kit/menu/theme.ts";
import {
  normalizeConfigValue,
  type ConfigField,
  type ModuleConfigRecord,
  type ModuleMenuContext,
} from "../../kit/module.ts";
import {
  DEFAULT_CODEX_AUTO_DETECT_ENABLED,
  type CompressionModelRule,
  type CompressionSettings,
} from "./api.ts";
import {
  detectCodexCapability,
  readModelCodexCapability,
  type CodexCapability,
  type CodexCapabilityModel,
} from "./codex/capability.ts";
import { modelRulesPatch, readCompressionSettings } from "./config.ts";
import { formatCompressionProblem } from "./messages/index.ts";
import {
  discoverCompressionCandidates,
  ruleRowValue,
  type CompressionModelCandidate,
} from "./rules-editor.ts";
import { normalizeCompressionToken } from "./strategy.ts";

/** 设置页里的入口行 id（由 buildCompressionSettingsRows 插在模块专属行之前） */
export const ROW_CODEX_MANAGEMENT = "compression.codexManagement";
/** 页内的自动检测开关行 id（与 schema 字段同 id：落盘与显示回滚走同一条链） */
export const ROW_CODEX_AUTO_DETECT = "compression.codexAutoDetect";
/** 页内的「添加模型」行 id */
export const ROW_CODEX_ADD = "compression.codex.add";
/** 页内空列表说明行 id（纯展示行，不响应回车） */
export const ROW_CODEX_EMPTY = "compression.codex.empty";

const MAX_VISIBLE = 10;

/**
 * 自动检测开关字段：压缩模块 schema 与本页共用这一份定义（index.ts 的 configSchema
 * 直接引用它），行显示与 kit 的落盘规范化因此始终同源。
 */
export const CODEX_AUTO_DETECT_FIELD: ConfigField = {
  default: DEFAULT_CODEX_AUTO_DETECT_ENABLED,
  labelKey: "module.compression.codex.autoDetect.label",
  descriptionKey: "module.compression.codex.autoDetect.description",
};

/** 页内已添加模型的行 id（下标按 mode=codex 过滤后的顺序） */
export function codexRuleRowId(index: number): string {
  return `compression.codex.rule.${index}`;
}

/** Codex 规则（受支持模型列表的唯一数据真相：modelRules 里 mode=codex 的条目） */
export function codexRules(settings: CompressionSettings): readonly CompressionModelRule[] {
  return settings.modelRules.filter((rule) => rule.mode === "codex");
}

/** 入口行的值位：已添加规则数 + 自动检测状态 */
export function codexManagementValue(section: ModuleConfigRecord, t: Translator): string {
  const { settings } = readCompressionSettings(section);
  return t(settings.codexAutoDetect ? "module.compression.codexManagement.value.autoOn" : "module.compression.codexManagement.value.autoOff", {
    count: codexRules(settings).length,
  });
}

/** 能力判定结果的显示文案：原因文案 + 判定细节（实际 host / path / 原值） */
export function codexCapabilityLabel(capability: CodexCapability, t: Translator): string {
  const label = t(`module.compression.codex.capability.${capability.reason}`);
  return capability.detail === undefined || capability.detail === "" ? label : `${label} · ${capability.detail}`;
}

/** 规则的完整身份描述（api · baseUrl）：规则列表里区分同名模型的不同中转站 */
function ruleIdentityText(rule: CompressionModelRule): string | undefined {
  const parts = [rule.api, rule.baseUrl].filter((part): part is string => part !== undefined && part !== "");
  return parts.length === 0 ? undefined : parts.join(" · ");
}

/**
 * 候选模型的 Codex 规则（完整身份）：provider / model 必带，api 与 baseUrl 来自
 * 模型目录（目录没有声明的可选字段不落空键）。显式规则是用户的正当手段，不因
 * 探测器判否而拒绝写入——判定只影响自动检测与提示文案。
 */
export function codexRuleFromCandidate(candidate: CompressionModelCandidate): CompressionModelRule {
  return {
    provider: candidate.provider,
    model: candidate.modelId,
    ...(candidate.api === undefined || candidate.api === "" ? {} : { api: candidate.api }),
    ...(candidate.baseUrl === undefined || candidate.baseUrl === "" ? {} : { baseUrl: candidate.baseUrl }),
    mode: "codex",
  };
}

/** 该候选是否已有 codex 规则（只比 provider/model：带约束的旧规则同样算重复，避免同名两条） */
function hasCodexRule(
  rules: readonly CompressionModelRule[],
  candidate: CompressionModelCandidate,
): boolean {
  return rules.some(
    (rule) =>
      rule.mode === "codex" &&
      normalizeCompressionToken(rule.provider) === candidate.provider &&
      normalizeCompressionToken(rule.model) === candidate.modelId,
  );
}

export interface CodexManagementRowsOptions {
  readonly t: Translator;
  /** 本模块配置节（实时；codexAutoDetect 与 modelRules 的取值来源） */
  readonly section: ModuleConfigRecord;
  /** 「添加模型」选择器工厂（面板注入：需要模型注册表与写盘链路） */
  readonly openAddPicker: (done: (value?: string) => void) => Component;
}

/**
 * 页内行集合（纯函数：面板与测试共用同一份结构定义）：
 * 自动检测开关置顶，随后是受支持模型列表（空则一行说明），最后是「添加模型」。
 */
export function buildCodexManagementRows(options: CodexManagementRowsOptions): SettingItem[] {
  const { t } = options;
  const { settings } = readCompressionSettings(options.section);
  const rules = codexRules(settings);
  const rows: SettingItem[] = [
    schemaFieldRow({
      t,
      id: ROW_CODEX_AUTO_DETECT,
      field: CODEX_AUTO_DETECT_FIELD,
      current: options.section.codexAutoDetect,
    }),
  ];
  if (rules.length === 0) {
    rows.push({
      id: ROW_CODEX_EMPTY,
      label: t("module.compression.codex.panel.empty"),
      currentValue: "",
    });
  } else {
    rules.forEach((rule, index) => {
      const description = ruleIdentityText(rule);
      rows.push({
        id: codexRuleRowId(index),
        label: `${rule.provider}/${rule.model}`,
        ...(description === undefined ? {} : { description }),
        currentValue: ruleRowValue(rule, t),
      });
    });
  }
  rows.push({
    id: ROW_CODEX_ADD,
    label: t("module.compression.codex.add"),
    currentValue: "",
    submenu: (_currentValue: string, done: (value?: string) => void) => options.openAddPicker(done),
  });
  return rows;
}

/** 设置页里的入口行：值位是模型数 + 自动检测状态，描述位优先显示配置问题 */
export function buildCodexManagementRow(context: ModuleMenuContext): SettingItem {
  const t = context.t;
  const { problems } = readCompressionSettings(context.getConfig());
  const firstProblem = problems[0];
  return {
    id: ROW_CODEX_MANAGEMENT,
    label: t("module.compression.codexManagement.label"),
    description: firstProblem
      ? formatCompressionProblem(firstProblem, t)
      : t("module.compression.codexManagement.description"),
    currentValue: codexManagementValue(context.getConfig(), t),
    submenu: (_currentValue: string, done: (value?: string) => void) =>
      new CodexManagementPanel({
        t,
        theme: context.theme,
        context: context.context,
        saveConfig: (patch, hooks) => context.saveConfig(patch, hooks),
        requestRender: () => context.requestRender(),
        getSection: () => context.getConfig(),
        onDone: (value) => done(value),
      }),
  };
}

export interface CodexManagementPanelOptions {
  readonly t: Translator;
  readonly theme: MenuTheme;
  /** 打开面板时的扩展上下文：模型注册表（可用模型与鉴权）与失败提示走它 */
  readonly context: ExtensionContext;
  readonly saveConfig: (patch: ModuleConfigRecord, hooks?: ConfigWriteHooks) => Promise<void>;
  readonly requestRender: () => void;
  /** 读本模块配置节（实时，盘上真相） */
  readonly getSection: () => ModuleConfigRecord;
  readonly onDone: (value?: string) => void;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Codex 模式管理页：内嵌 i18n 设置列表，行集合按配置实时重建。
 * Esc 返回设置页；开关与添加上限都先写盘成功再刷新（失败只提示与回滚）。
 */
export class CodexManagementPanel implements Component {
  private readonly options: CodexManagementPanelOptions;
  private list: I18nSettingsList | undefined;
  private items: readonly SettingItem[] = [];

  constructor(options: CodexManagementPanelOptions) {
    this.options = options;
    this.rebuildItems();
  }

  render(width: number): string[] {
    return this.list?.render(width) ?? [];
  }

  invalidate(): void {
    this.list?.invalidate();
  }

  handleInput(data: string): void {
    this.list?.handleInput(data);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.list?.handleMouse(event);
  }

  /** 行显示回滚入口（与 I18nSettingsList.updateValue 同名契约）：委托内层列表 */
  updateValue(id: string, newValue: string): void {
    this.list?.updateValue(id, newValue);
  }

  /** 行 id 序列（自测用）：结构断言走这里 */
  rowIds(): string[] {
    return this.items.map((item) => item.id);
  }

  /** 把光标移到指定行（找不到返回 false）；自测与外部定位用 */
  selectRow(id: string): boolean {
    if (!this.items.some((item) => item.id === id)) return false;
    this.list?.selectItem(id);
    return true;
  }

  /** 行集合重建：配置变了就整份换掉（添加/开关成功后的刷新入口） */
  rebuildItems(selectId?: string): void {
    this.items = buildCodexManagementRows({
      t: this.options.t,
      section: this.options.getSection(),
      openAddPicker: (done) => this.openAddPicker(done),
    });
    this.list = new I18nSettingsList({
      items: this.items,
      maxVisible: MAX_VISIBLE,
      theme: this.options.theme.settings,
      t: this.options.t,
      enableSearch: true,
      onChange: (id, value) => {
        void this.handleChange(id, value);
      },
      onCancel: () => this.close(),
    });
    if (selectId !== undefined) this.list.selectItem(selectId);
  }

  private close(): void {
    this.options.onDone(codexManagementValue(this.options.getSection(), this.options.t));
  }

  private notify(message: string, level: "warning" | "error" = "warning"): void {
    if (this.options.context.hasUI) this.options.context.ui.notify(message, level);
  }

  /**
   * 开关行写盘时序：先 await saveConfig，成功才重建行集；失败提示错误并把行显示
   * 回滚成保存前的值（面板结构不变）。其余行自带子面板，这里不做处理。
   */
  private async handleChange(id: string, value: string): Promise<void> {
    if (id !== ROW_CODEX_AUTO_DETECT) return;
    const t = this.options.t;
    const previous = fieldDisplayValue(
      t,
      CODEX_AUTO_DETECT_FIELD,
      normalizeConfigValue(CODEX_AUTO_DETECT_FIELD, this.options.getSection().codexAutoDetect),
    );
    const next = fieldValueFromLabel(t, CODEX_AUTO_DETECT_FIELD, value);
    if (typeof next !== "boolean") {
      this.list?.updateValue(ROW_CODEX_AUTO_DETECT, previous);
      return;
    }
    try {
      await this.options.saveConfig({ codexAutoDetect: next });
    } catch (error) {
      this.notify(t("notify.saveFailed", { reason: describeError(error) }), "error");
      this.list?.updateValue(ROW_CODEX_AUTO_DETECT, previous);
      return;
    }
    this.rebuildItems(ROW_CODEX_AUTO_DETECT);
    this.options.requestRender();
  }

  /**
   * 开「添加模型」选择器：候选取用户已配置且认证可用的模型（getAvailable）。
   * 一个都没有时明确给原因与下一步（提示 + 页内说明组件），不留一个空选择器。
   */
  private openAddPicker(done: (value?: string) => void): Component {
    const t = this.options.t;
    const registry = this.options.context.modelRegistry;
    const available = registry.getAvailable();
    const candidates = discoverCompressionCandidates({ getAll: () => available });
    if (candidates.length === 0) {
      const message = t("module.compression.codex.noAvailableModels");
      this.notify(message);
      return new CodexNoticePanel({ t, theme: this.options.theme, message, onClose: () => done() });
    }
    return new ChoicePicker({
      title: t("module.compression.codex.addTitle"),
      theme: this.options.theme,
      t,
      searchable: true,
      options: candidates.map((candidate) => ({
        value: `${candidate.provider}/${candidate.modelId}`,
        label: `${candidate.provider}/${candidate.modelId}`,
        description: this.capabilityText(candidate),
      })),
      onSelect: (value) => {
        const candidate = candidates.find((entry) => `${entry.provider}/${entry.modelId}` === value);
        if (candidate) void this.applyAdd(candidate, available, done);
      },
      onCancel: () => done(),
    });
  }

  /** 候选的 Codex 资格文案（纯判定：模型目录地址 + provider 配置地址；不取 auth） */
  private capabilityText(candidate: CompressionModelCandidate): string {
    const capability = detectCodexCapability({
      provider: candidate.provider,
      api: candidate.api,
      modelBaseUrl: candidate.baseUrl,
      providerBaseUrl: this.options.context.modelRegistry.getProvider(candidate.provider)?.baseUrl,
    });
    return codexCapabilityLabel(capability, this.options.t);
  }

  /**
   * 选定后的写盘：先确认该模型的身份可用（认证不可用时只提示、不写），再按完整
   * 身份追加 codex 规则。重复规则按 provider/model 判定（同名模型不重复落键）。
   */
  private async applyAdd(
    candidate: CompressionModelCandidate,
    available: readonly CodexCapabilityModel[],
    done: (value?: string) => void,
  ): Promise<void> {
    const t = this.options.t;
    const identity = `${candidate.provider}/${candidate.modelId}`;
    const model = available.find(
      (entry) => entry.provider === candidate.provider && entry.id === candidate.modelId,
    );
    const capability = model
      ? await readModelCodexCapability(this.options.context.modelRegistry, model)
      : undefined;
    // 选择器关掉后再落到页面上（提示与行集重建都在关闭之后，避免子菜单被重建覆盖）
    done();
    if (capability?.reason === "auth-unavailable") {
      this.notify(
        t("module.compression.codex.authUnavailable", {
          provider: candidate.provider,
          detail: capability.detail ?? "",
        }),
      );
      return;
    }
    const rules = readCompressionSettings(this.options.getSection()).settings.modelRules;
    if (hasCodexRule(rules, candidate)) {
      this.notify(t("module.compression.rules.duplicate", { rule: identity }));
      return;
    }
    try {
      await this.options.saveConfig(modelRulesPatch([...rules, codexRuleFromCandidate(candidate)]));
    } catch (error) {
      this.notify(t("notify.saveFailed", { reason: describeError(error) }), "error");
      return;
    }
    const index = codexRules(readCompressionSettings(this.options.getSection()).settings).length - 1;
    this.rebuildItems(codexRuleRowId(index));
    this.options.requestRender();
  }
}

/** 说明页（空列表等情形）：标题 + 自动换行的说明 + 返回提示，Esc/Enter 关闭 */
class CodexNoticePanel implements Component {
  private readonly options: {
    readonly t: Translator;
    readonly theme: MenuTheme;
    readonly message: string;
    readonly onClose: () => void;
  };

  constructor(options: CodexNoticePanel["options"]) {
    this.options = options;
  }

  render(width: number): string[] {
    const theme = this.options.theme;
    const t = this.options.t;
    return [
      truncateToWidth(theme.title(t("module.compression.codex.panel.title")), width),
      "",
      ...wrapTextWithAnsi(this.options.message, Math.max(1, width - 2)).map((line) => `  ${line}`),
      "",
      truncateToWidth(theme.hint(t("hint.back")), width),
    ];
  }

  invalidate(): void {
    // 纯展示组件，无需失效处理
  }

  handleInput(data: string): void {
    const kb = getKeybindings();
    if (kb.matches(data, "tui.select.cancel") || kb.matches(data, "tui.select.confirm")) {
      this.options.onClose();
    }
  }
}
