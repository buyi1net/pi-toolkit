// ACP 管理页与高级编辑器（工单 10 的字段编辑 + 工单 03 的预设与管理页收编）：
// `modules.compression.acp` 的结构化编辑页。
//
// 先例：modules/compression/rules-editor.ts 的自绘面板（数值/自由文本不属于
// schema 控件，复杂对象走模块自己的编辑页——规格「菜单 schema 只放开关和有限
// 枚举」）。页面结构（高级项按分组进二级页）：
// - AcpSettingsPanel（根页，工单 03 起是 ACP 管理页）：预设切换（推荐默认 /
//   自定义进阶）+ ACP 自动检测开关与自动分流阈值；全局压缩参数与供应商/模型
//   覆盖属于高级调参项，只在自定义进阶下展开；
// - 层级页（global / provider / model 共用 AcpListPanel）：阈值 / 步长 / 近期
//   保留走数值编辑器，prompt pack 走有限枚举选择器，工具保护 / 提示词覆写 /
//   reasoning / 图片处理各进分组子页；provider 层多一行「模型覆盖」入口；
// - 分组子页（工具名单 / 提示词 / reasoning / 图片）。
//
// 键位：↑↓ 全行可达、Enter 编辑（或进子页/选择器）、Ctrl+D 清除该行覆盖
// （写 null 墨碑）、Esc 返回上级（根页 Esc 回菜单）。写盘走 kit 配置写入事务
// （saveConfig 注入），失败只提示不改显示；值位每次渲染回读配置节（盘上是
// 唯一真相），写盘成功后行集按当前配置重建（工具名单这类变长行保持同步）。
// 值位显示「本级自身」的覆盖：未设置显示「继承」；合并结果由运行时接缝
// （acp/config.ts）按 global → provider → model 解析。

import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  Input,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type { Translator } from "../../i18n/index.ts";
import type { ConfigWriteHooks } from "../../kit/config-transaction.ts";
import { ChoicePicker } from "../../kit/menu/panels.ts";
import type { MenuTheme } from "../../kit/menu/theme.ts";
import type { ModuleConfigRecord } from "../../kit/module.ts";
import {
  ACP_PRESETS,
  ACP_PROMPT_OVERRIDE_KEYS,
  ACP_PROMPT_PACKS,
  type AcpPreset,
} from "./api.ts";
import {
  acpAutoDetectThresholdPatch,
  acpOverrideFieldPatch,
  acpPresetPatch,
  countAcpOverrideFields,
  formatAcpPercentFileValue,
  parseAcpCountUserInput,
  parseAcpPercentUserInput,
  parseAcpPositiveIntUserInput,
  readAcpOverridesAt,
  readCompressionSettings,
  type AcpOverrideLevel,
} from "./config.ts";
import {
  acpCountValue,
  acpFieldLabel,
  acpImagesValue,
  acpPercentValue,
  acpPresetLabel,
  acpPromptPackLabel,
  acpPromptsValue,
  acpReasoningValue,
  acpToggleLabel,
  acpToolsValue,
} from "./messages/index.ts";
import { discoverCompressionCandidates, type CompressionMenuRegistry } from "./rules-editor.ts";

// ─────────────────────────────────────────────────────────────
// 选项与行模型
// ─────────────────────────────────────────────────────────────

export interface AcpSettingsPanelOptions {
  readonly t: Translator;
  readonly theme: MenuTheme;
  readonly context: ExtensionContext;
  /** 结构化配置写入事务（菜单层注入；补丁 → 落盘 → 重载 → 重生效 → 重绘） */
  readonly saveConfig: (patch: ModuleConfigRecord, hooks?: ConfigWriteHooks) => Promise<void>;
  readonly requestRender: () => void;
  /** 读本模块配置节（实时，盘上真相） */
  readonly getSection: () => Record<string, unknown>;
  readonly onDone: (value: string) => void;
}

/** 行编辑动作拿到的面板能力（开/关子页、提示、写盘） */
export interface AcpPanelApi {
  readonly t: Translator;
  readonly theme: MenuTheme;
  readonly context: ExtensionContext;
  readonly getSection: () => Record<string, unknown>;
  readonly requestRender: () => void;
  /** 在本面板上开子页（选择器 / 输入编辑器 / 子面板） */
  openSub(component: Component): void;
  /** 关掉本面板当前的子页 */
  closeSub(): void;
  notify(message: string, level?: "error" | "info" | "warning"): void;
  /** 写盘（成功后重建行集并重绘；失败提示并返回 false） */
  save(patch: ModuleConfigRecord): Promise<boolean>;
}

