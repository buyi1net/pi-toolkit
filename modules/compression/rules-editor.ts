// 压缩模型规则编辑器（工单 02）：从当前模型目录选择完整 provider/model 身份，
// 配出压缩模式（codex 再选协议，codex 规则下方另给 profile 与 onUnsupported
// 两个参数子行），保存/删除经 kit 配置写入事务落盘。
//
// 先例：modules/subagents/menu.ts 的候选池编辑器（自绘面板 + ChoicePicker）。
// 原生 SettingsList 不支持 Ctrl+D 待删态与「当前选中行」读取口，规则是结构化
// 对象（规格：菜单 schema 只放开关和有限枚举），所以走模块自己的编辑页。
//
// 键位：↑↓ 全行可达、Enter 规则行改模式（codex 跟进协议选择）/ codex 参数行改
// profile 或 onUnsupported / 添加行开模型选择器、Ctrl+D 进入待删态 → Enter
// 确认删除（Esc 或移动光标撤销）、Esc 退出。
// 写盘语义：每次改动立即落盘（modelRulesPatch 写前校验），失败只提示，读侧
// 永远回读配置节（盘上真相）。规则可以删到零条（空规则列表合法）。

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

/** 菜单需要的模型注册表能力（取子集，方便 headless 自测塞 stub） */
export type CompressionMenuRegistry = Pick<ModelRegistry, "getAll">;

/** 模型目录里的候选：完整 provider/model 身份 + 目录声明的元数据 */
export interface CompressionModelCandidate {
  readonly provider: string;
  readonly modelId: string;
  readonly api: string | undefined;
  readonly baseUrl: string | undefined;
  readonly contextWindow: number | undefined;
}

/**
 * 候选 = 模型目录里的全部模型（完整 provider/model 身份，不手写模型名做主键）。
 * 同一 provider/model 去重（保留首条的元数据）；按 provider/model 字典序排序。
 */
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

/** 候选 → 策略解析的模型身份。 */
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

/** Pi 的会话模型 → 模型身份（结构收敛在模块内）。 */
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

/**
 * 规则与候选是否同一身份（规范化比较：id 去空白、baseUrl 按规范化键）。
 * 注意：基础编辑器写入的规则不带可选约束，重复判定用裸身份（不传 api /
 * baseUrl 的候选形状）——带约束的旧规则与裸新规则是不同精度，允许共存。
 */
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

/**
 * 改规则的模式（编辑器写点之一）：身份约束（provider/model/api/baseUrl）保持不变；
 * 离开 codex 时剥掉 Codex 参数（protocol/profile/onUnsupported 不再有意义），
 * 留在 codex 时保留原有 profile / onUnsupported，protocol 由本次选择给出。
 */
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

/** codex 规则的两个可编辑参数（子行）：Responses 兼容声明与不支持时策略 */
export type CodexRuleParam = "profile" | "onUnsupported";

/**
 * 改规则的 profile（编辑器写点之一）：其余字段全部不变；undefined = 剥掉该键
 * （生效口径回到「按 API 推导」）。编辑器只写合法枚举值，手工配置的自定义
 * 字符串在回读时原样显示，重选即可替换。
 */
export function withRuleProfile(
  rule: CompressionModelRule,
  profile: string | undefined,
): CompressionModelRule {
  return mergeCodexParams(rule, profile, rule.onUnsupported);
}

/** 改规则的不支持时策略（编辑器写点之一）：其余字段全部不变；undefined = 剥掉该键（生效默认 native） */
export function withRuleOnUnsupported(
  rule: CompressionModelRule,
  policy: CodexUnsupportedPolicy | undefined,
): CompressionModelRule {
  return mergeCodexParams(rule, rule.profile, policy);
}

/** codex 参数归一重建：两个可选键同时展开，未提供的不落键 */
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

/** 规则行值位：模式名（codex 追加生效协议） */
export function ruleRowValue(rule: CompressionModelRule, t: Translator): string {
  const mode = compressionModeLabel(rule.mode, t);
  if (rule.mode !== "codex") return mode;
  return `${mode} · ${codexProtocolLabel(rule.protocol, t)}`;
}

/** codex 参数子行值位：profile 显示声明值（未指定显示推导口径），onUnsupported 显示策略（未指定显示默认 native） */
export function codexParamRowValue(rule: CompressionModelRule, param: CodexRuleParam, t: Translator): string {
  if (param === "profile") {
    return rule.profile === undefined ? t("module.compression.rules.profile.unset") : rule.profile;
  }
  return rule.onUnsupported === undefined
    ? t("module.compression.rules.onUnsupported.unset")
    : t(`module.compression.rules.onUnsupported.${rule.onUnsupported}`);
}

/** 已配置规则数文案（入口行与退出回执的当前值） */
export function rulesCountValue(count: number, t: Translator): string {
  return count === 0
    ? t("module.compression.rules.value.none")
    : t("module.compression.rules.value.configured", { count });
}

// ─────────────────────────────────────────────────────────────
// 写盘
// ─────────────────────────────────────────────────────────────

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
  /** 结构化配置写入事务（菜单层注入，重绘请求也由它带） */
  readonly saveConfig: (patch: ModuleConfigRecord, hooks?: ConfigWriteHooks) => Promise<void>;
  readonly requestRender: () => void;
  /** 读本模块配置节（实时，盘上真相） */
  readonly getSection: () => Record<string, unknown>;
  readonly onDone: (value: string) => void;
}

