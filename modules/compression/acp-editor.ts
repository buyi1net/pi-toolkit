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

export interface AcpSettingsPanelOptions {
  readonly t: Translator;
  readonly theme: MenuTheme;
  readonly context: ExtensionContext;

  readonly saveConfig: (patch: ModuleConfigRecord, hooks?: ConfigWriteHooks) => Promise<void>;
  readonly requestRender: () => void;

  readonly getSection: () => Record<string, unknown>;
  readonly onDone: (value: string) => void;
}

export interface AcpPanelApi {
  readonly t: Translator;
  readonly theme: MenuTheme;
  readonly context: ExtensionContext;
  readonly getSection: () => Record<string, unknown>;
  readonly requestRender: () => void;

  openSub(component: Component): void;

  closeSub(): void;
  notify(message: string, level?: "error" | "info" | "warning"): void;

  save(patch: ModuleConfigRecord): Promise<boolean>;
}

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

interface AcpPanelSpec {
  readonly titleKey: string;
  readonly hintKey: string;

  rows(api: AcpPanelApi): readonly AcpRowHandle[];

  onEscape(api: AcpPanelApi): void;
}

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

  selectRow(id: string): boolean {
    const delegate = this.listDelegate();
    if (delegate) return delegate.selectRow(id);
    const index = this.rows.findIndex((row) => row.id === id);
    if (index === -1) return false;
    this.selectedIndex = index;
    return true;
  }

  currentRowId(): string {
    const delegate = this.listDelegate();
    if (delegate) return delegate.currentRowId();
    const row = this.rows[this.selectedIndex];
    return row ? row.id : "";
  }

  rowIds(): string[] {
    const delegate = this.listDelegate();
    if (delegate) return delegate.rowIds();
    return this.rows.map((row) => row.id);
  }

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

export interface AcpInputEditorOptions {
  readonly t: Translator;
  readonly theme: MenuTheme;
  readonly title: string;
  readonly initial: string;

  readonly parse: (text: string) => { readonly ok: true; readonly normalized: string } | { readonly ok: false; readonly errorKey: string };
  readonly onSave: (normalized: string) => Promise<boolean>;
  readonly onClose: () => void;
}

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
    if (!parsed.ok) return;
    const saved = await this.options.onSave(parsed.normalized);
    if (saved) this.options.onClose();
  }
}

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

function triStateOptions(api: AcpPanelApi): readonly { readonly value: string; readonly label: string }[] {
  return [
    { value: "", label: api.t("module.compression.acpSettings.inherit") },
    { value: "on", label: api.t("module.compression.acpSettings.on") },
    { value: "off", label: api.t("module.compression.acpSettings.off") },
  ];
}

export function acpProviderCandidates(
  registry: CompressionMenuRegistry,
  section: Record<string, unknown>,
): string[] {
  const providers = new Set<string>(Object.keys(readCompressionSettings(section).settings.acp.providers));
  for (const candidate of discoverCompressionCandidates(registry)) providers.add(candidate.provider);
  return [...providers].sort((left, right) => left.localeCompare(right));
}

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

export function acpManagementRowValue(section: Record<string, unknown>, t: Translator): string {
  const { settings } = readCompressionSettings(section);
  return t("module.compression.acpAdvanced.value.overview", {
    preset: acpPresetLabel(settings.acpPreset, t),
    state: acpToggleLabel(settings.acpAutoDetect, t),
  });
}

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

  rows.push(promptPackRow(api, level));

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

  if (level.provider !== undefined && level.model === undefined) {
    rows.push(modelsRow(options, api, level));
  }
  return rows;
}

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

export const ACP_SETTINGS_ROW_IDS = {
  preset: "compression.acpPreset",
  autoDetect: "compression.acpAutoDetect",
  threshold: "compression.acpAdvanced.threshold",
  global: "compression.acpAdvanced.global",
  providers: "compression.acpAdvanced.providers",
} as const;

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

  if (readCompressionSettings(api.getSection()).settings.acpPreset === "custom") {
    rows.push(globalRow, providersRow);
  }
  return rows;
}
