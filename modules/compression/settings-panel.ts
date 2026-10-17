// 模型压缩二级设置页（工单 01 骨架 + 工单 05 会话覆盖与全局默认两值枚举）：一级菜单
// 唯一入口行打开的设置页。
//
// 设计口径（规格「二级面板状态机与动态重构机制」）：
// - 行集合每次重建：`enabled === false` 时只剩总开关一行，用户一眼看出「已彻底
//   退回 Pi 原生」；`enabled === true` 时按规格最终行序渲染——总开关 → 当前会话
//   覆盖 → 全局默认模式 →（仅默认模式为 native 时）native 触发策略 → Codex 模式
//   管理入口 → ACP 管理入口 → 工具行（模型规则入口 / 当前模型诊断，由 menu.ts 提供）；
// - 磁盘配置写盘时序（enabled / defaultMode / nativeTrigger）：先 await saveConfig，
//   成功才重建行集 + 请求重绘；失败提示错误、把行显示回滚成保存前的值，面板结构
//   保持原样（不重建）；
// - 当前会话覆盖是纯内存状态（session-override.ts）：切换只重建行集 + 重绘，不写盘、
//   不进配置事务；选 codex 时先校验当前模型的 Responses 资格，不满足则拒绝变更、
//   恢复前值并提示原因。

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
  NATIVE_TRIGGER_POLICIES,
  SESSION_COMPRESSION_OVERRIDES,
  type DefaultCompressionMode,
  type NativeTriggerPolicy,
  type SessionCompressionOverride,
} from "./api.ts";
import {
  detectCodexCapability,
  readModelCodexCapability,
  type CodexCapability,
} from "./codex/capability.ts";
import { codexCapabilityLabel } from "./codex-settings-panel.ts";
import { isSessionCompressionOverride } from "./session-override.ts";

/** 一级菜单唯一入口行 id（topLevel 钩子返回这一行） */
export const COMPRESSION_SETTINGS_ROW_ID = "compression.settings";

/** 面板内的模块总开关行 id：沿用 schema 字段 id，落盘与显示回滚都走同一条链 */
export const ROW_ENABLED = "compression.enabled";

/** 当前会话压缩模式行 id（工单 05）：纯内存行，不落盘 */
export const ROW_SESSION_OVERRIDE = "compression.sessionOverride";
/** 全局默认压缩模式行 id（工单 05）：两值枚举的就地切换行 */
export const ROW_DEFAULT_MODE = "compression.defaultMode";
/** native 触发策略行 id（工单 05）：只在全局默认模式为 native 时插入 */
export const ROW_NATIVE_TRIGGER = "compression.nativeTrigger";

/** 模块总开关字段（与 schema 同源：面板行与落盘校验共用同一份定义） */
const COMPRESSION_ENABLED_FIELD: ConfigField = enabledField(
  "module.compression.enabled.label",
  "module.compression.enabled.description",
);

/**
 * 全局默认压缩模式字段（工单 05）：两值枚举，Codex 只能经模型规则或当前会话覆盖
 * 进入。schema（index.ts）与设置页共用这一份定义，两处取值不会分叉。
 */
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

/** native 触发策略字段（工单 05 落进设置页；schema 与设置页共用同一份定义） */
export const COMPRESSION_NATIVE_TRIGGER_FIELD: ConfigField = {
  default: "manual",
  values: [...NATIVE_TRIGGER_POLICIES],
  labelKey: "module.compression.nativeTrigger.label",
  descriptionKey: "module.compression.nativeTrigger.description",
  valueLabelKeys: {
    auto: "module.compression.nativeTrigger.value.auto",
    manual: "module.compression.nativeTrigger.value.manual",
  },
};

/**
 * 当前会话覆盖字段（工单 05）：不是配置字段，只借同一套枚举行机制做显示与文案反查
 * （schemaFieldRow / fieldValueFromLabel），因此四值与三语文案不必另写一份。
 */
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

/**
 * 会话覆盖字段的可选项版本：Codex 不可用时从枚举里摘掉。原因不是「少一个选项好看」：
 * 枚举行的换档是「当前显示值的下一个」（pi-tui SettingsList），被拒的 Codex 挂在循环里
 * 会让用户永远转不出 acp——向后回不到 native，更回不到跟随全局。
 */
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

/** 全局默认模式与 native 触发策略在配置节里的字段名（落盘补丁与读取共用一个常量） */
const DEFAULT_MODE_FIELD = "defaultMode";
const NATIVE_TRIGGER_FIELD = "nativeTrigger";

/** 模块总开关的当前取值（非法/缺省按默认 true 处理，与装配器的解析口径一致） */
export function compressionEnabledValue(section: ModuleConfigRecord): boolean {
  return section[ENABLED_FIELD] !== false;
}

