// Codex 模式管理页（工单 02，菜单重构后）：设置页里的 ROW_CODEX_MANAGEMENT 打开它。
//
// 页内两块（规格「Codex 模式专有化与向导式管理」）：
// - 官方订阅：对全部可用模型跑一遍能力探测器，命中的官方 OpenAI / Codex OAuth 链路
//   模型自动纳入 Codex（Remote V2），不需要显式规则；这是模块启用时的固有行为，
//   不再有独立的自动检测开关；
// - 手动添加：modelRules 里 mode=codex 的显式规则，覆盖中转站与自定义模型。已手动
//   添加的官方模型只在「手动添加」出现，不在「官方订阅」重复列出。
// - 「添加模型」：从 ModelRegistry.getAvailable()（用户已配置且认证可用）里勾选，
//   写入完整身份 provider / model / api / baseUrl。选择器加完一个不关闭：从候选里
//   去掉刚加的那条、搜索词原样保留，Esc 才退出，方便连续添加同类模型。
//
// 空列表与探测器失败都不静默：没有任何已认证可用模型时给出原因与下一步；取不到
// 认证信息时不落盘并说明要先修凭据；非官方链路（中转站 / 自定义路径）照常添加，
// 显式规则是用户的正当手段。
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
import { ChoicePicker } from "../../kit/menu/panels.ts";
import { I18nSettingsList } from "../../kit/menu/settings-list.ts";
import type { MenuTheme } from "../../kit/menu/theme.ts";
import type { ModuleConfigRecord, ModuleMenuContext } from "../../kit/module.ts";
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
import type { CompressionModelRule } from "./api.ts";

/** 设置页里的入口行 id（由 buildCompressionSettingsRows 插在模块专属行之前） */
export const ROW_CODEX_MANAGEMENT = "compression.codexManagement";
/** 页内「官方订阅」分组标题行 id（纯展示行，不响应回车） */
export const ROW_CODEX_OFFICIAL_HEADER = "compression.codex.officialHeader";
/** 页内「手动添加」分组标题行 id（纯展示行，不响应回车） */
export const ROW_CODEX_MANUAL_HEADER = "compression.codex.manualHeader";
/** 页内的「添加模型」行 id */
export const ROW_CODEX_ADD = "compression.codex.add";
/** 页内空列表说明行 id（纯展示行，不响应回车） */
export const ROW_CODEX_EMPTY = "compression.codex.empty";

const MAX_VISIBLE = 10;

/** 官方订阅模型行的行 id（下标按探测器命中的顺序） */
export function codexOfficialRowId(index: number): string {
  return `compression.codex.official.${index}`;
}

/** 页内已添加模型的行 id（下标按 mode=codex 过滤后的顺序） */
export function codexRuleRowId(index: number): string {
  return `compression.codex.rule.${index}`;
}

/** Codex 规则（受支持模型列表的唯一数据真相：modelRules 里 mode=codex 的条目） */
export function codexRules(settings: { modelRules: readonly CompressionModelRule[] }): readonly CompressionModelRule[] {
  return settings.modelRules.filter((rule) => rule.mode === "codex");
}

/**
 * 官方订阅模型：对全部可用模型跑纯判定探测器，命中的官方链路模型自动纳入 Codex。
 * 已手动添加（有 codex 规则）的官方模型剔除，只在「手动添加」出现。
 * 注册表缺失（宿主或测试环境未提供）时返回空列表，不抛错——与 settings-panel
 * 的 readCodexCapability 同一防御姿态。
 */
