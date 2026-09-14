// 子代理候选池编辑器（工单 47 方案 C）：每档一个分区——头行显示档位名与该档
// 默认思考等级（←→ 循环调整），下面是候选模型行与「＋ 添加模型」行。原生
// SettingsList / SelectList 不支持左右键、排序键、Ctrl+D 待删态，也没有「当前
// 选中行」的读取口，所以这里自绘专用组件（渲染与按键风格照 kit/menu/grouped-list.ts：
// 主题上色、cursor 前缀、(n/m) 滚动提示、i18n 提示行）。
//
// 键位（工单 47 的表）：↑↓ 全行可达（头行也算行）、←→ 调当前行所属档位的思考
// 等级（模型默认 + off…max 循环）、Enter 模型行换模型 / 添加行追加候选（都开
// ChoicePicker）、Shift+↑↓ 当前候选上移/下移（与全局键表无冲突：pi-tui 只绑了
// ctrl+up/ctrl+shift+up 的跳转）、Ctrl+D 进入待删态 → Enter 确认删除（Esc 或
// 移动光标撤销）、Esc 退出面板（有待删态时只撤销待删）。
//
// 写盘语义：每次改动立即落盘——整池替换走 tierPoolPatch（写前校验，空池/非法
// 候选直接抛错，不产生写盘），思考等级走 saveTierThinking；失败只提示，内存
// 取值回读配置节（读侧永远是盘上真相）。档内最后一个候选不可删除（候选池不
// 允许写空，清空档位需直接编辑配置文件）。思考等级属于档位（配置结构是
// thinking.{tier}），显示在头行；模型行只显示模型名。

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
  MODEL_TIERS,
  readSubagentsSection,
  subagentsSectionPath,
  tierPoolPatch,
  tierThinkingPatch,
  THINKING_LEVELS,
  type ModelTier,
  type ThinkingLevel,
  type TierMapping,
  type TierThinkingMapping,
} from "./config.ts";
import type { SubagentsMessageKey } from "./messages/index.ts";

/**
 * 设置界面的档位显示顺序（工单 22）：固定从高到低 deep → balanced → fast。
 * MODEL_TIERS（fast → balanced → deep）仍是校验与报错原文的规范档位清单，
 * 不随显示顺序变化，两份常量各管各的。
 */
export const TIER_DISPLAY_ORDER: readonly ModelTier[] = ["deep", "balanced", "fast"];

/** 档位显示名的 i18n 键：内部键不改名，只在显示层换名 */
export function tierNameKey(tier: ModelTier): SubagentsMessageKey {
  return `module.subagents.tier.name.${tier}`;
}

/** 档位显示名（工单 22）：deep=旗舰模型 / balanced=均衡模型 / fast=快速模型，随语言切换 */
export function tierDisplayName(tier: ModelTier, t: Translator): string {
  return t(tierNameKey(tier));
}

/** 菜单需要的模型注册表能力（取 ModelRegistry 的子集，方便 headless 自测塞 stub） */
export type TierMenuRegistry = Pick<ModelRegistry, "getAll" | "hasConfiguredAuth">;

export interface TierCandidate {
  readonly provider: string;
  readonly modelId: string;
  /** 该供应商已配置认证；只用于排序与候选描述 */
  readonly authenticated: boolean;
}

export function tierCandidateValue(candidate: { provider: string; modelId: string }): string {
  return `${candidate.provider}/${candidate.modelId}`;
}

/** 候选 = 模型目录里的全部模型；已认证的排前面，其余按 provider/model 排序 */
export function discoverTierCandidates(registry: TierMenuRegistry): TierCandidate[] {
  const candidates: TierCandidate[] = [];
  const seen = new Set<string>();
  for (const model of registry.getAll()) {
    const selection = { provider: model.provider, modelId: model.id };
    const key = tierCandidateValue(selection);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ ...selection, authenticated: registry.hasConfiguredAuth(model) });
  }
  candidates.sort((left, right) => {
    if (left.authenticated !== right.authenticated) return left.authenticated ? -1 : 1;
    return tierCandidateValue(left).localeCompare(tierCandidateValue(right));
  });
  return candidates;
}

