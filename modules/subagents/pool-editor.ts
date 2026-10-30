// 子代理候选池编辑器：每档一个分区，显示候选模型行与「＋ 添加模型」行。原生
// SettingsList / SelectList 不支持排序键、Ctrl+D 待删态，也没有「当前选中行」的
// 读取口，所以这里自绘专用组件。模型候选的思考等级后缀仍由模型选择器按宿主
// 能力提供；档位本身不再保存默认思考等级。
//
// 键位：↑↓ 全行可达、Enter 模型行换模型 / 添加行追加候选、Shift+↑↓ 当前候选
// 上移/下移、Ctrl+D 进入待删态、Esc 退出面板。
//
// 写盘语义：每次改动立即落盘——整池替换走 tierPoolPatch；失败只提示，内存
// 取值回读配置节（读侧永远是盘上真相）。档内最后一个候选不可删除。
//
// 生效值读侧（工单 05）：面板显示的候选池与思考等级改读工单 00 的单一读口
// （loadEffectiveTierConfig，与 spawn 同一份），不再只看本节——菜单显示的
// 池从此与 spawn 实际读到的一致。生效来源不是本节的档（更高/更低的
// pi-subagents 配置层）显示来源并锁定为只读，提供「接管」行把生效值显式
// 写进本节；本节存在混合合法/非法档时整个编辑器锁进错误态（写盘深合并
// 清不掉非法 sibling，编辑合法档只会制造「部分正常」的假象），修复配置
// 文件后自动恢复。PI_SUBAGENTS_CONFIG 锁定整条链时同样只读（本节写盘
// 不会生效，也不提供接管）。

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
import { ChoicePicker, type ChoiceOption } from "../../kit/menu/panels.ts";
import type { MenuTheme } from "../../kit/menu/theme.ts";
import type { ModuleConfigRecord } from "../../kit/module.ts";
import {
  MODEL_TIERS,
  readSubagentsSection,
  subagentsSectionPath,
  tierPoolPatch,
  tierTakeoverPatch,
  tierThinkingPatch,
  THINKING_LEVELS,
  type ModelTier,
  type ThinkingLevel,
  type TierConfigLoadResult,
  type TierMapping,
  type TierThinkingMapping,
} from "./config.ts";
import { findDuplicateBaseRef } from "./routing.ts";
import { supportedThinkingLevels } from "./model-selector.ts";
import type { SubagentsMessageKey } from "./messages/index.ts";

/**
 * 设置界面的档位显示顺序（工单 22）：固定从高到低 flagship → balanced → fast。
 * MODEL_TIERS（fast → balanced → flagship）仍是校验与报错原文的规范档位清单，
 * 不随显示顺序变化，两份常量各管各的。
 */
export const TIER_DISPLAY_ORDER: readonly ModelTier[] = ["flagship", "balanced", "fast"];

/** 档位显示名的 i18n 键：内部键不改名，只在显示层换名 */
export function tierNameKey(tier: ModelTier): SubagentsMessageKey {
  return `module.subagents.tier.name.${tier}`;
}

/** 档位显示名（工单 22）：flagship=旗舰模型 / balanced=均衡模型 / fast=快速模型，随语言切换 */
export function tierDisplayName(tier: ModelTier, t: Translator): string {
  return t(tierNameKey(tier));
}

/** 菜单需要的模型注册表能力（取 ModelRegistry 的子集，方便 headless 自测塞 stub） */
export type TierMenuRegistry = Pick<ModelRegistry, "getAll" | "hasConfiguredAuth">;

export interface TierCandidate {
  readonly provider: string;
  readonly modelId: string;
  /** 该供应商已配置认证；工单 09 起默认列表只收已认证，未认证折叠进显式入口 */
  readonly authenticated: boolean;
  /** 目录核验的该模型支持思考等级（复用 model-selector 的口径），供后缀写入口过滤 */
  readonly supportedThinking: readonly string[];
}

export function tierCandidateValue(candidate: { provider: string; modelId: string }): string {
  return `${candidate.provider}/${candidate.modelId}`;
}