/** 编辑器行：标签 + 实时值位 + 可选的编辑/清除动作 */
export interface AcpRowHandle {
  readonly id: string;
  readonly label: string;
  value(): string;
  activate?(): void;
  clear?(): void;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ─────────────────────────────────────────────────────────────
// 面板骨架
// ─────────────────────────────────────────────────────────────

interface AcpPanelSpec {
  readonly titleKey: string;
  readonly hintKey: string;
  /** 行集（写盘成功后重建；值位闭包每次渲染回读配置节） */
  rows(api: AcpPanelApi): readonly AcpRowHandle[];
  /** Esc：根页回执菜单；子页关掉自己（由开页方注入 closeSub） */
  onEscape(api: AcpPanelApi): void;
}

/** 行列表面板：根页 / 层级页 / 分组子页共用的骨架（光标、滚动、子页、写盘） */
class AcpListPanel implements Component {
  private readonly options: AcpSettingsPanelOptions;
  private readonly spec: AcpPanelSpec;
  private readonly api: AcpPanelApi;
  private rows: readonly AcpRowHandle[] = [];
  private selectedIndex = 0;
  private submenu: Component | null = null;
  private readonly maxVisible = 12;

  constructor(options: AcpSettingsPanelOptions, spec: AcpPanelSpec) {
    this.options = options;
    this.spec = spec;
    const panel = this;
    this.api = {
      t: options.t,
      theme: options.theme,
      context: options.context,
      getSection: options.getSection,
      requestRender: options.requestRender,
      openSub: (component) => {
        panel.submenu = component;
        options.requestRender();
      },
      closeSub: () => {
        panel.submenu = null;
        options.requestRender();
      },
      notify: (message, level = "error") => {
        options.context.ui.notify(message, level);
      },
      save: async (patch) => {
        try {
          await options.saveConfig(patch);
          panel.rebuildRows();
          options.requestRender();
          return true;
        } catch (error) {
          options.context.ui.notify(options.t("notify.saveFailed", { reason: describeError(error) }), "error");
          return false;
        }
      },
    };
    this.rebuildRows();
  }

  private rebuildRows(): void {
    this.rows = this.spec.rows(this.api);
    if (this.selectedIndex >= this.rows.length) this.selectedIndex = Math.max(0, this.rows.length - 1);
  }

  render(width: number): string[] {
    if (this.submenu) return this.submenu.render(width);
    const theme = this.options.theme;
    const t = this.options.t;
    const lines = [truncateToWidth(theme.title(t(this.spec.titleKey)), width), ""];
    const { startIndex, endIndex } = this.getVisibleRange();
    for (let i = startIndex; i < endIndex; i++) {
      const row = this.rows[i];
      if (row) lines.push(this.renderRow(row, i === this.selectedIndex, width));
    }
    if (startIndex > 0 || endIndex < this.rows.length) {
      lines.push(theme.hint(truncateToWidth(`  (${this.selectedIndex + 1}/${this.rows.length})`, width - 2, "")));
    }
    lines.push("", truncateToWidth(theme.hint(t(this.spec.hintKey)), width));
    return lines;
  }

  invalidate(): void {
    this.submenu?.invalidate?.();
  }

  handleInput(data: string): void {
    if (this.submenu) {
      this.submenu.handleInput?.(data);
      return;
    }
    const kb = getKeybindings();
    if (kb.matches(data, "tui.select.up")) {
      this.moveSelection(-1);
    } else if (kb.matches(data, "tui.select.down")) {
      this.moveSelection(1);
    } else if (kb.matches(data, "tui.select.confirm") || data === " ") {
      this.activate();
    } else if (matchesKey(data, "ctrl+d")) {
      this.clearRow();
    } else if (kb.matches(data, "tui.select.cancel")) {
      this.spec.onEscape(this.api);
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.submenu) {
      const result = this.submenu.handleMouse?.(event);
      return result ? { ...result, focus: true } : undefined;
    }
    if (this.rows.length === 0) return undefined;
    const { startIndex, endIndex } = this.getVisibleRange();
    if (event.type === "wheel" && event.wheelDelta) {
      const previous = this.selectedIndex;
      this.moveSelection(event.wheelDelta < 0 ? -1 : 1);
      return { handled: true, render: this.selectedIndex !== previous };
    }
    if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return undefined;
    const rowIndex = startIndex + event.y;
    if (rowIndex < startIndex || rowIndex >= endIndex) return undefined;
    if (event.type === "press") {
      this.selectedIndex = rowIndex;
      return { handled: true, focus: true };
    }
    this.selectedIndex = rowIndex;
    this.activate();
    return { handled: true };
  }

  /** 测试与外部定位：把光标移到指定行 id（开着子面板时委托给它；找不到返回 false） */
  selectRow(id: string): boolean {
    const delegate = this.listDelegate();
    if (delegate) return delegate.selectRow(id);
    const index = this.rows.findIndex((row) => row.id === id);
    if (index === -1) return false;
    this.selectedIndex = index;
    return true;
  }

  /** 当前光标行 id（空面板返回空串；子面板打开时委托；测试用） */
  currentRowId(): string {
    const delegate = this.listDelegate();
    if (delegate) return delegate.currentRowId();
    const row = this.rows[this.selectedIndex];
    return row ? row.id : "";
  }

