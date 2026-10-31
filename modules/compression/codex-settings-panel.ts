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

export const ROW_CODEX_MANAGEMENT = "compression.codexManagement";

export const ROW_CODEX_OFFICIAL_HEADER = "compression.codex.officialHeader";

export const ROW_CODEX_MANUAL_HEADER = "compression.codex.manualHeader";

export const ROW_CODEX_ADD = "compression.codex.add";

export const ROW_CODEX_EMPTY = "compression.codex.empty";

const MAX_VISIBLE = 10;

export function codexOfficialRowId(index: number): string {
  return `compression.codex.official.${index}`;
}

export function codexRuleRowId(index: number): string {
  return `compression.codex.rule.${index}`;
}

export function codexRules(settings: { modelRules: readonly CompressionModelRule[] }): readonly CompressionModelRule[] {
  return settings.modelRules.filter((rule) => rule.mode === "codex");
}

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

export function codexCapabilityLabel(capability: CodexCapability, t: Translator): string {
  const label = t(`module.compression.codex.capability.${capability.reason}`);
  return capability.detail === undefined || capability.detail === "" ? label : `${label} · ${capability.detail}`;
}

function ruleIdentityText(rule: CompressionModelRule): string | undefined {
  const parts = [rule.api, rule.baseUrl].filter((part): part is string => part !== undefined && part !== "");
  return parts.length === 0 ? undefined : parts.join(" · ");
}

export function codexRuleFromCandidate(candidate: CompressionModelCandidate): CompressionModelRule {
  return {
    provider: candidate.provider,
    model: candidate.modelId,
    ...(candidate.api === undefined || candidate.api === "" ? {} : { api: candidate.api }),
    ...(candidate.baseUrl === undefined || candidate.baseUrl === "" ? {} : { baseUrl: candidate.baseUrl }),
    mode: "codex",
  };
}

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

  readonly section: ModuleConfigRecord;

  readonly officialModels: readonly CompressionModelCandidate[];

  readonly openAddPicker: (done: (value?: string) => void) => Component;
}

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

  readonly context: ExtensionContext;
  readonly saveConfig: (patch: ModuleConfigRecord, hooks?: ConfigWriteHooks) => Promise<void>;
  readonly requestRender: () => void;

  readonly getSection: () => ModuleConfigRecord;
  readonly onDone: (value?: string) => void;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

  updateValue(id: string, newValue: string): void {
    this.list?.updateValue(id, newValue);
  }

  rowIds(): string[] {
    return this.items.map((item) => item.id);
  }

  selectRow(id: string): boolean {
    if (!this.items.some((item) => item.id === id)) return false;
    this.list?.selectItem(id);
    return true;
  }

  private officialModels(): readonly CompressionModelCandidate[] {
    const { settings } = readCompressionSettings(this.options.getSection());
    return officialCodexModels(this.options.context.modelRegistry, settings.modelRules);
  }

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

    picker.removeOption(identity);
  }
}

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