/** 候选 = 模型目录里的全部模型（凭据分组在挑选器里消费）；已认证的排前面，其余按 provider/model 排序 */
export function discoverTierCandidates(registry: TierMenuRegistry): TierCandidate[] {
  const candidates: TierCandidate[] = [];
  const seen = new Set<string>();
  for (const model of registry.getAll()) {
    const selection = { provider: model.provider, modelId: model.id };
    const key = tierCandidateValue(selection);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      ...selection,
      authenticated: registry.hasConfiguredAuth(model),
      supportedThinking: supportedThinkingLevels(model),
    });
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
  /** 本节 models/thinking 树的逐档问题（工单 05 编辑器锁定条件） */
  readonly tierProblems: readonly string[];
}

export function readPanelState(section: Record<string, unknown>): SubagentsPanelState {
  const view = readSubagentsSection(section);
  return {
    mapping: view.tier,
    tierThinking: view.tierThinking,
    statusEnabled: view.statusEnabled,
    problems: view.problems,
    tierProblems: view.tierProblems,
  };
}

// ─────────────────────────────────────────────────────────────
// 单一读口视图（工单 05）：生效值 + 生效来源 + 归属分类
// ─────────────────────────────────────────────────────────────

/** 档位生效池的归属：本节 / 其它配置层 / 任何层都未配置 */
export type TierPoolOwnership = "local" | "foreign" | "unconfigured";

/** 单一读口下单个档的编辑器视图 */
export interface TierEditorView {
  /** 该档生效候选池（unconfigured 为空数组）；与 spawn 读到的同一份 */
  readonly pool: readonly string[];
  readonly ownership: TierPoolOwnership;
  /** 生效池来源（unconfigured 为 null） */
  readonly poolSource: string | null;
  /** 生效思考等级；undefined = 未生效（null 墓碑显式清除或从未声明） */
  readonly thinking: ThinkingLevel | undefined;
  readonly thinkingSource: string | null;
  /** 本节写该档思考等级能否生效（来源不在更高优先级层且链未被环境变量锁定） */
  readonly thinkingEditable: boolean;
}

/** 面板读到的单一读口视图（工单 05） */
export interface EffectivePanelView {
  /** 逐档视图（fast/balanced/flagship 三键恒存在） */
  readonly tiers: Readonly<Record<ModelTier, TierEditorView>>;
  /** PI_SUBAGENTS_CONFIG 锁定整条链：本节任何写盘都不会生效 */
  readonly envLocked: boolean;
  /** 生效链问题清单（各层逐档问题；单一读口原样透出） */
  readonly chainProblems: readonly string[];
}

/**
 * 把单一读口的结果整理成编辑器视图：按生效池来源分本节 / 其它层 / 未配置
 * 三类归属。思考等级与池的来源相互独立（逐档合并各自取最高优先级层），
 * 可编辑性也各自判定。
 */
export function buildEffectivePanelView(input: {
  readonly effective: TierConfigLoadResult;
  readonly localSource: string;
}): EffectivePanelView {
  const envLocked = input.effective.sourcePath !== null;
  const tiers = {} as Record<ModelTier, TierEditorView>;
  for (const tier of MODEL_TIERS) {
    const route = input.effective.config?.tiers[tier];
    const pool = route?.pool ?? [];
    const poolSource = route?.poolSource ?? null;
    const ownership: TierPoolOwnership =
      poolSource === null ? "unconfigured" : poolSource === input.localSource ? "local" : "foreign";
    tiers[tier] = {
      pool,
      ownership,
      poolSource,
      // 旧配置中的 thinking.* 不再进入模型池编辑器。
      thinking: undefined,
      thinkingSource: null,
      thinkingEditable: true,
    };
  }
  return {
    tiers,
    envLocked,
    chainProblems: input.effective.config?.problems ?? [],
  };
}

/** 某档的池能否在本节直接编辑：本节声明或任何层都未配置，且链未被环境变量锁定 */
export function tierPoolEditable(view: EffectivePanelView, tier: ModelTier): boolean {
  const ownership = view.tiers[tier].ownership;
  return !view.envLocked && (ownership === "local" || ownership === "unconfigured");
}

/**
 * 某档是否有生效值不在本节（池或思考等级任一）：菜单明示外层生效档与编辑器
 * 接管行的判定其用这一个口径。
 */