  /** 行 id 序列（结构断言用；子面板打开时委托） */
  rowIds(): string[] {
    const delegate = this.listDelegate();
    if (delegate) return delegate.rowIds();
    return this.rows.map((row) => row.id);
  }

  /** 子面板若是行列表面板，导航 API 委托给它（选择器/输入编辑器不委托） */
  private listDelegate(): { selectRow(id: string): boolean; currentRowId(): string; rowIds(): string[] } | null {
    const sub = this.submenu as unknown as Record<string, unknown> | null;
    if (!sub || typeof sub.selectRow !== "function" || typeof sub.rowIds !== "function") return null;
    return sub as unknown as { selectRow(id: string): boolean; currentRowId(): string; rowIds(): string[] };
  }

  private moveSelection(step: 1 | -1): void {
    if (this.rows.length === 0) return;
    const next = (this.selectedIndex + step + this.rows.length) % this.rows.length;
    if (next !== this.selectedIndex) this.selectedIndex = next;
    this.options.requestRender();
  }

  private activate(): void {
    const row = this.rows[this.selectedIndex];
    if (row) row.activate?.();
  }

  private clearRow(): void {
    const row = this.rows[this.selectedIndex];
    if (row) void row.clear?.();
  }

  private getVisibleRange(): { startIndex: number; endIndex: number } {
    const startIndex = Math.max(
      0,
      Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.rows.length - this.maxVisible),
    );
    return { startIndex, endIndex: Math.min(startIndex + this.maxVisible, this.rows.length) };
  }

  private renderRow(row: AcpRowHandle, selected: boolean, width: number): string {
    const theme = this.options.theme;
    const prefix = selected ? theme.settings.cursor : "  ";
    const body = theme.settings.label(row.label, selected);
    const value = theme.settings.value(row.value(), selected);
    const pad = Math.max(1, width - visibleWidth(prefix) - visibleWidth("  " + body) - visibleWidth(value));
    return truncateToWidth(prefix + "  " + body + " ".repeat(pad) + value, width);
  }
}

// ─────────────────────────────────────────────────────────────
// 输入编辑器（数值 / 文本的输入控件）
// ─────────────────────────────────────────────────────────────

export interface AcpInputEditorOptions {
  readonly t: Translator;
  readonly theme: MenuTheme;
  readonly title: string;
  readonly initial: string;
  /** 校验：合法返回解析结果（携带规范化写盘值），非法返回错误文案键 */
  readonly parse: (text: string) => { readonly ok: true; readonly normalized: string } | { readonly ok: false; readonly errorKey: string };
  readonly onSave: (normalized: string) => Promise<boolean>;
  readonly onClose: () => void;
}

/** 单行输入编辑器：Enter 校验并保存（保存成功才关闭），Esc 取消 */
export class AcpInputEditor implements Component {
  private readonly options: AcpInputEditorOptions;
  private readonly input: Input;

  constructor(options: AcpInputEditorOptions) {
    this.options = options;
    this.input = new Input();
    this.input.setValue(options.initial);
    this.input.onSubmit = (value) => void this.submit(value);
    this.input.onEscape = () => options.onClose();
  }

  render(width: number): string[] {
    const theme = this.options.theme;
    return [
      truncateToWidth(theme.title(this.options.title), width),
      "",
      ...this.input.render(width),
      "",
      truncateToWidth(theme.hint(this.options.t("module.compression.acpSettings.input.hint")), width),
    ];
  }

  invalidate(): void {
    this.input.invalidate();
  }

  handleInput(data: string): void {
    this.input.handleInput(data);
  }

  private async submit(text: string): Promise<void> {
    const parsed = this.options.parse(text);
    if (!parsed.ok) return; // 提示由 parse 的调用侧（openInput）负责
    const saved = await this.options.onSave(parsed.normalized);
    if (saved) this.options.onClose();
  }
}

/** 开输入编辑器：校验失败提示原因（留在编辑器），保存走 api.save */
function openInput(
  api: AcpPanelApi,
  options: {
    readonly fieldLabel: string;
    readonly initial: string;
    readonly parse: AcpInputEditorOptions["parse"];
    readonly buildPatch: (normalized: string) => ModuleConfigRecord;
  },
): void {
  api.openSub(
    new AcpInputEditor({
      t: api.t,
      theme: api.theme,
      title: api.t("module.compression.acpSettings.input.title", { field: options.fieldLabel }),
      initial: options.initial,
      parse: (text) => {
        const parsed = options.parse(text);
        if (!parsed.ok) {
          api.notify(
            api.t("module.compression.acpSettings.input.invalid", { reason: api.t(parsed.errorKey) }),
            "error",
          );
        }
        return parsed;
      },
      onSave: (normalized) => api.save(options.buildPatch(normalized)),
      onClose: () => api.closeSub(),
    }),
  );
}

