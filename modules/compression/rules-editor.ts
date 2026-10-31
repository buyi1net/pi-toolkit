import { type ExtensionContext, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  matchesKey,
  truncateToWidth,
  visibleWidth,
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
  CODEX_PROTOCOLS,
  CODEX_RULE_PROFILES,
  CODEX_UNSUPPORTED_POLICIES,
  COMPRESSION_MODES,
  type CodexProtocol,
  type CodexUnsupportedPolicy,
  type CompressionMode,
  type CompressionModelRule,
  type ModelIdentity,
} from "./api.ts";
import { modelRulesPatch, readCompressionSettings } from "./config.ts";
import {
  codexProtocolLabel,
  compressionModeLabel,
  compressionRuleLabel,
} from "./messages/index.ts";
import { normalizeBaseUrlForCompare, normalizeCompressionToken } from "./strategy.ts";

export type CompressionMenuRegistry = Pick<ModelRegistry, "getAll">;

export interface CompressionModelCandidate {
  readonly provider: string;
  readonly modelId: string;
  readonly api: string | undefined;
  readonly baseUrl: string | undefined;
  readonly contextWindow: number | undefined;
}

export function discoverCompressionCandidates(
  registry: CompressionMenuRegistry,
): CompressionModelCandidate[] {
  const candidates: CompressionModelCandidate[] = [];
  const seen = new Set<string>();
  for (const model of registry.getAll()) {
    const key = `${model.provider}/${model.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      provider: model.provider,
      modelId: model.id,
      api: model.api,
      baseUrl: model.baseUrl === "" ? undefined : model.baseUrl,
      contextWindow: model.contextWindow,
    });
  }
  candidates.sort((left, right) =>
    `${left.provider}/${left.modelId}`.localeCompare(`${right.provider}/${right.modelId}`),
  );
  return candidates;
}

export function candidateIdentity(candidate: {
  readonly provider: string;
  readonly modelId: string;
  readonly api?: string;
  readonly baseUrl?: string;
  readonly contextWindow?: number;
}): ModelIdentity {
  return {
    provider: candidate.provider,
    modelId: candidate.modelId,
    ...(candidate.api === undefined ? {} : { api: candidate.api }),
    ...(candidate.baseUrl === undefined ? {} : { baseUrl: candidate.baseUrl }),
    ...(candidate.contextWindow === undefined ? {} : { contextWindow: candidate.contextWindow }),
  };
}

export function modelIdentityFromModel(model: {
  readonly provider: string;
  readonly id: string;
  readonly api: string;
  readonly baseUrl: string;
  readonly contextWindow: number;
}): ModelIdentity {
  return candidateIdentity({
    provider: model.provider,
    modelId: model.id,
    api: model.api,
    baseUrl: model.baseUrl === "" ? undefined : model.baseUrl,
    contextWindow: model.contextWindow,
  });
}

export function sameRuleIdentity(
  rule: CompressionModelRule,
  candidate: { readonly provider: string; readonly modelId: string; readonly api?: string; readonly baseUrl?: string },
): boolean {
  if (normalizeCompressionToken(rule.provider) !== candidate.provider) return false;
  if (normalizeCompressionToken(rule.model) !== candidate.modelId) return false;
  const ruleApi = rule.api === undefined ? undefined : normalizeCompressionToken(rule.api);
  if (ruleApi !== (candidate.api ?? undefined)) return false;
  if ((rule.baseUrl ?? undefined) !== (candidate.baseUrl ?? undefined)) {
    if (rule.baseUrl === undefined || candidate.baseUrl === undefined) return false;
    if (normalizeBaseUrlForCompare(rule.baseUrl) !== normalizeBaseUrlForCompare(candidate.baseUrl)) {
      return false;
    }
  }
  return true;
}

export function withRuleMode(
  rule: CompressionModelRule,
  mode: CompressionMode,
  protocol: CodexProtocol | undefined,
): CompressionModelRule {
  const base: CompressionModelRule = {
    provider: rule.provider,
    model: rule.model,
    ...(rule.api === undefined ? {} : { api: rule.api }),
    ...(rule.baseUrl === undefined ? {} : { baseUrl: rule.baseUrl }),
    mode,
  };
  if (mode !== "codex") return base;
  const staying = rule.mode === "codex";
  return {
    ...base,
    ...(protocol === undefined ? {} : { protocol }),
    ...(staying && rule.profile !== undefined ? { profile: rule.profile } : {}),
    ...(staying && rule.onUnsupported !== undefined ? { onUnsupported: rule.onUnsupported } : {}),
  };
}

export type CodexRuleParam = "profile" | "onUnsupported";

export function withRuleProfile(
  rule: CompressionModelRule,
  profile: string | undefined,
): CompressionModelRule {
  return mergeCodexParams(rule, profile, rule.onUnsupported);
}

export function withRuleOnUnsupported(
  rule: CompressionModelRule,
  policy: CodexUnsupportedPolicy | undefined,
): CompressionModelRule {
  return mergeCodexParams(rule, rule.profile, policy);
}

function mergeCodexParams(
  rule: CompressionModelRule,
  profile: string | undefined,
  onUnsupported: CodexUnsupportedPolicy | undefined,
): CompressionModelRule {
  const { profile: _p, onUnsupported: _o, ...rest } = rule;
  return {
    ...rest,
    ...(profile !== undefined ? { profile } : {}),
    ...(onUnsupported !== undefined ? { onUnsupported } : {}),
  };
}

export function ruleRowValue(rule: CompressionModelRule, t: Translator): string {
  const mode = compressionModeLabel(rule.mode, t);
  if (rule.mode !== "codex") return mode;
  return `${mode} · ${codexProtocolLabel(rule.protocol, t)}`;
}

export function codexParamRowValue(rule: CompressionModelRule, param: CodexRuleParam, t: Translator): string {
  if (param === "profile") {
    return rule.profile === undefined ? t("module.compression.rules.profile.unset") : rule.profile;
  }
  return rule.onUnsupported === undefined
    ? t("module.compression.rules.onUnsupported.unset")
    : t(`module.compression.rules.onUnsupported.${rule.onUnsupported}`);
}

export function rulesCountValue(count: number, t: Translator): string {
  return count === 0
    ? t("module.compression.rules.value.none")
    : t("module.compression.rules.value.configured", { count });
}

export interface SaveOutcome {
  readonly ok: boolean;
  readonly error?: string;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface CompressionRulesPanelOptions {
  readonly t: Translator;
  readonly theme: MenuTheme;
  readonly context: ExtensionContext;

  readonly saveConfig: (patch: ModuleConfigRecord, hooks?: ConfigWriteHooks) => Promise<void>;
  readonly requestRender: () => void;

  readonly getSection: () => Record<string, unknown>;
  readonly onDone: (value: string) => void;
}

export async function saveModelRules(
  options: CompressionRulesPanelOptions,
  rules: readonly CompressionModelRule[],
): Promise<SaveOutcome> {
  try {
    await options.saveConfig(modelRulesPatch(rules));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

export function readRulesState(section: Record<string, unknown>): {
  readonly rules: readonly CompressionModelRule[];
  readonly problems: readonly unknown[];
} {
  const { settings, problems } = readCompressionSettings(section);
  return { rules: settings.modelRules, problems };
}

export type RulesEditorRow =
  | { readonly kind: "rule"; readonly index: number }
  | { readonly kind: "codexParam"; readonly index: number; readonly param: CodexRuleParam }
  | { readonly kind: "add" };

export function rulesEditorRowId(row: RulesEditorRow): string {
  if (row.kind === "rule") return `compression.rules.rule.${row.index}`;
  if (row.kind === "codexParam") return `compression.rules.rule.${row.index}.${row.param}`;
  return "compression.rules.add";
}

export function buildRulesEditorRows(rules: readonly CompressionModelRule[]): RulesEditorRow[] {
  const rows: RulesEditorRow[] = [];
  rules.forEach((rule, index) => {
    rows.push({ kind: "rule", index });
    if (rule.mode === "codex") {
      rows.push({ kind: "codexParam", index, param: "profile" });
      rows.push({ kind: "codexParam", index, param: "onUnsupported" });
    }
  });
  rows.push({ kind: "add" });
  return rows;
}

export function rulesEditorRowIds(rules: readonly CompressionModelRule[]): string[] {
  return buildRulesEditorRows(rules).map(rulesEditorRowId);
}

interface PendingDelete {
  readonly index: number;
  readonly identity: string;
}

export class CompressionRulesPanel implements Component {
  private readonly options: CompressionRulesPanelOptions;
  private readonly candidates: CompressionModelCandidate[];
  private rules: readonly CompressionModelRule[];
  private rows: RulesEditorRow[];
  private selectedIndex = 0;
  private pendingDelete: PendingDelete | null = null;
  private submenu: Component | null = null;
  private readonly maxVisible = 10;

  constructor(options: CompressionRulesPanelOptions) {
    this.options = options;
    this.candidates = discoverCompressionCandidates(options.context.modelRegistry);
    const state = readRulesState(options.getSection());
    this.rules = state.rules;
    this.rows = buildRulesEditorRows(this.rules);
  }

  render(width: number): string[] {
    if (this.submenu) return this.submenu.render(width);
    return this.renderEditor(width);
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
      this.toggleDeleteArm();
    } else if (kb.matches(data, "tui.select.cancel")) {
      if (this.pendingDelete) {
        this.pendingDelete = null;
        this.options.requestRender();
      } else {
        this.close();
      }
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
      const delta = event.wheelDelta < 0 ? -1 : 1;
      const previousIndex = this.selectedIndex;
      this.moveSelection(delta);
      return { handled: true, render: this.selectedIndex !== previousIndex };
    }
    if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return undefined;
    const rowIndex = startIndex + event.y;
    if (rowIndex < startIndex || rowIndex >= endIndex) return undefined;
    if (event.type === "press") {
      if (this.selectedIndex !== rowIndex) {
        this.selectedIndex = rowIndex;
        this.pendingDelete = null;
      }
      return { handled: true, focus: true };
    }
    this.selectedIndex = rowIndex;
    this.activate();
    return { handled: true };
  }

  private close(): void {
    this.options.onDone(rulesCountValue(this.rules.length, this.options.t));
  }

  private notify(message: string): void {
    this.options.context.ui.notify(message, "error");
  }

  private reportSave(outcome: SaveOutcome): void {
    if (outcome.ok) return;
    this.notify(this.options.t("notify.saveFailed", { reason: outcome.error ?? "" }));
  }

  private refresh(selectRowId?: string): void {
    const state = readRulesState(this.options.getSection());
    this.rules = state.rules;
    this.rows = buildRulesEditorRows(this.rules);
    const target =
      selectRowId === undefined ? -1 : this.rows.findIndex((row) => rulesEditorRowId(row) === selectRowId);
    this.selectedIndex = target >= 0 ? target : Math.min(this.selectedIndex, this.rows.length - 1);
    if (this.pendingDelete) {
      const rule = this.rules[this.pendingDelete.index];
      if (!rule || compressionRuleLabel(rule) !== this.pendingDelete.identity) {
        this.pendingDelete = null;
      }
    }
    this.options.requestRender();
  }

  private currentRow(): RulesEditorRow | undefined {
    return this.rows[this.selectedIndex];
  }

  selectRow(id: string): boolean {
    const index = this.rows.findIndex((row) => rulesEditorRowId(row) === id);
    if (index === -1) return false;
    this.selectedIndex = index;
    this.pendingDelete = null;
    return true;
  }

  currentRowId(): string {
    const row = this.rows[this.selectedIndex];
    return row ? rulesEditorRowId(row) : "";
  }

  private moveSelection(step: 1 | -1): void {
    if (this.rows.length === 0) return;
    const next = (this.selectedIndex + step + this.rows.length) % this.rows.length;
    if (next !== this.selectedIndex) {
      this.selectedIndex = next;
      this.pendingDelete = null;
    }
    this.options.requestRender();
  }

  private activate(): void {
    const row = this.currentRow();
    if (!row) return;
    if (row.kind === "rule" && this.pendingDelete && this.pendingDelete.index === row.index) {
      void this.confirmDelete(row.index);
      return;
    }
    this.pendingDelete = null;
    if (row.kind === "rule") this.openModePicker(row.index);
    else if (row.kind === "codexParam") this.openCodexParamPicker(row.index, row.param);
    else this.openModelPicker();
  }

  private toggleDeleteArm(): void {
    const row = this.currentRow();
    if (!row || row.kind !== "rule") return;
    if (this.pendingDelete && this.pendingDelete.index === row.index) {
      this.pendingDelete = null;
    } else {
      const rule = this.rules[row.index];
      this.pendingDelete = rule
        ? { index: row.index, identity: compressionRuleLabel(rule) }
        : null;
    }
    this.options.requestRender();
  }

  private async confirmDelete(index: number): Promise<void> {
    const rules = readRulesState(this.options.getSection()).rules;
    const outcome = await saveModelRules(
      this.options,
      rules.filter((_, i) => i !== index),
    );
    this.reportSave(outcome);
    if (outcome.ok) {
      this.pendingDelete = null;
      this.refresh();
    }
  }

  private openModePicker(index: number): void {
    const t = this.options.t;
    const rule = this.rules[index];
    if (!rule) return;
    this.submenu = new ChoicePicker({
      title: t("module.compression.rules.modeTitle", { rule: compressionRuleLabel(rule) }),
      theme: this.options.theme,
      t,
      options: COMPRESSION_MODES.map((mode) => ({
        value: mode,
        label: compressionModeLabel(mode, t),
      })),
      onSelect: (value) => {
        this.submenu = null;
        this.options.requestRender();
        const mode = COMPRESSION_MODES.find((entry) => entry === value);
        if (!mode) return;
        if (mode === "codex") {
          this.openProtocolPicker(index, mode, rule);
        } else {
          void this.applyModeEdit(index, mode, undefined);
        }
      },
      onCancel: () => {
        this.submenu = null;
        this.options.requestRender();
      },
    });
    this.options.requestRender();
  }

  private openProtocolPicker(
    index: number,
    mode: CompressionMode,
    rule: CompressionModelRule,
  ): void {
    const t = this.options.t;
    this.submenu = new ChoicePicker({
      title: t("module.compression.rules.protocolTitle", { rule: compressionRuleLabel(rule) }),
      theme: this.options.theme,
      t,
      options: [
        { value: "", label: codexProtocolLabel(undefined, t) },
        ...CODEX_PROTOCOLS.map((protocol) => ({
          value: protocol,
          label: codexProtocolLabel(protocol, t),
        })),
      ],
      onSelect: (value) => {
        this.submenu = null;
        this.options.requestRender();
        const protocol = value === "" ? undefined : (value as CodexProtocol);
        void this.applyModeEdit(index, mode, protocol);
      },
      onCancel: () => {
        this.submenu = null;
        this.options.requestRender();
      },
    });
    this.options.requestRender();
  }

  private openCodexParamPicker(index: number, param: CodexRuleParam): void {
    const t = this.options.t;
    const rule = this.rules[index];
    if (!rule || rule.mode !== "codex") return;
    const isProfile = param === "profile";
    const options = isProfile
      ? [
          { value: "", label: t("module.compression.rules.profile.unset") },
          ...CODEX_RULE_PROFILES.map((profile) => ({
            value: profile,
            label: t(`module.compression.rules.profile.${profile}`),
          })),
        ]
      : [
          { value: "", label: t("module.compression.rules.onUnsupported.unset") },
          ...CODEX_UNSUPPORTED_POLICIES.map((policy) => ({
            value: policy,
            label: t(`module.compression.rules.onUnsupported.${policy}`),
          })),
        ];
    this.submenu = new ChoicePicker({
      title: t(
        isProfile
          ? "module.compression.rules.profileTitle"
          : "module.compression.rules.onUnsupportedTitle",
        { rule: compressionRuleLabel(rule) },
      ),
      theme: this.options.theme,
      t,
      options,
      onSelect: (value: string) => {
        this.submenu = null;
        this.options.requestRender();
        const next = value === "" ? undefined : value;
        void this.applyCodexParamEdit(
          index,
          isProfile
            ? (entry) => withRuleProfile(entry, next)
            : (entry) => withRuleOnUnsupported(entry, next as CodexUnsupportedPolicy | undefined),
          `compression.rules.rule.${index}.${param}`,
        );
      },
      onCancel: () => {
        this.submenu = null;
        this.options.requestRender();
      },
    });
    this.options.requestRender();
  }

  private async applyModeEdit(
    index: number,
    mode: CompressionMode,
    protocol: CodexProtocol | undefined,
  ): Promise<void> {
    const rules = readRulesState(this.options.getSection()).rules;
    const rule = rules[index];
    if (!rule) return;
    const next = rules.map((entry, i) => (i === index ? withRuleMode(entry, mode, protocol) : entry));
    const outcome = await saveModelRules(this.options, next);
    this.reportSave(outcome);
    if (outcome.ok) {
      this.pendingDelete = null;
      this.refresh(`compression.rules.rule.${index}`);
    }
  }

  private async applyCodexParamEdit(
    index: number,
    update: (rule: CompressionModelRule) => CompressionModelRule,
    selectRowId: string,
  ): Promise<void> {
    const rules = readRulesState(this.options.getSection()).rules;
    const rule = rules[index];
    if (!rule || rule.mode !== "codex") return;
    const outcome = await saveModelRules(this.options, rules.map((entry, i) => (i === index ? update(entry) : entry)));
    this.reportSave(outcome);
    if (outcome.ok) {
      this.pendingDelete = null;
      this.refresh(selectRowId);
    }
  }

  private openModelPicker(): void {
    const t = this.options.t;
    this.submenu = new ChoicePicker({
      title: t("module.compression.rules.modelTitle"),
      theme: this.options.theme,
      t,
      searchable: true,
      options: this.candidates.map((candidate) => ({
        value: `${candidate.provider}/${candidate.modelId}`,
        label: `${candidate.provider}/${candidate.modelId}`,
        ...(candidate.contextWindow === undefined
          ? {}
          : { description: t("module.compression.diag.contextWindow", { value: String(candidate.contextWindow) }) }),
      })),
      onSelect: (value) => {
        this.submenu = null;
        this.options.requestRender();
        const candidate = this.candidates.find(
          (entry) => `${entry.provider}/${entry.modelId}` === value,
        );
        if (candidate) this.openAddModePicker(candidate);
      },
      onCancel: () => {
        this.submenu = null;
        this.options.requestRender();
      },
    });
    this.options.requestRender();
  }

  private openAddModePicker(candidate: CompressionModelCandidate): void {
    const t = this.options.t;
    const label = `${candidate.provider}/${candidate.modelId}`;
    this.submenu = new ChoicePicker({
      title: t("module.compression.rules.modeTitle", { rule: label }),
      theme: this.options.theme,
      t,
      options: COMPRESSION_MODES.map((mode) => ({
        value: mode,
        label: compressionModeLabel(mode, t),
      })),
      onSelect: (value) => {
        this.submenu = null;
        this.options.requestRender();
        const mode = COMPRESSION_MODES.find((entry) => entry === value);
        if (!mode) return;
        if (mode === "codex") {
          this.openAddProtocolPicker(candidate, label);
        } else {
          void this.applyAddRule(candidate, mode, undefined);
        }
      },
      onCancel: () => {
        this.submenu = null;
        this.options.requestRender();
      },
    });
    this.options.requestRender();
  }

  private openAddProtocolPicker(candidate: CompressionModelCandidate, label: string): void {
    const t = this.options.t;
    this.submenu = new ChoicePicker({
      title: t("module.compression.rules.protocolTitle", { rule: label }),
      theme: this.options.theme,
      t,
      options: [
        { value: "", label: codexProtocolLabel(undefined, t) },
        ...CODEX_PROTOCOLS.map((protocol) => ({
          value: protocol,
          label: codexProtocolLabel(protocol, t),
        })),
      ],
      onSelect: (value) => {
        this.submenu = null;
        this.options.requestRender();
        const protocol = value === "" ? undefined : (value as CodexProtocol);
        void this.applyAddRule(candidate, "codex", protocol);
      },
      onCancel: () => {
        this.submenu = null;
        this.options.requestRender();
      },
    });
    this.options.requestRender();
  }

  private async applyAddRule(
    candidate: CompressionModelCandidate,
    mode: CompressionMode,
    protocol: CodexProtocol | undefined,
  ): Promise<void> {
    const t = this.options.t;
    const rules = readRulesState(this.options.getSection()).rules;
    const bare = { provider: candidate.provider, modelId: candidate.modelId };
    if (rules.some((rule) => sameRuleIdentity(rule, bare))) {
      this.notify(t("module.compression.rules.duplicate", { rule: `${candidate.provider}/${candidate.modelId}` }));
      return;
    }
    const rule: CompressionModelRule = {
      provider: candidate.provider,
      model: candidate.modelId,
      mode,
      ...(protocol === undefined ? {} : { protocol }),
    };
    const outcome = await saveModelRules(this.options, [...rules, rule]);
    this.reportSave(outcome);
    if (outcome.ok) {
      this.pendingDelete = null;
      this.refresh(`compression.rules.rule.${rules.length}`);
    }
  }

  private getVisibleRange(): { startIndex: number; endIndex: number } {
    const startIndex = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(this.maxVisible / 2),
        this.rows.length - this.maxVisible,
      ),
    );
    return { startIndex, endIndex: Math.min(startIndex + this.maxVisible, this.rows.length) };
  }

  private renderEditor(width: number): string[] {
    const lines: string[] = [];
    const { startIndex, endIndex } = this.getVisibleRange();
    for (let i = startIndex; i < endIndex; i++) {
      const row = this.rows[i];
      if (!row) continue;
      lines.push(this.renderRow(row, i === this.selectedIndex, width));
    }
    if (startIndex > 0 || endIndex < this.rows.length) {
      const scrollText = `  (${this.selectedIndex + 1}/${this.rows.length})`;
      lines.push(this.options.theme.hint(truncateToWidth(scrollText, width - 2, "")));
    }
    lines.push("");
    if (this.rules.some((rule) => rule.mode === "codex")) {

      lines.push(
        truncateToWidth(this.options.theme.hint(this.options.t("module.compression.rules.codexRemoteNote")), width),
      );
    }
    lines.push(truncateToWidth(this.options.theme.hint(this.options.t("module.compression.rules.hint")), width));
    return lines;
  }

  private renderRow(row: RulesEditorRow, selected: boolean, width: number): string {
    const t = this.options.t;
    const theme = this.options.theme;
    const prefix = selected ? theme.settings.cursor : "  ";
    if (row.kind === "add") {
      return truncateToWidth(prefix + "  " + theme.hint(t("module.compression.rules.add")), width);
    }
    if (row.kind === "codexParam") {
      const paramRule = this.rules[row.index];
      if (!paramRule) return truncateToWidth(prefix, width);
      const label =
        row.param === "profile"
          ? t("module.compression.rules.profile.label")
          : t("module.compression.rules.onUnsupported.label");
      const body = theme.hint(`    ${label}`);
      const value = theme.settings.value(codexParamRowValue(paramRule, row.param, t), selected);
      const pad = Math.max(1, width - visibleWidth(prefix) - visibleWidth(body) - visibleWidth(value));
      return truncateToWidth(prefix + body + " ".repeat(pad) + value, width);
    }
    const rule = this.rules[row.index];
    if (!rule) return truncateToWidth(prefix, width);
    const armed = this.pendingDelete !== null && this.pendingDelete.index === row.index;
    const identity = compressionRuleLabel(rule);
    const body = armed
      ? theme.fg("error", identity) + theme.hint(` · ${t("module.compression.rules.deleteArmed")}`)
      : theme.settings.label(identity, selected);
    const value = theme.settings.value(ruleRowValue(rule, t), selected);
    const pad = Math.max(1, width - visibleWidth(prefix) - visibleWidth("  " + body) - visibleWidth(value));
    return truncateToWidth(prefix + "  " + body + " ".repeat(pad) + value, width);
  }
}