export function tierForeignEffective(view: EffectivePanelView, tier: ModelTier): boolean {
  return view.tiers[tier].ownership === "foreign";
}

/** 从视图提取生效池映射（退出回执计数等 TierMapping 消费方用） */
export function effectiveMappingFromView(view: EffectivePanelView): TierMapping {
  const mapping: TierMapping = {};
  for (const tier of MODEL_TIERS) {
    const pool = view.tiers[tier].pool;
    if (pool.length > 0) mapping[tier] = [...pool];
  }
  return mapping;
}

/** 从视图提取生效思考等级映射（头行显示用；墓碑与未声明都按未设置展示） */
export function effectiveThinkingMapping(view: EffectivePanelView): TierThinkingMapping {
  const mapping: TierThinkingMapping = {};
  for (const tier of MODEL_TIERS) {
    const level = view.tiers[tier].thinking;
    if (level !== undefined) mapping[tier] = level;
  }
  return mapping;
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
  /**
   * 单一读口装载（工单 05）：面板显示的生效池/思考等级/来源/问题清单都从
   * 这里读（菜单层接 loadEffectiveTierConfig，测试注入替身）。
   */
  readonly loadEffective: () => TierConfigLoadResult;
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

/**
 * 显式接管（工单 05）：把一档当前生效的候选池连同生效思考等级写进本节，
 * 让本节成为该档的声明层。thinking 传 undefined 表示任何层都没声明过
 * （不写 thinking 键）；传 null 写显式清除墓碑。补丁语义与写前校验在
 * config.ts 的 tierTakeoverPatch，落盘与重载走配置写入事务。
 */
export async function saveTierTakeover(
  options: SubagentsPanelOptions,
  tier: ModelTier,
  pool: readonly string[],
  thinking: ThinkingLevel | null | undefined,
): Promise<SaveOutcome> {
  try {
    await options.saveConfig(
      tierTakeoverPatch(tier, pool, thinking, subagentsSectionPath(options.agentDir)),
    );
    return { ok: true };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

// ─────────────────────────────────────────────────────────────
// 纯逻辑：行模型与等级循环
// ─────────────────────────────────────────────────────────────

/** 编辑器行：档位头行 / 候选模型行 / 添加模型行 / 接管行（外层生效档） */
export type PoolEditorRow =
  | { readonly kind: "tier"; readonly tier: ModelTier }
  | { readonly kind: "model"; readonly tier: ModelTier; readonly index: number }
  | { readonly kind: "add"; readonly tier: ModelTier }
  | { readonly kind: "takeover"; readonly tier: ModelTier };

/** 行 id（自测用）：subagents.pool.<tier> / .model.<n> / .add / .takeover */
export function poolEditorRowId(row: PoolEditorRow): string {
  switch (row.kind) {
    case "tier":
      return `subagents.pool.${row.tier}`;
    case "model":
      return `subagents.pool.${row.tier}.model.${row.index}`;
    case "add":
      return `subagents.pool.${row.tier}.add`;
    case "takeover":
      return `subagents.pool.${row.tier}.takeover`;
  }
}

/**
 * 行序列（渲染顺序）：按显示顺序每档 头行 + 候选行 + 可编辑档的添加行；
 * 池或思考等级任一生效值不在本节的档追加接管行（池仍可编辑时两种行并存）。
 * 链被环境变量锁定时既不可编辑也不可接管，只剩头行与候选行。
 */
export function buildPoolEditorRows(view: EffectivePanelView): PoolEditorRow[] {
  const rows: PoolEditorRow[] = [];
  for (const tier of TIER_DISPLAY_ORDER) {
    const tierView = view.tiers[tier];
    rows.push({ kind: "tier", tier });
    for (let index = 0; index < tierView.pool.length; index += 1) {
      rows.push({ kind: "model", tier, index });
    }
    if (tierPoolEditable(view, tier)) {
      rows.push({ kind: "add", tier });
    }
    if (!view.envLocked && tierForeignEffective(view, tier)) {
      rows.push({ kind: "takeover", tier });
    }
  }
  return rows;
}

/** 行 id 序列（自测用）：结构断言走这里 */
export function poolEditorRowIds(view: EffectivePanelView): string[] {
  return buildPoolEditorRows(view).map(poolEditorRowId);
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

/** 展开未认证模型的显式入口值（provider/id 形态的候选值不可能与之相等） */
const SHOW_UNAUTHENTICATED_MODELS = "__show_unauthenticated__";

/** 待删态：记档位、下标与模型值，写盘刷新后失配即自动撤销 */
interface PendingDelete {
  readonly tier: ModelTier;
  readonly index: number;
  readonly model: string;
}

export class SubagentsPanel implements Component {
  private readonly options: SubagentsPanelOptions;
  private readonly candidates: TierCandidate[];
  private local: SubagentsPanelState;
  private loadResult: TierConfigLoadResult;
  private view: EffectivePanelView;
  private rows: PoolEditorRow[];
  private selectedIndex = 0;
  private pendingDelete: PendingDelete | null = null;
  private submenu: Component | null = null;
  private readonly maxVisible = 10;

  constructor(options: SubagentsPanelOptions) {
    this.options = options;
    this.candidates = discoverTierCandidates(options.context.modelRegistry);
    this.local = readPanelState(options.getSection());
    this.loadResult = options.loadEffective();
    this.view = this.buildView();
    this.rows = buildPoolEditorRows(this.view);
  }

  /** 单一读口 → 面板视图（刷新时重建）；本节来源与宿主注入层同一字符串 */
  private buildView(): EffectivePanelView {
    return buildEffectivePanelView({
      effective: this.loadResult,
      localSource: subagentsSectionPath(this.options.agentDir),
    });
  }

  /** 生效配置装载硬错误（环境变量锁定文件缺失/非法等）：整个面板只退不可编辑 */
  private get loadFailed(): boolean {
    return this.loadResult.config === null;
  }

  /** 本节存在混合合法/非法档（工单 05）：编辑器锁进错误态，不假装可编辑 */
  private get locked(): boolean {
    return this.local.tierProblems.length > 0;
  }

  render(width: number): string[] {
    if (this.submenu) return this.submenu.render(width);
    if (this.loadFailed) return this.renderLoadError(width);
    if (this.locked) return this.renderLocked(width);
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
    // 锁定态 / 装载硬错误态（工单 05）：不可编辑，只有 Esc 退出
    if (this.locked || this.loadFailed) {
      if (kb.matches(data, "tui.select.cancel")) this.close();
      return;
    }
    if (matchesKey(data, "shift+up")) {
      void this.moveCandidate(-1);
    } else if (matchesKey(data, "shift+down")) {
      void this.moveCandidate(1);
    } else if (kb.matches(data, "tui.select.up")) {
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
    // 锁定态 / 装载硬错误态（工单 05）：鼠标同样不可编辑
    if (this.locked || this.loadFailed) return undefined;
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
    // 退出回执的计数读生效值（单一读口），与入口行、spawn 同口径
    this.options.onDone(configuredCountValue(effectiveMappingFromView(this.view), this.options.t));
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
   * 写盘成功后回读本节与单一读口并重建行。selectRowId 指定刷新后光标落点
   * （找不到时按当前下标收缩）；待删行与盘上内容失配（模型变了/下标没了）
   * 自动撤销。
   */
  private refresh(selectRowId?: string): void {
    this.local = readPanelState(this.options.getSection());
    this.loadResult = this.options.loadEffective();
    this.view = this.buildView();
    this.rows = buildPoolEditorRows(this.view);
    const target =
      selectRowId === undefined ? -1 : this.rows.findIndex((row) => poolEditorRowId(row) === selectRowId);
    this.selectedIndex =
      target >= 0 ? target : Math.min(this.selectedIndex, this.rows.length - 1);
    if (this.pendingDelete) {
      const pool = this.view.tiers[this.pendingDelete.tier].pool;
      if (pool[this.pendingDelete.index] !== this.pendingDelete.model) {
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

  /** 外层生效档的直接编辑被挡（工单 05）：提示后不写盘 */
  private blockForeignTier(tier: ModelTier): boolean {
    if (tierPoolEditable(this.view, tier)) return false;
    this.notify(this.options.t("module.subagents.pool.foreignBlocked"));
    return true;
  }

  /** Enter/空格/点击：待删行确认删除；模型行开选择器换模型；添加行追加候选。 */
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
    if (row.kind === "takeover") {
      void this.takeTierOver(row.tier);
      return;
    }
    if (row.kind !== "tier" && this.blockForeignTier(row.tier)) return;
    if (row.kind !== "tier") this.openModelPicker(row);
  }

  /** Ctrl+D：模型行进入/撤销待删态（再按一次撤销）；其它行无反应；外层生效档被挡 */
  private toggleDeleteArm(): void {
    const row = this.currentRow();
    if (!row || row.kind !== "model") return;
    if (this.blockForeignTier(row.tier)) return;
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
        model: this.view.tiers[row.tier].pool[row.index] ?? "",
      };
    }
    this.options.requestRender();
  }

  /** 待删确认：写掉该候选。档内最后一个候选拒绝删除（不允许写出空池） */
  private async confirmDelete(row: { readonly tier: ModelTier; readonly index: number }): Promise<void> {
    const pool = [...this.view.tiers[row.tier].pool];
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
    if (this.blockForeignTier(row.tier)) return;
    const pool = [...this.view.tiers[row.tier].pool];
    const nextPool = poolAfterMove(pool, row.index, step);
    if (!nextPool) return;
    const outcome = await saveTierPool(this.options, row.tier, nextPool);
    this.reportSave(outcome);
    if (outcome.ok) {
      this.pendingDelete = null;
      this.refresh(`subagents.pool.${row.tier}.model.${row.index + step}`);
    }
  }

  /** 显式接管只写候选池；旧 thinking.* 配置不再写回本节。 */
  private async takeTierOver(tier: ModelTier): Promise<void> {
    const tierView = this.view.tiers[tier];
    if (tierView.pool.length === 0) return;
    const outcome = await saveTierPool(this.options, tier, tierView.pool);
    this.reportSave(outcome);
    if (!outcome.ok) return;
    this.refresh(`subagents.pool.${tier}.takeover`);
    if (this.view.tiers[tier].ownership === "foreign") {
      this.notify(
        this.options.t("module.subagents.pool.takeoverShadowNote", {
          path: this.view.tiers[tier].poolSource ?? "",
        }),
      );
    }
  }

  /**
   * 开模型选择器（工单 09 两级）：模型行换模型，添加行追加候选。默认列表只列
   * 已配凭据的模型（不再把目录全集铺开让人误以为都能跑）；未认证的折叠进末
   * 尾显式入口，展开后仍可显式选入。落选后进思考等级选择（模型默认 + 目录
   * 支持的等级），写出裸引用或带 ":level" 后缀的候选值。
   */
  private openModelPicker(row: { readonly kind: "model" | "add"; readonly tier: ModelTier; readonly index?: number }): void {
    const t = this.options.t;
    const tierName = tierDisplayName(row.tier, t);
    const title =
      row.kind === "model"
        ? t("module.subagents.pool.replaceTitle", { tier: tierName })
        : t("module.subagents.pool.addTitle", { tier: tierName });
    this.mountModelPicker(row, title);
  }

  /** 默认模型列表：已认证候选 + 展开未认证模型的显式入口（哨兵值见常量注释） */
  private mountModelPicker(
    row: { readonly kind: "model" | "add"; readonly tier: ModelTier; readonly index?: number },
    title: string,
  ): void {
    const t = this.options.t;
    const unauthenticated = this.candidates.filter((candidate) => !candidate.authenticated);
    const options: ChoiceOption[] = this.candidates
      .filter((candidate) => candidate.authenticated)
      .map((candidate) => ({
        value: tierCandidateValue(candidate),
        label: tierCandidateValue(candidate),
        description: t("module.subagents.tier.authenticated"),
      }));
    if (unauthenticated.length > 0) {
      options.push({
        value: SHOW_UNAUTHENTICATED_MODELS,
        label: t("module.subagents.pool.showUnauthenticated", { count: unauthenticated.length }),
        description: t("module.subagents.tier.noAuthRequired"),
      });
    }
    this.submenu = new ChoicePicker({
      title,
      theme: this.options.theme,
      t,
      // 模型目录全集较长：开搜索框，输入即过滤
      searchable: true,
      options,
      onSelect: (value) => {
        if (value === SHOW_UNAUTHENTICATED_MODELS) {
          this.mountUnauthenticatedPicker(row, title);
          return;
        }
        this.mountThinkingPicker(row, value, () => this.mountModelPicker(row, title));
      },
      onCancel: () => {
        this.submenu = null;
        this.options.requestRender();
      },
    });
    this.options.requestRender();
  }

  /** 展开后的未认证模型列表（显式入口进入）：Esc 回默认列表 */
  private mountUnauthenticatedPicker(
    row: { readonly kind: "model" | "add"; readonly tier: ModelTier; readonly index?: number },
    backTitle: string,
  ): void {
    const t = this.options.t;
    this.submenu = new ChoicePicker({
      title: t("module.subagents.pool.unauthTitle", { title: backTitle }),
      theme: this.options.theme,
      t,
      searchable: true,
      options: this.candidates
        .filter((candidate) => !candidate.authenticated)
        .map((candidate) => ({
          value: tierCandidateValue(candidate),
          label: tierCandidateValue(candidate),
          description: t("module.subagents.tier.noAuthRequired"),
        })),
      onSelect: (value) => {
        this.mountThinkingPicker(row, value, () => this.mountUnauthenticatedPicker(row, backTitle));
      },
      onCancel: () => this.mountModelPicker(row, backTitle),
    });
    this.options.requestRender();
  }

  /**
   * 思考等级选择（后缀写入口）：首项「模型默认」写出裸引用，其余按目录支持集
   * （supportedThinkingLevels 同一规则，不另设第二套）写出 ":level" 后缀。Esc
   * 回到来时的模型列表。候选查不到时按全集提供：无法核验就不虚构限制，与
   * model-selector 的诚实边界同向（当前接线下查不到不会发生，候选值本身
   * 出自同一份 candidates 快照）。
   */
  private mountThinkingPicker(
    row: { readonly kind: "model" | "add"; readonly tier: ModelTier; readonly index?: number },
    model: string,
    back: () => void,
  ): void {
    const t = this.options.t;
    const levels =
      this.candidates.find((candidate) => tierCandidateValue(candidate) === model)
        ?.supportedThinking ?? THINKING_LEVELS;
    this.submenu = new ChoicePicker({
      title: t("module.subagents.pool.levelTitle", { model }),
      theme: this.options.theme,
      t,
      options: [
        { value: "", label: t("module.subagents.tier.thinking.unset") },
        ...levels.map((level) => ({ value: level, label: level })),
      ],
      onSelect: (level) => {
        this.submenu = null;
        // 早退路径（重选同值）不会触发后续 refresh，这里显式请求一帧，
        // 保证选择器立刻从渲染里消失
        this.options.requestRender();
        void this.applyModelSelection(row, level === "" ? model : `${model}:${level}`);
      },
      onCancel: back,
    });
    this.options.requestRender();
  }

  /**
   * 选择器落选：换指定下标的模型 / 追加到池尾。重复判定按基础引用（工单
   * 03）：剥掉思考等级后缀后与池内已有候选相同即拒绝（不产生重复候选，
   * 后缀变体也写不进池），提示同时指明尝试写入的候选与池内已存在的那条。
   */
  private async applyModelSelection(
    row: { readonly kind: "model" | "add"; readonly tier: ModelTier; readonly index?: number },
    model: string,
  ): Promise<void> {
    const t = this.options.t;
    // 池取生效值（单一读口）：可编辑档的生效池就是本节当前内容
    const pool = [...this.view.tiers[row.tier].pool];
    const replaceIndex = row.kind === "model" ? row.index : undefined;
    if (replaceIndex !== undefined && pool[replaceIndex] === model) return;
    const nextPool =
      replaceIndex !== undefined
        ? pool.map((candidate, index) => (index === replaceIndex ? model : candidate))
        : [...pool, model];
    const duplicate = findDuplicateBaseRef(nextPool);
    if (duplicate) {
      const existing = duplicate.first === model ? duplicate.second : duplicate.first;
      this.notify(t("module.subagents.pool.duplicate", { candidate: model, existing }));
      return;
    }
    const outcome = await saveTierPool(this.options, row.tier, nextPool);
    this.reportSave(outcome);
    if (outcome.ok) {
      this.pendingDelete = null;
      this.refresh(
        replaceIndex !== undefined
          ? `subagents.pool.${row.tier}.model.${replaceIndex}`
          : `subagents.pool.${row.tier}.model.${pool.length}`,
      );
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
    // 链级提示（工单 05）：环境变量锁定横幅与其它层的逐档问题原样透出
    if (this.view.envLocked) {
      lines.push(
        truncateToWidth(
          this.options.theme.fg(
            "error",
            this.options.t("module.subagents.pool.envLocked", {
              path: this.loadResult.sourcePath ?? "",
            }),
          ),
          width,
        ),
      );
    }
    for (const problem of this.view.chainProblems) {
      lines.push(truncateToWidth(this.options.theme.fg("error", problem), width));
    }
    lines.push("");
    lines.push(truncateToWidth(this.options.theme.hint(this.options.t("module.subagents.pool.hint")), width));
    return lines;
  }

  /** 来源路径的短显示：保尾（目录差异多在尾部），超长头部省略；按码点截不切半个字 */
  private shortenSource(source: string, max = 48): string {
    const chars = Array.from(source);
    if (visibleWidth(source) <= max) return source;
    return `…${chars.slice(-(max - 1)).join("")}`;
  }

  private renderRow(row: PoolEditorRow, selected: boolean, width: number): string {
    const t = this.options.t;
    const theme = this.options.theme;
    const prefix = selected ? theme.settings.cursor : "  ";
    if (row.kind === "tier") {
      const label = theme.title(tierDisplayName(row.tier, t));
      const tierView = this.view.tiers[row.tier];
      const parts: string[] = [];
      if (tierView.ownership === "foreign") {
        parts.push(
          t("module.subagents.pool.source", {
            source: this.shortenSource(tierView.poolSource ?? ""),
          }),
        );
      }
      if (tierView.pool.length === 0) parts.push(t("module.subagents.tier.unmapped"));
      const value = theme.settings.value(parts.join(" · "), selected);
      const pad = Math.max(1, width - visibleWidth(prefix) - visibleWidth(label) - visibleWidth(value));
      return truncateToWidth(prefix + label + " ".repeat(pad) + value, width);
    }
    if (row.kind === "add") {
      return truncateToWidth(prefix + "  " + theme.hint(t("module.subagents.pool.add")), width);
    }
    if (row.kind === "takeover") {
      return truncateToWidth(
        prefix + "  " + theme.settings.label(t("module.subagents.pool.takeover"), selected),
        width,
      );
    }
    const model = this.view.tiers[row.tier].pool[row.index] ?? "";
    const armed =
      this.pendingDelete !== null &&
      this.pendingDelete.tier === row.tier &&
      this.pendingDelete.index === row.index;
    const body = armed
      ? theme.fg("error", model) + theme.hint(` · ${t("module.subagents.pool.deleteArmed")}`)
      : theme.settings.label(model, selected);
    return truncateToWidth(prefix + "  " + body, width);
  }

  /** 锁定态渲染（工单 05）：本节混合合法/非法档，只展示问题与解锁方式 */
  private renderLocked(width: number): string[] {
    const t = this.options.t;
    const theme = this.options.theme;
    const lines = [theme.title(t("module.subagents.pool.lockedTitle")), ""];
    for (const problem of this.local.tierProblems) {
      lines.push(truncateToWidth(theme.fg("error", problem), width));
    }
    lines.push("");
    lines.push(truncateToWidth(theme.hint(t("module.subagents.pool.lockedHint")), width));
    return lines;
  }

  /** 装载硬错误渲染（工单 05）：单一读口报硬错误时整个面板不可用 */
  private renderLoadError(width: number): string[] {
    const t = this.options.t;
    const theme = this.options.theme;
    const lines = [theme.title(t("module.subagents.pool.loadErrorTitle")), ""];
    const error = this.loadResult.error ?? "";
    if (error) lines.push(truncateToWidth(theme.fg("error", error), width));
    lines.push("");
    lines.push(truncateToWidth(theme.hint(t("module.subagents.pool.loadErrorHint")), width));
    return lines;
  }
}