/** 有限枚举选择器（prompt pack / 三态布尔）：选中即写盘并关闭 */
function openChoice(
  api: AcpPanelApi,
  fieldLabel: string,
  options: readonly { readonly value: string; readonly label: string }[],
  onPick: (value: string) => ModuleConfigRecord,
): void {
  api.openSub(
    new ChoicePicker({
      title: api.t("module.compression.acpSettings.pickTitle", { field: fieldLabel }),
      theme: api.theme,
      t: api.t,
      options,
      onSelect: (value) => {
        void api.save(onPick(value)).then((saved) => {
          if (saved) api.closeSub();
        });
      },
      onCancel: () => api.closeSub(),
    }),
  );
}

/** 三态枚举条目：继承 / 开 / 关 */
function triStateOptions(api: AcpPanelApi): readonly { readonly value: string; readonly label: string }[] {
  return [
    { value: "", label: api.t("module.compression.acpSettings.inherit") },
    { value: "on", label: api.t("module.compression.acpSettings.on") },
    { value: "off", label: api.t("module.compression.acpSettings.off") },
  ];
}

// ─────────────────────────────────────────────────────────────
// 候选发现与根行值位（纯函数，测试直测）
// ─────────────────────────────────────────────────────────────

/** 供应商候选 = 配置里已有的覆盖键 ∪ 模型目录里的供应商，字典序 */
export function acpProviderCandidates(
  registry: CompressionMenuRegistry,
  section: Record<string, unknown>,
): string[] {
  const providers = new Set<string>(Object.keys(readCompressionSettings(section).settings.acp.providers));
  for (const candidate of discoverCompressionCandidates(registry)) providers.add(candidate.provider);
  return [...providers].sort((left, right) => left.localeCompare(right));
}

/** 模型候选 = 指定供应商在配置里的模型覆盖键 ∪ 模型目录里的模型，字典序 */
export function acpModelCandidates(
  registry: CompressionMenuRegistry,
  section: Record<string, unknown>,
  provider: string,
): string[] {
  const models = new Set<string>();
  const providerOverrides = readCompressionSettings(section).settings.acp.providers[provider];
  if (providerOverrides) for (const model of Object.keys(providerOverrides.models ?? {})) models.add(model);
  for (const candidate of discoverCompressionCandidates(registry)) {
    if (candidate.provider === provider) models.add(candidate.modelId);
  }
  return [...models].sort((left, right) => left.localeCompare(right));
}

/** 根页入口行的值位（菜单行复用；工单 03）：预设档位 · 自动检测状态 */
export function acpManagementRowValue(section: Record<string, unknown>, t: Translator): string {
  const { settings } = readCompressionSettings(section);
  return t("module.compression.acpAdvanced.value.overview", {
    preset: acpPresetLabel(settings.acpPreset, t),
    state: acpToggleLabel(settings.acpAutoDetect, t),
  });
}

// ─────────────────────────────────────────────────────────────
// 行工厂（值位闭包每次渲染回读配置节）
// ─────────────────────────────────────────────────────────────

/** percent 字段行（最大上下文阈值 / 紧急截断阈值） */
function percentRow(
  api: AcpPanelApi,
  level: AcpOverrideLevel,
  field: "maxContextLimit" | "emergencyThresholdPercent",
): AcpRowHandle {
  const read = () => readAcpOverridesAt(api.getSection(), level)[field];
  return {
    id: `compression.acpOverride.${field}`,
    label: acpFieldLabel(field, api.t),
    value: () => acpPercentValue(read(), api.t),
    activate: () =>
      openInput(api, {
        fieldLabel: acpFieldLabel(field, api.t),
        initial: "",
        parse: (text) => {
          const ratio = parseAcpPercentUserInput(text);
          return ratio === undefined
            ? { ok: false, errorKey: "module.compression.acpSettings.input.invalidPercent" }
            : { ok: true, normalized: formatAcpPercentFileValue(ratio) };
        },
        buildPatch: (normalized) => acpOverrideFieldPatch(level, { [field]: normalized }),
      }),
    clear: () => void api.save(acpOverrideFieldPatch(level, { [field]: null })),
  };
}

/** 数值字段行（正整数 / 非负整数） */
function numberRow(
  api: AcpPanelApi,
  level: AcpOverrideLevel,
  field: "nudgeGrowthTokens" | "preserveRecentMessages" | "stripImagesKeepRecent",
): AcpRowHandle {
  const read = () => readAcpOverridesAt(api.getSection(), level)[field] as number | undefined;
  const isPositive = field === "nudgeGrowthTokens";
  const errorKey = isPositive
    ? "module.compression.acpSettings.input.invalidPositiveInt"
    : "module.compression.acpSettings.input.invalidCount";
  const parse = isPositive ? parseAcpPositiveIntUserInput : parseAcpCountUserInput;
  return {
    id: `compression.acpOverride.${field}`,
    label: acpFieldLabel(field, api.t),
    value: () => acpCountValue(read(), api.t),
    activate: () =>
      openInput(api, {
        fieldLabel: acpFieldLabel(field, api.t),
        initial: "",
        parse: (text) => {
          const value = parse(text);
          return value === undefined ? { ok: false, errorKey } : { ok: true, normalized: String(value) };
        },
        buildPatch: (normalized) => acpOverrideFieldPatch(level, { [field]: Number(normalized) }),
      }),
    clear: () => void api.save(acpOverrideFieldPatch(level, { [field]: null })),
  };
}

