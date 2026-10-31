import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SettingItem, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { Translator } from "../../i18n/index.ts";
import type { ConfigWriteHooks } from "../../kit/config-transaction.ts";
import { fieldDisplayValue, fieldValueFromLabel, schemaFieldRow } from "../../kit/menu/items.ts";
import { I18nSettingsList } from "../../kit/menu/settings-list.ts";
import type { MenuTheme } from "../../kit/menu/theme.ts";
import {
  ENABLED_FIELD,
  enabledField,
  normalizeConfigValue,
  type ConfigField,
  type ModuleConfigRecord,
  type ModuleConfigScalar,
  type ModuleConfigValue,
} from "../../kit/module.ts";
import {
  DEFAULT_COMPRESSION_MODES,
  DEFAULT_SESSION_COMPRESSION_OVERRIDE,
  SESSION_COMPRESSION_OVERRIDES,
  type DefaultCompressionMode,
  type SessionCompressionOverride,
} from "./api.ts";
import {
  detectCodexCapability,
  readModelCodexCapability,
  type CodexCapability,
} from "./codex/capability.ts";
import { isSessionCompressionOverride } from "./session-override.ts";

export const COMPRESSION_SETTINGS_ROW_ID = "compression.settings";

export const ROW_ENABLED = "compression.enabled";

export const ROW_SESSION_OVERRIDE = "compression.sessionOverride";

export const ROW_DEFAULT_MODE = "compression.defaultMode";

const COMPRESSION_ENABLED_FIELD: ConfigField = enabledField(
  "module.compression.enabled.label",
  "module.compression.enabled.description",
);

export const COMPRESSION_DEFAULT_MODE_FIELD: ConfigField = {
  default: "native",
  values: [...DEFAULT_COMPRESSION_MODES],
  labelKey: "module.compression.defaultMode.label",
  descriptionKey: "module.compression.defaultMode.description",
  valueLabelKeys: {
    native: "module.compression.defaultMode.value.native",
    acp: "module.compression.defaultMode.value.acp",
  },
};

const SESSION_OVERRIDE_FIELD: ConfigField = {
  default: DEFAULT_SESSION_COMPRESSION_OVERRIDE,
  values: [...SESSION_COMPRESSION_OVERRIDES],
  labelKey: "module.compression.sessionOverride.label",
  descriptionKey: "module.compression.sessionOverride.description",
  valueLabelKeys: {
    "follow-global": "module.compression.sessionOverride.value.follow-global",
    native: "module.compression.sessionOverride.value.native",
    acp: "module.compression.sessionOverride.value.acp",
    codex: "module.compression.sessionOverride.value.codex",
  },
};

function sessionOverrideField(codexAvailable: boolean): ConfigField {
  if (codexAvailable) return SESSION_OVERRIDE_FIELD;
  const labels = Object.entries(SESSION_OVERRIDE_FIELD.valueLabelKeys ?? {}).filter(
    ([value]) => value !== "codex",
  );
  return {
    ...SESSION_OVERRIDE_FIELD,
    values: SESSION_OVERRIDE_FIELD.values?.filter((value) => value !== "codex") ?? [],
    valueLabelKeys: Object.fromEntries(labels),
  };
}

const MAX_VISIBLE = 10;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const DEFAULT_MODE_FIELD = "defaultMode";

export function compressionEnabledValue(section: ModuleConfigRecord): boolean {
  return section[ENABLED_FIELD] !== false;
}

function compressionDefaultModeValue(section: ModuleConfigRecord): DefaultCompressionMode {
  const normalized = normalizeConfigValue(COMPRESSION_DEFAULT_MODE_FIELD, section[DEFAULT_MODE_FIELD]);
  return normalized === "acp" ? "acp" : "native";
}

export function compressionEnabledLabel(section: ModuleConfigRecord, t: Translator): string {
  return t(compressionEnabledValue(section) ? "module.compression.settings.value.on" : "module.compression.settings.value.off");
}

export interface CompressionSettingsRowsOptions {
  readonly t: Translator;

  readonly section: ModuleConfigRecord;

  readonly sessionOverride?: SessionCompressionOverride;

  readonly codexOverrideAvailable?: boolean;

  readonly codexManagementRow?: SettingItem;

  readonly detailRows: readonly SettingItem[];
}

export function buildCompressionSettingsRows(options: CompressionSettingsRowsOptions): SettingItem[] {
  const { t, section } = options;
  const rows: SettingItem[] = [
    schemaFieldRow({
      t,
      id: ROW_ENABLED,
      field: COMPRESSION_ENABLED_FIELD,
      current: section[ENABLED_FIELD],
    }),
  ];
  if (!compressionEnabledValue(section)) return rows;
  rows.push(
    schemaFieldRow({
      t,
      id: ROW_SESSION_OVERRIDE,
      field: sessionOverrideField(options.codexOverrideAvailable !== false),
      current: options.sessionOverride ?? DEFAULT_SESSION_COMPRESSION_OVERRIDE,
    }),
    schemaFieldRow({
      t,
      id: ROW_DEFAULT_MODE,
      field: COMPRESSION_DEFAULT_MODE_FIELD,
      current: section[DEFAULT_MODE_FIELD],
    }),
  );

  if (options.codexManagementRow) rows.push(options.codexManagementRow);
  rows.push(...options.detailRows);
  return rows;
}