/** 全局默认模式当前值（非法或缺失按 schema 默认 native；Codex 已不在枚举内） */
function compressionDefaultModeValue(section: ModuleConfigRecord): DefaultCompressionMode {
  const normalized = normalizeConfigValue(COMPRESSION_DEFAULT_MODE_FIELD, section[DEFAULT_MODE_FIELD]);
  return normalized === "acp" ? "acp" : "native";
}

/** native 触发策略当前值（非法或缺失按 schema 默认 manual） */
function compressionNativeTriggerValue(section: ModuleConfigRecord): NativeTriggerPolicy {
  const normalized = normalizeConfigValue(COMPRESSION_NATIVE_TRIGGER_FIELD, section[NATIVE_TRIGGER_FIELD]);
  return normalized === "auto" ? "auto" : "manual";
}

/** 一级入口行的值位文案：只有 开 / 关 两态（规格：一级不堆模式与诊断文本） */
export function compressionEnabledLabel(section: ModuleConfigRecord, t: Translator): string {
  return t(compressionEnabledValue(section) ? "module.compression.settings.value.on" : "module.compression.settings.value.off");
}

export interface CompressionSettingsRowsOptions {
  readonly t: Translator;
  /** 本模块配置节（实时；enabled 与两个全局字段的取值来源） */
  readonly section: ModuleConfigRecord;
  /** 当前会话覆盖（内存态；缺省 = follow-global） */
  readonly sessionOverride?: SessionCompressionOverride;
  /** Codex 档位是否进枚举（当前模型不具备资格或刚被拒时为 false；缺省 true） */
  readonly codexOverrideAvailable?: boolean;
  /** 工单 02：Codex 模式管理入口行（排在模块专属行之前；关闭态整体不渲染） */
  readonly codexManagementRow?: SettingItem;
  /** 模块专属行（ACP 管理入口 / 模型规则 / 当前模型策略诊断；关闭时整体收起不渲染） */
  readonly detailRows: readonly SettingItem[];
}

/**
 * 面板行集合（纯函数：面板与测试共用同一份结构定义）。
 * 总开关永远是第一行；关闭时到此为止——下方所有配置项一律隐藏。
 * 启用态按规格最终行序：总开关 → 当前会话覆盖 → 全局默认模式 →
 * （仅 native 时的）native 触发策略 → Codex 模式管理 → ACP 管理入口 → 工具行。
 */
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
  // 原生触发策略只对 native 有意义：默认模式选 acp 时剔除整行（规格动态联动）
  if (compressionDefaultModeValue(section) === "native") {
    rows.push(
      schemaFieldRow({
        t,
        id: ROW_NATIVE_TRIGGER,
        field: COMPRESSION_NATIVE_TRIGGER_FIELD,
        current: section[NATIVE_TRIGGER_FIELD],
      }),
    );
  }
  // 工单 02 的 Codex 模式管理入口；工单 03 的 ACP 管理页与工单 07 的工具行随 detailRows
  // （detailRows 自带 ACP 管理入口，恰好接在 Codex 入口之后）
  if (options.codexManagementRow) rows.push(options.codexManagementRow);
  rows.push(...options.detailRows);
  return rows;
}

/** 面板选项：写盘链路与重绘请求均由菜单层注入（面板不自己拥有事务） */
export interface CompressionSettingsPanelOptions {
  readonly t: Translator;
  readonly theme: MenuTheme;
  /** 打开面板时的扩展上下文：写盘失败提示走 ui.notify */
  readonly context: ExtensionContext;
  /** 读本模块配置节（实时，盘上真相） */
  readonly getSection: () => ModuleConfigRecord;
  /** 结构化配置写入事务（菜单层注入；补丁 → 落盘 → 重载 → 重生效 → 重绘） */
  readonly saveConfig: (patch: ModuleConfigRecord, hooks?: ConfigWriteHooks) => Promise<void>;
  readonly requestRender: () => void;
  /** 模块专属行（模型规则 / ACP 高级设置 / 当前模型策略诊断） */
  readonly detailRows: () => readonly SettingItem[];
  /** 工单 02：Codex 模式管理入口行（每次重建重读，值位跟随配置） */
  readonly codexManagementRow: () => SettingItem;
  /** 工单 05：当前会话覆盖读口（内存态） */
  readonly readSessionOverride: () => SessionCompressionOverride;
  /** 工单 05：当前会话覆盖写口（只改内存，不经过配置事务） */
  readonly writeSessionOverride: (next: SessionCompressionOverride) => void;
  /** 关闭面板：回传当前一级行值位文案（没变时回传当前值即可） */
  readonly onDone: (value?: string) => void;
}

/**
 * 模型压缩设置页：内嵌 i18n 设置列表，行集合按配置与内存覆盖实时重建。
 * Esc 返回一级菜单；磁盘值行就地切换后先写盘，写盘成功才重建结构；
 * 当前会话覆盖行只改内存，重建结构但不写盘。
 */