/** prompt pack 行（有限枚举：继承 / 完整 / 精简） */
function promptPackRow(api: AcpPanelApi, level: AcpOverrideLevel): AcpRowHandle {
  const field = "promptPack";
  const read = () => readAcpOverridesAt(api.getSection(), level).promptPack;
  return {
    id: `compression.acpOverride.${field}`,
    label: acpFieldLabel(field, api.t),
    value: () => acpPromptPackLabel(read(), api.t),
    activate: () =>
      openChoice(api, acpFieldLabel(field, api.t), [
        { value: "", label: api.t("module.compression.acpSettings.inherit") },
        ...ACP_PROMPT_PACKS.map((pack) => ({ value: pack, label: acpPromptPackLabel(pack, api.t) })),
      ], (value) => acpOverrideFieldPatch(level, { promptPack: value === "" ? null : value })),
    clear: () => void api.save(acpOverrideFieldPatch(level, { promptPack: null })),
  };
}

/** 分组子页面板（工具名单 / 提示词 / reasoning / 图片共用骨架） */
function groupPanel(
  options: AcpSettingsPanelOptions,
  titleKey: string,
  hintKey: string,
  rows: (api: AcpPanelApi) => readonly AcpRowHandle[],
  closeToParent: (api: AcpPanelApi) => void,
): AcpListPanel {
  return new AcpListPanel(options, {
    titleKey,
    hintKey,
    rows,
    onEscape: (api) => closeToParent(api),
  });
}

/** 层级页（global / provider / model 共用） */
function levelPanel(
  options: AcpSettingsPanelOptions,
  level: AcpOverrideLevel,
  closeToParent: (api: AcpPanelApi) => void,
): AcpListPanel {
  return new AcpListPanel(options, {
    titleKey: "module.compression.acpSettings.title",
    hintKey: "module.compression.acpSettings.levelHint",
    rows: (api) => buildOverrideRows(options, api, level),
    onEscape: (api) => closeToParent(api),
  });
}

/** 层级页的行集（导出供测试断言行结构） */
export function buildOverrideRows(
  options: AcpSettingsPanelOptions,
  api: AcpPanelApi,
  level: AcpOverrideLevel,
): AcpRowHandle[] {
  const rows: AcpRowHandle[] = [
    percentRow(api, level, "maxContextLimit"),
    percentRow(api, level, "emergencyThresholdPercent"),
    numberRow(api, level, "nudgeGrowthTokens"),
    numberRow(api, level, "preserveRecentMessages"),
  ];

  // 工具保护名单子页
  rows.push({
    id: "compression.acpOverride.protectedTools",
    label: acpFieldLabel("protectedTools", api.t),
    value: () => acpToolsValue(readAcpOverridesAt(api.getSection(), level).protectedTools, api.t),
    activate: () =>
      api.openSub(
        groupPanel(
          options,
          "module.compression.acpSettings.tools.title",
          "module.compression.acpSettings.tools.hint",
          (subApi) => toolsRows(subApi, level),
          () => api.closeSub(),
        ),
      ),
    clear: () => void api.save(acpOverrideFieldPatch(level, { protectedTools: null })),
  });

  // prompt pack
  rows.push(promptPackRow(api, level));

  // 提示词覆写子页
  rows.push({
    id: "compression.acpOverride.prompts",
    label: acpFieldLabel("prompts", api.t),
    value: () => acpPromptsValue(readAcpOverridesAt(api.getSection(), level).prompts, api.t),
    activate: () =>
      api.openSub(
        groupPanel(
          options,
          "module.compression.acpSettings.prompts.title",
          "module.compression.acpSettings.levelHint",
          (subApi) => promptsRows(subApi, level),
          () => api.closeSub(),
        ),
      ),
    clear: () => void api.save(acpOverrideFieldPatch(level, { prompts: null })),
  });

  // reasoning 处理子页
  rows.push({
    id: "compression.acpOverride.reasoning",
    label: acpFieldLabel("reasoning", api.t),
    value: () => acpReasoningValue(readAcpOverridesAt(api.getSection(), level).reasoning, api.t),
    activate: () =>
      api.openSub(
        groupPanel(
          options,
          "module.compression.acpSettings.reasoning.title",
          "module.compression.acpSettings.levelHint",
          (subApi) => reasoningRows(subApi, level),
          () => api.closeSub(),
        ),
      ),
    clear: () => void api.save(acpOverrideFieldPatch(level, { reasoning: null })),
  });

  // 图片处理子页
  rows.push({
    id: "compression.acpOverride.stripImages",
    label: acpFieldLabel("stripImages", api.t),
    value: () => {
      const own = readAcpOverridesAt(api.getSection(), level);
      return acpImagesValue(
        { stripImages: own.stripImages, stripImagesKeepRecent: own.stripImagesKeepRecent },
        api.t,
      );
    },
    activate: () =>
      api.openSub(
        groupPanel(
          options,
          "module.compression.acpSettings.images.title",
          "module.compression.acpSettings.levelHint",
          (subApi) => [
            stripImagesRow(subApi, level),
            numberRow(subApi, level, "stripImagesKeepRecent"),
          ],
          () => api.closeSub(),
        ),
      ),
    clear: () =>
      void api.save(acpOverrideFieldPatch(level, { stripImages: null, stripImagesKeepRecent: null })),
  });

  // provider 层：模型覆盖入口（模型级页的 Esc 关回本层级页：清本页子页栈）
  if (level.provider !== undefined && level.model === undefined) {
    rows.push(modelsRow(options, api, level));
  }
  return rows;
}