// ─────────────────────────────────────────────────────────────
// 纯逻辑：面板状态与写盘
// ─────────────────────────────────────────────────────────────

export interface SubagentsPanelState {
  readonly mapping: TierMapping;
  readonly tierThinking: TierThinkingMapping;
  readonly statusEnabled: boolean | undefined;
  readonly problems: readonly string[];
}

export function readPanelState(section: Record<string, unknown>): SubagentsPanelState {
  const view = readSubagentsSection(section);
  return {
    mapping: view.tier,
    tierThinking: view.tierThinking,
    statusEnabled: view.statusEnabled,
    problems: view.problems,
  };
}

/** 档位默认思考等级的显示值：等级代码原样展示，未设置显示“模型默认” */
export function tierThinkingRowValue(
  tier: ModelTier,
  mapping: TierThinkingMapping,
  t: Translator,
): string {
  return mapping[tier] ?? t("module.subagents.tier.thinking.unset");
}

/** 已配置档位计数文案（入口行与退出回执的当前值） */
export function configuredCountValue(mapping: TierMapping, t: Translator): string {
  const configured = MODEL_TIERS.filter((tier) => mapping[tier]).length;
  return t("module.subagents.menu.value", { configured, total: MODEL_TIERS.length });
}

export interface SaveOutcome {
  readonly ok: boolean;
  readonly error?: string;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface SubagentsPanelOptions {
  readonly t: Translator;
  readonly theme: MenuTheme;
  readonly context: ExtensionContext;
  readonly agentDir: string;
  /** 结构化配置写入事务（由菜单层注入，重绘请求也由它带） */
  readonly saveConfig: (patch: ModuleConfigRecord, hooks?: ConfigWriteHooks) => Promise<void>;
  readonly requestRender: () => void;
  /** 读本模块配置节（实时） */
  readonly getSection: () => Record<string, unknown>;
  readonly onDone: (value: string) => void;
}

/**
 * 写一档的完整候选池（工单 47 编辑器写点）：首选在前，顺序即优先级。补丁语义
 * 与写前校验在本模块（tierPoolPatch：空池/非法候选直接抛错），落盘与重载走
 * 配置写入事务。
 */
export async function saveTierPool(
  options: SubagentsPanelOptions,
  tier: ModelTier,
  pool: readonly string[],
): Promise<SaveOutcome> {
  try {
    await options.saveConfig(tierPoolPatch(tier, pool, subagentsSectionPath(options.agentDir)));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

/**
 * 写一档的默认思考等级（工单 23）：level 为 null 表示显式清除（回到模型
 * 自身默认）。补丁语义 + 写前校验在本模块，落盘与重载走配置写入事务。
 */
export async function saveTierThinking(
  options: SubagentsPanelOptions,
  tier: ModelTier,
  level: ThinkingLevel | null,
): Promise<SaveOutcome> {
  try {
    await options.saveConfig(
      tierThinkingPatch(tier, level, subagentsSectionPath(options.agentDir)),
    );
    return { ok: true };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

// ─────────────────────────────────────────────────────────────
// 纯逻辑：行模型与等级循环
// ─────────────────────────────────────────────────────────────

/** 编辑器行：档位头行 / 候选模型行 / 添加模型行 */
export type PoolEditorRow =
  | { readonly kind: "tier"; readonly tier: ModelTier }
  | { readonly kind: "model"; readonly tier: ModelTier; readonly index: number }
  | { readonly kind: "add"; readonly tier: ModelTier };

/** 行 id（自测用）：subagents.pool.<tier> / .model.<n> / .add */
export function poolEditorRowId(row: PoolEditorRow): string {
  switch (row.kind) {
    case "tier":
      return `subagents.pool.${row.tier}`;
    case "model":
      return `subagents.pool.${row.tier}.model.${row.index}`;
    case "add":
      return `subagents.pool.${row.tier}.add`;
  }
}

/** 行序列（渲染顺序）：按显示顺序每档 头行 + 候选行 + 添加行 */
export function buildPoolEditorRows(mapping: TierMapping): PoolEditorRow[] {
  const rows: PoolEditorRow[] = [];
  for (const tier of TIER_DISPLAY_ORDER) {
    rows.push({ kind: "tier", tier });
    const pool = mapping[tier] ?? [];
    for (let index = 0; index < pool.length; index += 1) {
      rows.push({ kind: "model", tier, index });
    }
    rows.push({ kind: "add", tier });
  }
  return rows;
}

/** 行 id 序列（自测用）：结构断言走这里 */
export function poolEditorRowIds(mapping: TierMapping): string[] {
  return buildPoolEditorRows(mapping).map(poolEditorRowId);
}

/** ←→ 的思考等级循环次序：模型默认 + off…max（与档位等级行的选择项同集） */
const THINKING_CYCLE: readonly (ThinkingLevel | null)[] = [null, ...THINKING_LEVELS];

/** 等级循环一步：→ 升一档（max 后回模型默认），← 降一档；未知当前值按模型默认起步 */
export function nextThinkingLevel(current: ThinkingLevel | null, step: 1 | -1): ThinkingLevel | null {
  const index = THINKING_CYCLE.indexOf(current);
  const next = (index + step + THINKING_CYCLE.length) % THINKING_CYCLE.length;
  return THINKING_CYCLE[next] ?? null;
}

/** 候选上移/下移：与相邻候选交换顺序；已在边界返回 null（调用方不写盘） */
export function poolAfterMove(pool: readonly string[], index: number, step: 1 | -1): string[] | null {
  const target = index + step;
  if (target < 0 || target >= pool.length) return null;
  const next = [...pool];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

// ─────────────────────────────────────────────────────────────
// UI：候选池编辑器面板
// ─────────────────────────────────────────────────────────────

/** 待删态：记档位、下标与模型值，写盘刷新后失配即自动撤销 */
interface PendingDelete {
  readonly tier: ModelTier;
  readonly index: number;
  readonly model: string;
}

export class SubagentsPanel implements Component {
  private readonly options: SubagentsPanelOptions;
  private readonly candidates: TierCandidate[];
  private state: SubagentsPanelState;
  private rows: PoolEditorRow[];
  private selectedIndex = 0;
  private pendingDelete: PendingDelete | null = null;
  private submenu: Component | null = null;
  private readonly maxVisible = 10;

  constructor(options: SubagentsPanelOptions) {
    this.options = options;
    this.candidates = discoverTierCandidates(options.context.modelRegistry);
    this.state = readPanelState(options.getSection());
    this.rows = buildPoolEditorRows(this.state.mapping);
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
    if (matchesKey(data, "shift+up")) {
      void this.moveCandidate(-1);
    } else if (matchesKey(data, "shift+down")) {
      void this.moveCandidate(1);
    } else if (kb.matches(data, "tui.select.up")) {
      this.moveSelection(-1);
    } else if (kb.matches(data, "tui.select.down")) {
      this.moveSelection(1);
    } else if (matchesKey(data, "left")) {
      void this.adjustThinking(-1);
    } else if (matchesKey(data, "right")) {
      void this.adjustThinking(1);
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
    this.options.onDone(configuredCountValue(this.state.mapping, this.options.t));
  }

  private notify(message: string): void {
    this.options.context.ui.notify(message, "error");
  }

  /** 写盘失败只提示，不改任何取值（读侧回读配置节，天然是盘上真相） */
  private reportSave(outcome: SaveOutcome): void {
    if (outcome.ok) return;
    this.notify(this.options.t("notify.saveFailed", { reason: outcome.error ?? "" }));
  }

  /**
   * 写盘成功后回读配置节并重建行。selectRowId 指定刷新后光标落点（找不到时
   * 按当前下标收缩）；待删行与盘上内容失配（模型变了/下标没了）自动撤销。
   */
  private refresh(selectRowId?: string): void {
    this.state = readPanelState(this.options.getSection());
    this.rows = buildPoolEditorRows(this.state.mapping);
    const target =
      selectRowId === undefined ? -1 : this.rows.findIndex((row) => poolEditorRowId(row) === selectRowId);
    this.selectedIndex =
      target >= 0 ? target : Math.min(this.selectedIndex, this.rows.length - 1);
    if (this.pendingDelete) {
      const pool = this.state.mapping[this.pendingDelete.tier];
      if (!pool || pool[this.pendingDelete.index] !== this.pendingDelete.model) {
        this.pendingDelete = null;
      }
    }
    this.options.requestRender();
  }

  private currentRow(): PoolEditorRow | undefined {
    return this.rows[this.selectedIndex];
  }

  /** 把光标移到指定行 id（找不到返回 false）；自测与外部定位用 */
  selectRow(id: string): boolean {
    const index = this.rows.findIndex((row) => poolEditorRowId(row) === id);
    if (index === -1) return false;
    this.selectedIndex = index;
    this.pendingDelete = null;
    return true;
  }

  /** 当前光标行的 id（空面板返回空串；自测用） */
  currentRowId(): string {
    const row = this.rows[this.selectedIndex];
    return row ? poolEditorRowId(row) : "";
  }

  /** ↑↓/滚轮：全行可达（头行、模型行、添加行），首尾循环；移动即撤销待删态 */
  private moveSelection(step: 1 | -1): void {
    if (this.rows.length === 0) return;
    const next = (this.selectedIndex + step + this.rows.length) % this.rows.length;
    if (next !== this.selectedIndex) {
      this.selectedIndex = next;
      this.pendingDelete = null;
    }
    this.options.requestRender();
  }

  /** ←→：调整当前行所属档位的默认思考等级（循环）并立即写盘 */
  private async adjustThinking(step: 1 | -1): Promise<void> {
    const row = this.currentRow();
    if (!row) return;
    const current = this.state.tierThinking[row.tier] ?? null;
    const level = nextThinkingLevel(current, step);
    const outcome = await saveTierThinking(this.options, row.tier, level);
    this.reportSave(outcome);
    if (outcome.ok) this.refresh(poolEditorRowId(row));
  }

  /**
   * Enter/空格/点击：待删行确认删除；模型行开选择器换模型；添加行开选择器
   * 追加候选；头行无激活行为（等级调整走 ←→）。
   */
  private activate(): void {
    const row = this.currentRow();
    if (!row) return;
    if (
      row.kind === "model" &&
      this.pendingDelete &&
      this.pendingDelete.tier === row.tier &&
      this.pendingDelete.index === row.index
    ) {
      void this.confirmDelete(row);
      return;
    }
    this.pendingDelete = null;
    if (row.kind !== "tier") this.openModelPicker(row);
  }

  /** Ctrl+D：模型行进入/撤销待删态（再按一次撤销）；其它行无反应 */
  private toggleDeleteArm(): void {
    const row = this.currentRow();
    if (!row || row.kind !== "model") return;
    if (
      this.pendingDelete &&
      this.pendingDelete.tier === row.tier &&
      this.pendingDelete.index === row.index
    ) {
      this.pendingDelete = null;
    } else {
      this.pendingDelete = {
        tier: row.tier,
        index: row.index,
        model: this.state.mapping[row.tier]?.[row.index] ?? "",
      };
    }
    this.options.requestRender();
  }

  /** 待删确认：写掉该候选。档内最后一个候选拒绝删除（不允许写出空池） */
  private async confirmDelete(row: { readonly tier: ModelTier; readonly index: number }): Promise<void> {
    const pool = readPanelState(this.options.getSection()).mapping[row.tier] ?? [];
    if (pool.length <= 1) {
      this.notify(this.options.t("module.subagents.pool.lastCandidate"));
      this.pendingDelete = null;
      this.options.requestRender();
      return;
    }
    const outcome = await saveTierPool(
      this.options,
      row.tier,
      pool.filter((_, index) => index !== row.index),
    );
    this.reportSave(outcome);
    if (outcome.ok) {
      this.pendingDelete = null;
      // 光标按当前下标收缩：落在顶上来的下一候选或添加行
      this.refresh();
    }
  }

  /** Shift+↑↓：当前候选与相邻候选交换（边界不动），写盘后光标跟随候选 */
  private async moveCandidate(step: 1 | -1): Promise<void> {
    const row = this.currentRow();
    if (!row || row.kind !== "model") return;
    const pool = readPanelState(this.options.getSection()).mapping[row.tier] ?? [];
    const nextPool = poolAfterMove(pool, row.index, step);
    if (!nextPool) return;
    const outcome = await saveTierPool(this.options, row.tier, nextPool);
    this.reportSave(outcome);
    if (outcome.ok) {
      this.pendingDelete = null;
      this.refresh(`subagents.pool.${row.tier}.model.${row.index + step}`);
    }
  }

  /** 开模型选择器：模型行换模型，添加行追加候选（选择项 = 模型目录全集） */
  private openModelPicker(row: { readonly kind: "model" | "add"; readonly tier: ModelTier; readonly index?: number }): void {
    const t = this.options.t;
    const tierName = tierDisplayName(row.tier, t);
    this.submenu = new ChoicePicker({
      title:
        row.kind === "model"
          ? t("module.subagents.pool.replaceTitle", { tier: tierName })
          : t("module.subagents.pool.addTitle", { tier: tierName }),
      theme: this.options.theme,
      t,
      options: this.candidates.map((candidate) => ({
        value: tierCandidateValue(candidate),
        label: tierCandidateValue(candidate),
        description: candidate.authenticated
          ? t("module.subagents.tier.authenticated")
          : t("module.subagents.tier.noAuthRequired"),
      })),
      onSelect: (value) => {
        this.submenu = null;
        // 早退路径（重选同模型）不会触发后续 refresh，这里显式请求一帧，
        // 保证选择器立刻从渲染里消失
        this.options.requestRender();
        void this.applyModelSelection(row, value);
      },
      onCancel: () => {
        this.submenu = null;
        this.options.requestRender();
      },
    });
    this.options.requestRender();
  }

  /** 选择器落选：换指定下标的模型 / 追加到池尾；目标已在池中时拒绝（不产生重复候选） */
  private async applyModelSelection(
    row: { readonly kind: "model" | "add"; readonly tier: ModelTier; readonly index?: number },
    model: string,
  ): Promise<void> {
    const t = this.options.t;
    const pool = readPanelState(this.options.getSection()).mapping[row.tier] ?? [];
    if (row.kind === "model" && row.index !== undefined) {
      if (pool[row.index] === model) return;
      if (pool.includes(model)) {
        this.notify(t("module.subagents.pool.duplicate", { model }));
        return;
      }
      const nextPool = [...pool];
      nextPool[row.index] = model;
      const outcome = await saveTierPool(this.options, row.tier, nextPool);
      this.reportSave(outcome);
      if (outcome.ok) {
        this.pendingDelete = null;
        this.refresh(`subagents.pool.${row.tier}.model.${row.index}`);
      }
    } else {
      if (pool.includes(model)) {
        this.notify(t("module.subagents.pool.duplicate", { model }));
        return;
      }
      const outcome = await saveTierPool(this.options, row.tier, [...pool, model]);
      this.reportSave(outcome);
      if (outcome.ok) {
        this.pendingDelete = null;
        this.refresh(`subagents.pool.${row.tier}.model.${pool.length}`);
      }
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
    lines.push(truncateToWidth(this.options.theme.hint(this.options.t("module.subagents.pool.hint")), width));
    return lines;
  }

  private renderRow(row: PoolEditorRow, selected: boolean, width: number): string {
    const t = this.options.t;
    const theme = this.options.theme;
    const prefix = selected ? theme.settings.cursor : "  ";
    if (row.kind === "tier") {
      const label = theme.title(tierDisplayName(row.tier, t));
      const level = t("module.subagents.pool.thinking", {
        level: tierThinkingRowValue(row.tier, this.state.tierThinking, t),
      });
      const value = theme.settings.value(level, selected);
      const pad = Math.max(1, width - visibleWidth(prefix) - visibleWidth(label) - visibleWidth(value));
      return truncateToWidth(prefix + label + " ".repeat(pad) + value, width);
    }
    if (row.kind === "add") {
      return truncateToWidth(prefix + "  " + theme.hint(t("module.subagents.pool.add")), width);
    }
    const model = this.state.mapping[row.tier]?.[row.index] ?? "";
    const armed =
      this.pendingDelete !== null &&
      this.pendingDelete.tier === row.tier &&
      this.pendingDelete.index === row.index;
    const body = armed
      ? theme.fg("error", model) + theme.hint(` · ${t("module.subagents.pool.deleteArmed")}`)
      : theme.settings.label(model, selected);
    return truncateToWidth(prefix + "  " + body, width);
  }
}