export function officialCodexModels(
  registry: Pick<ExtensionContext["modelRegistry"], "getAvailable" | "getProvider"> | undefined,
  rules: readonly CompressionModelRule[],
): readonly CompressionModelCandidate[] {
  if (!registry) return [];
  const candidates = discoverCompressionCandidates({ getAll: () => registry.getAvailable() });
  const manual = new Set(
    rules
      .filter((rule) => rule.mode === "codex")
      .map((rule) => `${normalizeCompressionToken(rule.provider)}/${normalizeCompressionToken(rule.model)}`),
  );
  return candidates.filter((candidate) => {
    if (manual.has(`${candidate.provider}/${candidate.modelId}`)) return false;
    const capability = detectCodexCapability({
      provider: candidate.provider,
      api: candidate.api,
      modelBaseUrl: candidate.baseUrl,
      providerBaseUrl: registry.getProvider(candidate.provider)?.baseUrl,
    });
    return capability.capable;
  });
}

/** 入口行的值位：官方 N · 手动 M */
export function codexManagementValue(
  section: ModuleConfigRecord,
  officialCount: number,
  t: Translator,
): string {
  const { settings } = readCompressionSettings(section);
  return t("module.compression.codexManagement.value.count", {
    official: officialCount,
    manual: codexRules(settings).length,
  });
}

/** 能力判定结果的显示文案：原因文案 + 判定细节（实际 host / path / 原值）；设置页的会话覆盖拒绝提示同用 */
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
 * 探测器判否而拒绝写入。
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
  /** 本模块配置节（实时；modelRules 的取值来源） */
  readonly section: ModuleConfigRecord;
  /** 官方订阅模型（探测器命中的官方链路模型，已剔除手动添加的） */
  readonly officialModels: readonly CompressionModelCandidate[];
  /** 「添加模型」选择器工厂（面板注入：需要模型注册表与写盘链路） */
  readonly openAddPicker: (done: (value?: string) => void) => Component;
}

/**
 * 页内行集合（纯函数：面板与测试共用同一份结构定义）：
 * 官方订阅分组（探测器命中）→ 手动添加分组（显式规则）→ 添加模型。
 * 两组都为空时给一行说明。
 */