/** 图片处理子页的「剥离历史图片」三态行 */
function stripImagesRow(api: AcpPanelApi, level: AcpOverrideLevel): AcpRowHandle {
  const read = () => readAcpOverridesAt(api.getSection(), level).stripImages;
  const label = api.t("module.compression.acpSettings.images.strip");
  return {
    id: "compression.acpOverride.stripImages",
    label,
    value: () =>
      read() === undefined
        ? api.t("module.compression.acpSettings.inherit")
        : api.t(read() ? "module.compression.acpSettings.on" : "module.compression.acpSettings.off"),
    activate: () =>
      openChoice(api, label, triStateOptions(api), (value) =>
        acpOverrideFieldPatch(level, { stripImages: value === "" ? null : value === "on" }),
      ),
    clear: () => void api.save(acpOverrideFieldPatch(level, { stripImages: null })),
  };
}

/** reasoning 子页行集：drop（三态布尔）+ threshold（非负整数） */
function reasoningRows(api: AcpPanelApi, level: AcpOverrideLevel): AcpRowHandle[] {
  const readDrop = () => readAcpOverridesAt(api.getSection(), level).reasoning?.drop;
  const dropLabel = api.t("module.compression.acpSettings.reasoning.drop");
  const dropRow: AcpRowHandle = {
    id: "compression.acpOverride.reasoning.drop",
    label: dropLabel,
    value: () =>
      readDrop() === undefined
        ? api.t("module.compression.acpSettings.inherit")
        : api.t(readDrop() ? "module.compression.acpSettings.on" : "module.compression.acpSettings.off"),
    activate: () =>
      openChoice(api, dropLabel, triStateOptions(api), (value) =>
        acpOverrideFieldPatch(level, { reasoning: { drop: value === "" ? null : value === "on" } }),
      ),
    clear: () => void api.save(acpOverrideFieldPatch(level, { reasoning: { drop: null } })),
  };
  const thresholdLabel = api.t("module.compression.acpSettings.reasoning.threshold");
  const readThreshold = () => readAcpOverridesAt(api.getSection(), level).reasoning?.threshold;
  const thresholdRow: AcpRowHandle = {
    id: "compression.acpOverride.reasoning.threshold",
    label: thresholdLabel,
    value: () => acpCountValue(readThreshold(), api.t),
    activate: () =>
      openInput(api, {
        fieldLabel: thresholdLabel,
        initial: "",
        parse: (text) => {
          const value = parseAcpCountUserInput(text);
          return value === undefined
            ? { ok: false, errorKey: "module.compression.acpSettings.input.invalidCount" }
            : { ok: true, normalized: String(value) };
        },
        buildPatch: (normalized) =>
          acpOverrideFieldPatch(level, { reasoning: { threshold: Number(normalized) } }),
      }),
    clear: () => void api.save(acpOverrideFieldPatch(level, { reasoning: { threshold: null } })),
  };
  return [dropRow, thresholdRow];
}

/** 提示词覆写子页行集：四个槽位，值位显示覆写预览 */
function promptsRows(api: AcpPanelApi, level: AcpOverrideLevel): AcpRowHandle[] {
  return ACP_PROMPT_OVERRIDE_KEYS.map((key) => {
    const label = api.t(`module.compression.acpSettings.prompts.${key}`);
    const read = () => readAcpOverridesAt(api.getSection(), level).prompts?.[key];
    return {
      id: `compression.acpOverride.prompts.${key}`,
      label,
      value: () => {
        const current = read();
        return current === undefined
          ? api.t("module.compression.acpSettings.inherit")
          : `${current.slice(0, 24)}${current.length > 24 ? "…" : ""}`;
      },
      activate: () =>
        openInput(api, {
          fieldLabel: label,
          initial: read() ?? "",
          parse: (text) =>
            text.trim() === ""
              ? { ok: false, errorKey: "module.compression.acpSettings.input.invalidTool" }
              : { ok: true, normalized: text },
          buildPatch: (normalized) => acpOverrideFieldPatch(level, { prompts: { [key]: normalized } }),
        }),
      clear: () => void api.save(acpOverrideFieldPatch(level, { prompts: { [key]: null } })),
    } satisfies AcpRowHandle;
  });
}