export interface CompressionSettingsPanelOptions {
  readonly t: Translator;
  readonly theme: MenuTheme;

  readonly context: ExtensionContext;

  readonly getSection: () => ModuleConfigRecord;

  readonly saveConfig: (patch: ModuleConfigRecord, hooks?: ConfigWriteHooks) => Promise<void>;
  readonly requestRender: () => void;

  readonly detailRows: () => readonly SettingItem[];

  readonly codexManagementRow: () => SettingItem;

  readonly codexOverrideAvailable?: boolean;

  readonly readSessionOverride: () => SessionCompressionOverride;

  readonly writeSessionOverride: (next: SessionCompressionOverride) => void;

  readonly onDone: (value?: string) => void;
}

export class CompressionSettingsPanel {
  private readonly options: CompressionSettingsPanelOptions;
  private list: I18nSettingsList | undefined;
  private items: readonly SettingItem[] = [];

  private codexOverrideRejected = false;

  constructor(options: CompressionSettingsPanelOptions) {
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

  rebuildItems(selectId?: string): void {
    let sessionOverride = this.options.readSessionOverride();
    if (sessionOverride === "codex" && this.options.codexOverrideAvailable === false) {

      this.options.writeSessionOverride(DEFAULT_SESSION_COMPRESSION_OVERRIDE);
      sessionOverride = DEFAULT_SESSION_COMPRESSION_OVERRIDE;
    }
    const codexOverrideAvailable =
      this.options.codexOverrideAvailable !== false && !this.codexOverrideRejected;
    this.items = buildCompressionSettingsRows({
      t: this.options.t,
      section: this.options.getSection(),
      sessionOverride,
      codexOverrideAvailable,
      codexManagementRow: this.options.codexManagementRow(),
      detailRows: this.options.detailRows(),
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
    this.options.onDone(compressionEnabledLabel(this.options.getSection(), this.options.t));
  }

  private async handleChange(id: string, value: string): Promise<void> {
    if (id === ROW_ENABLED) {
      await this.saveDiskRow(id, ENABLED_FIELD, COMPRESSION_ENABLED_FIELD, this.currentEnabled(), value);
      return;
    }
    if (id === ROW_DEFAULT_MODE) {
      await this.saveDiskRow(
        id,
        DEFAULT_MODE_FIELD,
        COMPRESSION_DEFAULT_MODE_FIELD,
        compressionDefaultModeValue(this.options.getSection()),
        value,
      );
      return;
    }
    if (id === ROW_SESSION_OVERRIDE) {
      await this.applySessionOverride(value);
    }
  }

  private async saveDiskRow(
    id: string,
    key: string,
    field: ConfigField,
    current: ModuleConfigValue,
    value: string,
  ): Promise<void> {
    const t = this.options.t;
    const previous = fieldDisplayValue(t, field, normalizeConfigValue(field, current));
    const next = fieldValueFromLabel(t, field, value);
    if (next === undefined) {
      this.list?.updateValue(id, previous);
      return;
    }
    try {
      await this.options.saveConfig({ [key]: next });
    } catch (error) {
      this.options.context.ui.notify(t("notify.saveFailed", { reason: describeError(error) }), "error");
      this.list?.updateValue(id, previous);
      return;
    }
    this.rebuildItems(id);
    this.options.requestRender();
  }

  private async applySessionOverride(value: string): Promise<void> {
    const t = this.options.t;
    const previous = fieldDisplayValue(t, SESSION_OVERRIDE_FIELD, this.options.readSessionOverride());
    const next = fieldValueFromLabel(t, SESSION_OVERRIDE_FIELD, value);
    if (!isSessionCompressionOverride(next)) {
      this.list?.updateValue(ROW_SESSION_OVERRIDE, previous);
      return;
    }
    if (next === "codex") {
      const available = await this.codexOverrideAvailableForCurrentModel();
      if (!available) {
        this.codexOverrideRejected = true;

        this.rebuildItems(ROW_SESSION_OVERRIDE);
        this.options.requestRender();
        return;
      }
    }
    this.options.writeSessionOverride(next);
    this.rebuildItems(ROW_SESSION_OVERRIDE);
    this.options.requestRender();
  }

  private async codexOverrideAvailableForCurrentModel(): Promise<boolean> {
    const model = this.options.context.model;
    if (!model) return false;
    const capability = await this.readCodexCapability(model);
    return capability.capable;
  }

  private async readCodexCapability(
    model: NonNullable<ExtensionContext["model"]>,
  ): Promise<CodexCapability> {
    const registry = this.options.context.modelRegistry;
    if (!registry) {
      return detectCodexCapability({
        provider: model.provider,
        api: model.api,
        modelBaseUrl: model.baseUrl,
      });
    }
    return readModelCodexCapability(registry, model);
  }

  private currentEnabled(): ModuleConfigScalar {
    return compressionEnabledValue(this.options.getSection());
  }
}