/** 写整组模型规则（补丁语义与写前校验在 modelRulesPatch） */
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

/** 当前的规则与配置问题（读侧统一走 readCompressionSettings） */
export function readRulesState(section: Record<string, unknown>): {
  readonly rules: readonly CompressionModelRule[];
  readonly problems: readonly unknown[];
} {
  const { settings, problems } = readCompressionSettings(section);
  return { rules: settings.modelRules, problems };
}

// ─────────────────────────────────────────────────────────────
// 行模型
// ─────────────────────────────────────────────────────────────

/** 编辑器行：规则行 / codex 参数子行 / 添加规则行 */
export type RulesEditorRow =
  | { readonly kind: "rule"; readonly index: number }
  | { readonly kind: "codexParam"; readonly index: number; readonly param: CodexRuleParam }
  | { readonly kind: "add" };

/** 行 id（自测用）：compression.rules.rule.<n>[.profile|.onUnsupported] / compression.rules.add */
export function rulesEditorRowId(row: RulesEditorRow): string {
  if (row.kind === "rule") return `compression.rules.rule.${row.index}`;
  if (row.kind === "codexParam") return `compression.rules.rule.${row.index}.${row.param}`;
  return "compression.rules.add";
}

/** 行序列（渲染顺序）：规则行在前（codex 规则跟 profile / onUnsupported 两个子行），添加行收尾 */
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

/** 行 id 序列（自测用）：结构断言走这里 */
export function rulesEditorRowIds(rules: readonly CompressionModelRule[]): string[] {
  return buildRulesEditorRows(rules).map(rulesEditorRowId);
}

// ─────────────────────────────────────────────────────────────
// UI：规则编辑器面板
// ─────────────────────────────────────────────────────────────

/** 待删态：记下标与规则身份，写盘刷新后失配即自动撤销 */
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
    // 选择器打开期间输入全部委托给它；它的 Esc 经 onCancel 回到这里关闭
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

  /** 写盘失败只提示，不改任何取值（读侧回读配置节，天然是盘上真相） */
  private reportSave(outcome: SaveOutcome): void {
    if (outcome.ok) return;
    this.notify(this.options.t("notify.saveFailed", { reason: outcome.error ?? "" }));
  }

  /** 写盘成功后回读配置节并重建行；selectRowId 指定刷新后的光标落点 */
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

  /** 把光标移到指定行 id（找不到返回 false）；自测与外部定位用 */
  selectRow(id: string): boolean {
    const index = this.rows.findIndex((row) => rulesEditorRowId(row) === id);
    if (index === -1) return false;
    this.selectedIndex = index;
    this.pendingDelete = null;
    return true;
  }

  /** 当前光标行的 id（空面板返回空串；自测用） */
  currentRowId(): string {
    const row = this.rows[this.selectedIndex];
    return row ? rulesEditorRowId(row) : "";
  }

  /** ↑↓/滚轮：全行可达，首尾循环；移动即撤销待删态 */
  private moveSelection(step: 1 | -1): void {
    if (this.rows.length === 0) return;
    const next = (this.selectedIndex + step + this.rows.length) % this.rows.length;
    if (next !== this.selectedIndex) {
      this.selectedIndex = next;
      this.pendingDelete = null;
    }
    this.options.requestRender();
  }

  /** Enter/空格/点击：待删行确认删除；规则行开模式选择；添加行开模型选择 */
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

  /** Ctrl+D：规则行进入/撤销待删态（再按一次撤销）；其它行无反应 */
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

  /** 待删确认：删除该规则（允许删到零条，空规则列表合法） */
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

  /** 开模式选择器：选定后经 applyModeEdit 写盘；codex 再跟进协议选择 */
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

  /** 开 Codex 协议选择器：默认条目 = 不写 protocol（生效产品默认） */
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

  /**
   * 开 codex 参数选择器（profile / onUnsupported）：默认条目 = 不写该键
   * （profile 生效「按 API 推导」、onUnsupported 生效默认 native）；远程请求
   * 限制的说明在编辑页底部的提示行（codexRemoteNote），不在选择器里重复。
   */
  private openCodexParamPicker(index: number, param: CodexRuleParam): void {
    const t = this.options.t;
    const rule = this.rules[index];
    if (!rule || rule.mode !== "codex") return; // 模式已变（写盘刷新后子行消失）
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

  /** 模式/协议落选：重建该规则并整组写盘 */
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

  /** codex 参数落选：按 update 重建该规则并整组写盘（规则已非 codex 时不动） */
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

  /** 开模型选择器（添加行）：选择项 = 模型目录全集的完整 provider/model 身份 */
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

  /** 新规则的模式选择 → codex 再选协议 → 追加写盘 */
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

  /** 追加规则：与新规则同身份（基础编辑器只写裸身份）的规则已存在时拒绝，不产生写盘 */
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

  // ── 渲染 ────────────────────────────────────────────────

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
      // 远程请求限制的如实说明：仅在页面上存在 codex 规则时展示，不造假开关
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