/** 工具保护名单子页行集：名单行（改名/删除）+ 添加行 */
function toolsRows(api: AcpPanelApi, level: AcpOverrideLevel): AcpRowHandle[] {
  const tools = () => [...(readAcpOverridesAt(api.getSection(), level).protectedTools ?? [])];
  const saveTools = (next: string[]) =>
    api.save(
      acpOverrideFieldPatch(level, next.length === 0 ? { protectedTools: null } : { protectedTools: next }),
    );
  const rows: AcpRowHandle[] = tools().map((tool, index) => ({
    id: `compression.acpOverride.protectedTools.${index}`,
    label: tool,
    value: () => "",
    activate: () =>
      openInput(api, {
        fieldLabel: tool,
        initial: tool,
        parse: (text) =>
          text.trim() === ""
            ? { ok: false, errorKey: "module.compression.acpSettings.input.invalidTool" }
            : { ok: true, normalized: text.trim() },
        buildPatch: (normalized) => {
          const next = tools().map((entry, i) => (i === index ? normalized : entry));
          return acpOverrideFieldPatch(level, { protectedTools: next });
        },
      }),
    clear: () => void saveTools(tools().filter((_, i) => i !== index)),
  }));
  rows.push({
    id: "compression.acpOverride.protectedTools.add",
    label: api.t("module.compression.acpSettings.tools.add"),
    value: () => "",
    activate: () =>
      openInput(api, {
        fieldLabel: api.t("module.compression.acpSettings.tools.add"),
        initial: "",
        parse: (text) =>
          text.trim() === ""
            ? { ok: false, errorKey: "module.compression.acpSettings.input.invalidTool" }
            : { ok: true, normalized: text.trim() },
        buildPatch: (normalized) => {
          const current = tools();
          return acpOverrideFieldPatch(level, {
            protectedTools: current.includes(normalized) ? current : [...current, normalized],
          });
        },
      }),
  });
  return rows;
}

/** provider 层的「模型覆盖」行：模型选择器 → 模型级层级页 */
function modelsRow(
  options: AcpSettingsPanelOptions,
  api: AcpPanelApi,
  level: AcpOverrideLevel,
): AcpRowHandle {
  const registry = api.context.modelRegistry;
  const countOf = () => {
    const providerOverrides = readCompressionSettings(api.getSection()).settings.acp.providers[level.provider!];
    return Object.keys(providerOverrides?.models ?? {}).length;
  };
  return {
    id: "compression.acpOverride.models",
    label: api.t("module.compression.acpSettings.field.models.label"),
    value: () =>
      countOf() === 0
        ? api.t("module.compression.acpSettings.providers.value.none")
        : api.t("module.compression.acpSettings.field.models.value", { count: String(countOf()) }),
    activate: () => {
      const models = acpModelCandidates(registry, api.getSection(), level.provider!);
      api.openSub(
        new ChoicePicker({
          title: api.t("module.compression.acpSettings.modelTitle", { provider: level.provider! }),
          theme: api.theme,
          t: api.t,
          searchable: true,
          options: models.map((model) => ({ value: model, label: `${level.provider!}/${model}` })),
          onSelect: (value) => {
            api.openSub(levelPanel(options, { provider: level.provider, model: value }, () => api.closeSub()));
          },
          onCancel: () => api.closeSub(),
        }),
      );
      api.requestRender();
    },
  };
}

// ─────────────────────────────────────────────────────────────
// 根页：ACP 管理页（设置页入口的子页）
// ─────────────────────────────────────────────────────────────

/** 根页行 id（测试断言用）：预设 / 自动检测 / 阈值 / 全局参数 / 供应商覆盖 */
export const ACP_SETTINGS_ROW_IDS = {
  preset: "compression.acpPreset",
  autoDetect: "compression.acpAutoDetect",
  threshold: "compression.acpAdvanced.threshold",
  global: "compression.acpAdvanced.global",
  providers: "compression.acpAdvanced.providers",
} as const;

/**
 * 预设行（工单 03）：推荐默认（开箱即用） / 自定义进阶。切到自定义时由
 * acpPresetPatch 决定是否把推荐值填成草稿（草稿已有覆盖则原样保留）。
 */