export function buildCodexManagementRows(options: CodexManagementRowsOptions): SettingItem[] {
  const { t } = options;
  const { settings } = readCompressionSettings(options.section);
  const rules = codexRules(settings);
  const rows: SettingItem[] = [];
  const official = options.officialModels;
  if (official.length === 0 && rules.length === 0) {
    rows.push({
      id: ROW_CODEX_EMPTY,
      label: t("module.compression.codex.panel.empty"),
      currentValue: "",
    });
  } else {
    if (official.length > 0) {
      rows.push({
        id: ROW_CODEX_OFFICIAL_HEADER,
        label: t("module.compression.codex.officialHeader"),
        currentValue: "",
      });
      official.forEach((model, index) => {
        rows.push({
          id: codexOfficialRowId(index),
          label: `${model.provider}/${model.modelId}`,
          currentValue: ruleRowValue({ provider: model.provider, model: model.modelId, mode: "codex" }, t),
        });
      });
    }
    if (rules.length > 0) {
      rows.push({
        id: ROW_CODEX_MANUAL_HEADER,
        label: t("module.compression.codex.manualHeader"),
        currentValue: "",
      });
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
  }
  rows.push({
    id: ROW_CODEX_ADD,
    label: t("module.compression.codex.add"),
    currentValue: "",
    submenu: (_currentValue: string, done: (value?: string) => void) => options.openAddPicker(done),
  });
  return rows;
}

/** 设置页里的入口行：值位是官方数 + 手动数；描述位仅在有配置问题时显示 */
export function buildCodexManagementRow(context: ModuleMenuContext): SettingItem {
  const t = context.t;
  const { settings, problems } = readCompressionSettings(context.getConfig());
  const officialCount = officialCodexModels(context.context.modelRegistry, settings.modelRules).length;
  const firstProblem = problems[0];
  return {
    id: ROW_CODEX_MANAGEMENT,
    label: t("module.compression.codexManagement.label"),
    ...(firstProblem === undefined ? {} : { description: formatCompressionProblem(firstProblem, t) }),
    currentValue: codexManagementValue(context.getConfig(), officialCount, t),
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
 * Esc 返回设置页；添加成功后选择器不关闭（removeOption 去掉已选项，搜索词保留）。
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

  /** 官方订阅模型（探测器命中，已剔除手动添加）：行集与入口值位共用一个数据源 */
  private officialModels(): readonly CompressionModelCandidate[] {
    const { settings } = readCompressionSettings(this.options.getSection());
    return officialCodexModels(this.options.context.modelRegistry, settings.modelRules);
  }

  /** 行集合重建：配置变了就整份换掉（添加成功后刷新入口行值位） */
  rebuildItems(selectId?: string): void {
    this.items = buildCodexManagementRows({
      t: this.options.t,
      section: this.options.getSection(),
      officialModels: this.officialModels(),
      openAddPicker: (done) => this.openAddPicker(done),
    });
    this.list = new I18nSettingsList({
      items: this.items,
      maxVisible: MAX_VISIBLE,
      theme: this.options.theme.settings,
      t: this.options.t,
      enableSearch: true,
      // 本页已无就地切换行（自动检测开关已移除），所有行都是只读展示或子菜单入口，
      // 不会触发行值变更；保留空实现满足列表的构造契约。
      onChange: (_id, _value) => {},
      onCancel: () => this.close(),
    });
    if (selectId !== undefined) this.list.selectItem(selectId);
  }

  private close(): void {
    this.options.onDone(
      codexManagementValue(this.options.getSection(), this.officialModels().length, this.options.t),
    );
  }

  private notify(message: string, level: "warning" | "error" = "warning"): void {
    if (this.options.context.hasUI) this.options.context.ui.notify(message, level);
  }

  /**
   * 开「添加模型」选择器：候选取用户已配置且认证可用的模型（getAvailable）。
   * 一个都没有时明确给原因与下一步（提示 + 页内说明组件），不留一个空选择器。
   * 候选不带 description（不显示"host 不是官方域名…"的长提示），只留干净的 provider/model。
   * 添加成功后选择器不关闭：removeOption 去掉已选项、搜索词保留，Esc 才退出。
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
    const picker = new ChoicePicker({
      title: t("module.compression.codex.addTitle"),
      theme: this.options.theme,
      t,
      searchable: true,
      options: candidates.map((candidate) => ({
        value: `${candidate.provider}/${candidate.modelId}`,
        label: `${candidate.provider}/${candidate.modelId}`,
      })),
      onSelect: (value) => {
        const candidate = candidates.find((entry) => `${entry.provider}/${entry.modelId}` === value);
        if (candidate) void this.applyAdd(candidate, available, picker);
      },
      onCancel: () => {
        done();
        this.rebuildItems(ROW_CODEX_ADD);
        this.options.requestRender();
      },
    });
    return picker;
  }

  /**
   * 选定后的写盘：先确认该模型的身份可用（认证不可用时只提示、不写），再按完整
   * 身份追加 codex 规则。重复规则按 provider/model 判定（同名模型不重复落键）。
   * 添加成功后不关闭选择器：removeOption 去掉已选项、搜索词原样保留，用户可连续
   * 添加同类模型；Esc 才退出（onCancel → rebuildItems 刷新手动添加列表与入口值位）。
   */
  private async applyAdd(
    candidate: CompressionModelCandidate,
    available: readonly CodexCapabilityModel[],
    picker: ChoicePicker,
  ): Promise<void> {
    const t = this.options.t;
    const identity = `${candidate.provider}/${candidate.modelId}`;
    const model = available.find(
      (entry) => entry.provider === candidate.provider && entry.id === candidate.modelId,
    );
    const capability = model
      ? await readModelCodexCapability(this.options.context.modelRegistry, model)
      : undefined;
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
    // 添加成功：从选择器去掉已选项，保持打开（搜索词保留），不重建列表（避免关选择器）
    picker.removeOption(identity);
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