export class CompressionSettingsPanel {
  private readonly options: CompressionSettingsPanelOptions;
  private list: I18nSettingsList | undefined;
  private items: readonly SettingItem[] = [];
  /** 本次面板里 Codex 档位已被拒：从枚举里摘掉，避免取值循环卡在它前面 */
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

  /** 行集合重建：配置或会话覆盖变了就整份换掉（关闭时只剩总开关一行） */
  rebuildItems(selectId?: string): void {
    const sessionOverride = this.options.readSessionOverride();
    this.items = buildCompressionSettingsRows({
      t: this.options.t,
      section: this.options.getSection(),
      sessionOverride,
      // 已被拒时不提供 Codex（否则前进式换档永远转不出 acp）；当前值已是 Codex
      // 时要保留它，值位才能显示文案，而且它的下一档就是跟随全局
      codexOverrideAvailable: sessionOverride === "codex" || !this.codexOverrideRejected,
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

  /**
   * 改动分发：会话覆盖只改内存；三个磁盘行（总开关 / 默认模式 / native 触发策略）
   * 走「先 await saveConfig，成功才重建结构」的同一份时序。没列出的行会被静默
   * return，而原生列表已乐观更新显示——表现为「改了没保存」，新增行必须补分支。
   */
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
    if (id === ROW_NATIVE_TRIGGER) {
      await this.saveDiskRow(
        id,
        NATIVE_TRIGGER_FIELD,
        COMPRESSION_NATIVE_TRIGGER_FIELD,
        compressionNativeTriggerValue(this.options.getSection()),
        value,
      );
      return;
    }
    if (id === ROW_SESSION_OVERRIDE) {
      await this.applySessionOverride(value);
    }
  }

  /**
   * 磁盘配置行的写盘时序（规格「更新时序」）：先保存，成功重建结构；失败提示错误并
   * 恢复前值，面板结构不动。重建时把光标留在同一行，用户能接着改。
   */
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

  /**
   * 当前会话覆盖的就地切换（规格「会话级覆盖」）：不写盘、不进配置事务，改完只
   * 重建行集与重绘。选 codex 时先校验当前模型的 Responses 资格：不满足则拒绝变更、
   * 把行显示恢复前值并给原因（资格口径见 codex/capability.ts）。拒绝后同一次面板里
   * 不再提供 Codex 档位——枚举行只能向前换档，一个永远被拒的档位会把循环卡在它前面。
   */
  private async applySessionOverride(value: string): Promise<void> {
    const t = this.options.t;
    const previous = fieldDisplayValue(t, SESSION_OVERRIDE_FIELD, this.options.readSessionOverride());
    const next = fieldValueFromLabel(t, SESSION_OVERRIDE_FIELD, value);
    if (!isSessionCompressionOverride(next)) {
      this.list?.updateValue(ROW_SESSION_OVERRIDE, previous);
      return;
    }
    if (next === "codex") {
      const rejection = await this.codexOverrideRejection(previous);
      if (rejection !== undefined) {
        this.codexOverrideRejected = true;
        this.options.context.ui.notify(rejection, "warning");
        // 重建而不是就地回滚：行要重新从内存值渲染，同时把不可用的 Codex 档位摘掉
        this.rebuildItems(ROW_SESSION_OVERRIDE);
        this.options.requestRender();
        return;
      }
    }
    this.options.writeSessionOverride(next);
    this.rebuildItems(ROW_SESSION_OVERRIDE);
    this.options.requestRender();
  }

  /** Codex 覆盖的资格校验：不满足时返回拒绝原因文案（已带上前值与具体原因） */
  private async codexOverrideRejection(previous: string): Promise<string | undefined> {
    const t = this.options.t;
    const model = this.options.context.model;
    if (!model) {
      return t("module.compression.sessionOverride.noModel", { previous });
    }
    const capability = await this.readCodexCapability(model);
    if (capability.capable) return undefined;
    return t("module.compression.sessionOverride.codexUnavailable", {
      reason: codexCapabilityLabel(capability, t),
      previous,
    });
  }

  /**
   * 资格探测：有模型注册表时走带鉴权的完整探测（与 Codex 管理页同口径）；宿主没提供
   * 注册表时退回纯地址判定（不取 auth，不抛错）。口径按官方链路（codex/capability.ts）：
   * 中转站即便声明 openai-responses 也不放行——服务端 checkpoint 只有官方链路可靠；
   * 这类模型要 Codex 请走显式规则（Codex 管理页添加），那条路径属 `explicit` 来源。
   */
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

  /** 总开关当前取值：与行显示的归一口径一致（缺失按默认 true） */
  private currentEnabled(): ModuleConfigScalar {
    return compressionEnabledValue(this.options.getSection());
  }
}