function presetRow(api: AcpPanelApi): AcpRowHandle {
  const label = api.t("module.compression.acpPreset.label");
  const read = () => readCompressionSettings(api.getSection()).settings.acpPreset;
  return {
    id: ACP_SETTINGS_ROW_IDS.preset,
    label,
    value: () => acpPresetLabel(read(), api.t),
    activate: () =>
      openChoice(
        api,
        label,
        ACP_PRESETS.map((preset) => ({ value: preset, label: acpPresetLabel(preset, api.t) })),
        (value) => acpPresetPatch(value as AcpPreset, readAcpOverridesAt(api.getSection(), {})),
      ),
  };
}

/**
 * 自动检测开关行（工单 03）：属于触发路由层，既不被预设覆盖，也不归属高级调参页，
 * 两档预设下都保持可见可改。
 */
function autoDetectRow(api: AcpPanelApi): AcpRowHandle {
  const label = api.t("module.compression.acpAutoDetect.label");
  const read = () => readCompressionSettings(api.getSection()).settings.acpAutoDetect;
  return {
    id: ACP_SETTINGS_ROW_IDS.autoDetect,
    label,
    value: () => acpToggleLabel(read(), api.t),
    activate: () =>
      openChoice(
        api,
        label,
        [
          { value: "on", label: acpToggleLabel(true, api.t) },
          { value: "off", label: acpToggleLabel(false, api.t) },
        ],
        (value) => ({ acpAutoDetect: value === "on" }),
      ),
  };
}

/**
 * ACP 管理页根行（工单 03）：预设档位 + 自动检测开关 + 自动分流阈值始终可见；
 * 全局参数与供应商覆盖是高级调参项，只在自定义进阶下展开。
 * Esc 回执菜单（值位文案 = acpManagementRowValue）。
 */
export class AcpSettingsPanel extends AcpListPanel {
  constructor(options: AcpSettingsPanelOptions) {
    super(options, {
      titleKey: "module.compression.acpSettings.title",
      hintKey: "module.compression.acpSettings.hint",
      rows: (api) => buildRootRows(options, api),
      onEscape: (api) => options.onDone(acpManagementRowValue(api.getSection(), api.t)),
    });
  }
}

/** 根页行集 */
function buildRootRows(options: AcpSettingsPanelOptions, api: AcpPanelApi): AcpRowHandle[] {
  const registry = api.context.modelRegistry;
  const thresholdLabel = api.t("module.compression.acpSettings.threshold.label");
  const thresholdRow: AcpRowHandle = {
    id: ACP_SETTINGS_ROW_IDS.threshold,
    label: thresholdLabel,
    value: () => String(readCompressionSettings(api.getSection()).settings.acpAutoDetectThreshold),
    activate: () =>
      openInput(api, {
        fieldLabel: thresholdLabel,
        initial: "",
        parse: (text) => {
          const value = parseAcpPositiveIntUserInput(text);
          return value === undefined
            ? { ok: false, errorKey: "module.compression.acpSettings.input.invalidPositiveInt" }
            : { ok: true, normalized: String(value) };
        },
        buildPatch: (normalized) => acpAutoDetectThresholdPatch(Number(normalized)),
      }),
  };
  const globalRow: AcpRowHandle = {
    id: ACP_SETTINGS_ROW_IDS.global,
    label: api.t("module.compression.acpSettings.global.label"),
    value: () => {
      const count = countAcpOverrideFields(readAcpOverridesAt(api.getSection(), {}));
      return count === 0
        ? api.t("module.compression.acpSettings.global.value.none")
        : api.t("module.compression.acpSettings.global.value.set", { count: String(count) });
    },
    activate: () => api.openSub(levelPanel(options, {}, () => api.closeSub())),
  };
  const providersRow: AcpRowHandle = {
    id: ACP_SETTINGS_ROW_IDS.providers,
    label: api.t("module.compression.acpSettings.providers.label"),
    value: () => {
      const count = Object.keys(readCompressionSettings(api.getSection()).settings.acp.providers).length;
      return count === 0
        ? api.t("module.compression.acpSettings.providers.value.none")
        : api.t("module.compression.acpSettings.providers.value.set", { count: String(count) });
    },
    activate: () => {
      const providers = acpProviderCandidates(registry, api.getSection());
      api.openSub(
        new ChoicePicker({
          title: api.t("module.compression.acpSettings.providerTitle"),
          theme: api.theme,
          t: api.t,
          searchable: true,
          options: providers.map((provider) => ({ value: provider, label: provider })),
          onSelect: (value) => {
            api.openSub(levelPanel(options, { provider: value }, () => api.closeSub()));
          },
          onCancel: () => api.closeSub(),
        }),
      );
      api.requestRender();
    },
  };
  const rows: AcpRowHandle[] = [presetRow(api), autoDetectRow(api), thresholdRow];
  // 高级调参项只在自定义进阶下展开（推荐默认下那 8 个压缩参数由推荐常量接管，
  // 切换档位后行集即时重建）
  if (readCompressionSettings(api.getSection()).settings.acpPreset === "custom") {
    rows.push(globalRow, providersRow);
  }
  return rows;
}
