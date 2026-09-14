// 子代理配置子菜单：子代理组里的 `子代理配置` 行打开这一页（原生 SettingsList 形态）。
// 页面八行（工单 23 后）：
//   状态显示   —— 对应 pi-toolkit.json `modules.subagents.status.enabled`（开/关）
//   旗舰模型（deep 档候选）  —— SelectList 选模型：选中项成为该档候选池首选（已有则提首位），其余候选保持顺序
//   旗舰模型 · 默认思考等级 —— 该档默认思考等级（off…max 或未设置＝模型默认，工单 23）
//   均衡模型（balanced 档候选）
//   均衡模型 · 默认思考等级
//   快速模型（fast 档候选）
//   快速模型 · 默认思考等级
//   tier 路由状态 —— 只读展示当前生效的 tier 路由解析结果（含各档思考等级）
//
// 档位显示名与固定排序（工单 22）：设置界面按 旗舰模型 → 均衡模型 → 快速模型
// 从高到低显示；内部键 deep/balanced/fast 不改名（与配置、工具参数和报错原文
// 兼容），显示名走 i18n 三语键（module.subagents.tier.name.*）。
//
// 写盘落点（工单 04 归一裁决）全在 pi-toolkit.json 的 `modules.subagents` 节；
// tier 解析仍是六级覆盖链，本页只写第 4 级。档位取值是有序候选池（工单 21），
// 本页暂只提供“首选”选择；候选池的完整增删排序界面属后续工单。缺映射时行
// 描述直接用 routing.ts 的原版报错文案（不翻译、不改写），与真正 spawn 时抛出
// 的字符串一致。思考等级（工单 23）只在本节点写档位默认：spawn 时的覆盖优先
// 级（任务显式 > 代理 frontmatter > 档位默认）在启动事务里裁决，不在这里。

import { type ExtensionContext, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, Text } from "@earendil-works/pi-tui";
import type { Translator } from "../../i18n/index.ts";
import type { ConfigWriteHooks } from "../../kit/config-transaction.ts";
import { ChoicePicker } from "../../kit/menu/panels.ts";
import { I18nSettingsList } from "../../kit/menu/settings-list.ts";
import type { MenuTheme } from "../../kit/menu/theme.ts";
import type { ModuleConfigRecord, ModuleMenuContext } from "../../kit/module.ts";
import {
  loadEffectiveTierConfig,
  MODEL_TIERS,
  THINKING_LEVELS,
  readSubagentsSection,
  statusEnabledPatch,
  subagentsSectionPath,
  tierPoolPatch,
  tierRouteError,
  tierThinkingPatch,
  type ModelTier,
  type ThinkingLevel,
  type TierConfigLoadResult,
  type TierMapping,
  type TierThinkingMapping,
} from "./config.ts";
import { loadStatusConfig } from "./status.ts";
import type { SubagentsMessageKey } from "./messages/index.ts";

/**
 * 包内 config.json（→ config.json.example）的 status.enabled：
 * 本节点未声明时的兜底默认。读不出来时按开启处理（与 example 一致）。
 */
export function readPackageStatusEnabled(): boolean {
  try {
    return loadStatusConfig().enabled;
  } catch {
    return true;
  }
}

/** 分组页里的入口行 id */
export const SUBAGENTS_MENU_ITEM_ID = "subagents.settings";

const ROW_STATUS = "subagents.settings.status";
const ROW_ROUTE = "subagents.settings.route";

/**
 * 设置界面的档位显示顺序（工单 22）：固定从高到低 deep → balanced → fast。
 * MODEL_TIERS（fast → balanced → deep）仍是校验与报错原文的规范档位清单，
 * 不随显示顺序变化，两份常量各管各的。
 */
export const TIER_DISPLAY_ORDER: readonly ModelTier[] = ["deep", "balanced", "fast"];

export function tierRowId(tier: ModelTier): string {
  return `subagents.settings.tier.${tier}`;
}

/** 档位默认思考等级行的 id（工单 23） */
export function tierThinkingRowId(tier: ModelTier): string {
  return `subagents.settings.tier-thinking.${tier}`;
}

/** 面板行的 id 清单（渲染顺序，自测用）：每档候选行后紧跟其思考等级行 */
export function panelRowIds(): readonly string[] {
  return [
    ROW_STATUS,
    ...TIER_DISPLAY_ORDER.flatMap((tier) => [tierRowId(tier), tierThinkingRowId(tier)]),
    ROW_ROUTE,
  ];
}

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

/**
 * 一行里展示的 tier 取值：候选池首选在前，其余候选以 (+N) 计数；没配就显示
 * “未配置”文案。
 */
export function tierRowValue(tier: ModelTier, mapping: TierMapping, t: Translator): string {
  const pool = mapping[tier];
  if (!pool || pool.length === 0) return t("module.subagents.tier.unmapped");
  const [preferred, ...rest] = pool;
  return rest.length > 0 ? `${preferred} (+${rest.length})` : preferred;
}

/** 档位默认思考等级行的取值（工单 23）：等级代码原样展示，未设置显示“模型默认” */
export function tierThinkingRowValue(
  tier: ModelTier,
  mapping: TierThinkingMapping,
  t: Translator,
): string {
  return mapping[tier] ?? t("module.subagents.tier.thinking.unset");
}

/**
 * 只读路由摘要：逐档展示模型取值与已配置的档位默认思考等级，配置读取本身
 * 出错时把原版错误一并带上。
 */
export function tierRoutingSummary(
  load: TierConfigLoadResult,
  mapping: TierMapping,
  thinking: TierThinkingMapping,
  t: Translator,
): string {
  const parts = TIER_DISPLAY_ORDER.map((tier) => {
    const model = tierRowValue(tier, mapping, t);
    const level = load.config?.thinking[tier];
    return `${tierDisplayName(tier, t)}=${model}${level ? ` thinking=${level}` : ""}`;
  });
  if (load.error) return `${parts.join(" · ")} · ${load.error}`;
  return parts.join(" · ");
}

/**
 * 按显示顺序（旗舰 → 均衡 → 快速）第一个缺映射档的原版报错文案。取 routing.ts
 * 的 resolveTierForParams 输出，与真正 spawn 时抛出的字符串逐字一致；三档都
 * 配齐时返回 undefined。
 */
export function firstTierProblem(
  mapping: TierMapping,
  load: () => TierConfigLoadResult,
): string | undefined {
  for (const tier of TIER_DISPLAY_ORDER) {
    if (mapping[tier]) continue;
    const error = tierRouteError(tier, load);
    if (error) return error;
  }
  return undefined;
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
  /** 包内 config.json（→ example）的 status.enabled，作为本节点未声明时的兜底默认 */
  readonly packageStatusEnabled: boolean;
  readonly onDone: (value: string) => void;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ─────────────────────────────────────────────────────────────
// 纯逻辑：面板行的数值与状态
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

/** 状态显示开关的显示值：本节点未声明时展示包内兜底默认 */
export function statusRowValue(
  state: SubagentsPanelState,
  fallbackEnabled: boolean,
  t: Translator,
): string {
  const enabled = state.statusEnabled ?? fallbackEnabled;
  return enabled ? t("common.on") : t("common.off");
}

/** 已配置档位计数文案（入口行的当前值） */
export function configuredCountValue(mapping: TierMapping, t: Translator): string {
  const configured = MODEL_TIERS.filter((tier) => mapping[tier]).length;
  return t("module.subagents.menu.value", { configured, total: MODEL_TIERS.length });
}

export interface SaveOutcome {
  readonly ok: boolean;
  readonly error?: string;
}

/**
 * 选定一个模型作为该档首选：候选池里已有则提到首位（重排序），没有则加入
 * 首位；其余候选保持原相对顺序。补丁语义 + 写前校验在本模块，落盘与重载
 * 走配置写入事务。
 */
export async function saveTier(
  options: SubagentsPanelOptions,
  tier: ModelTier,
  model: string,
): Promise<SaveOutcome> {
  try {
    const current = readPanelState(options.getSection()).mapping[tier] ?? [];
    const pool = [model, ...current.filter((candidate) => candidate !== model)];
    await options.saveConfig(tierPoolPatch(tier, pool, subagentsSectionPath(options.agentDir)));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

/** 写状态显示开关：补丁语义在本模块，落盘与重载走配置写入事务 */
export async function saveStatus(
  options: SubagentsPanelOptions,
  enabled: boolean,
): Promise<SaveOutcome> {
  try {
    await options.saveConfig(statusEnabledPatch(enabled));
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
// UI：配置面板
// ─────────────────────────────────────────────────────────────

export class SubagentsPanel extends Container {
  private readonly options: SubagentsPanelOptions;
  private list: I18nSettingsList | undefined;
  private candidates: TierCandidate[];
  private state: SubagentsPanelState;

  constructor(options: SubagentsPanelOptions) {
    super();
    this.options = options;
    this.candidates = discoverTierCandidates(options.context.modelRegistry);
    this.state = readPanelState(options.getSection());
    this.addChild(new Text(options.theme.title(options.t("module.subagents.menu.label")), 1, 0));
    this.list = new I18nSettingsList({
      items: this.buildItems(),
      maxVisible: 8,
      theme: options.theme.settings,
      t: options.t,
      onChange: () => {},
      onCancel: () => this.close(),
    });
    this.addChild(this.list);
  }

  /** 当前生效的 tier 配置（与 spawn 同一规则） */
  loadTierConfig(): TierConfigLoadResult {
    return loadEffectiveTierConfig({ cwd: this.options.context.cwd, agentDir: this.options.agentDir });
  }

  handleInput(data: string): void {
    this.list?.handleInput(data);
  }

  private close(): void {
    this.options.onDone(configuredCountValue(this.state.mapping, this.options.t));
  }

  /** 写盘失败只提示，不改任何取值 */
  private reportSave(outcome: SaveOutcome): void {
    if (outcome.ok) return;
    this.options.context.ui.notify(
      this.options.t("notify.saveFailed", { reason: outcome.error ?? "" }),
      "error",
    );
  }

  private refreshRows(): void {
    this.state = readPanelState(this.options.getSection());
    const t = this.options.t;
    for (const tier of TIER_DISPLAY_ORDER) {
      this.list?.updateValue(tierRowId(tier), tierRowValue(tier, this.state.mapping, t));
      this.list?.updateValue(
        tierThinkingRowId(tier),
        tierThinkingRowValue(tier, this.state.tierThinking, t),
      );
    }
    this.list?.updateValue(ROW_STATUS, statusRowValue(this.state, this.options.packageStatusEnabled, t));
    this.list?.updateValue(
      ROW_ROUTE,
      tierRoutingSummary(this.loadTierConfig(), this.state.mapping, this.state.tierThinking, t),
    );
    this.options.requestRender();
  }

  private tierDescription(tier: ModelTier): string {
    if (this.state.mapping[tier]) {
      return this.options.t("module.subagents.tier.description", { tier });
    }
    // 缺映射：直接用 routing.ts 的原版报错文案（不翻译，保证与原版逐字一致）
    return tierRouteError(tier, () => this.loadTierConfig())
      ?? this.options.t("module.subagents.tier.description", { tier });
  }

  private buildItems(): SettingItem[] {
    const t = this.options.t;
    const items: SettingItem[] = [];

    items.push({
      id: ROW_STATUS,
      label: t("module.subagents.status.label"),
      description: t("module.subagents.status.description"),
      currentValue: statusRowValue(this.state, this.options.packageStatusEnabled, t),
      submenu: (_currentValue, done) => {
        const enabledNow = (this.state.statusEnabled ?? this.options.packageStatusEnabled) === true;
        return new ChoicePicker({
          title: t("module.subagents.status.label"),
          theme: this.options.theme,
          t,
          options: [
            { value: "true", label: t("common.on"), ...(enabledNow ? { description: t("common.current") } : {}) },
            { value: "false", label: t("common.off"), ...(enabledNow ? {} : { description: t("common.current") }) },
          ],
          onSelect: (value, label) => {
            void (async () => {
              const outcome = await saveStatus(this.options, value === "true");
              this.reportSave(outcome);
              if (outcome.ok) this.refreshRows();
              done(outcome.ok ? label : undefined);
            })();
          },
          onCancel: () => done(),
        });
      },
    });

    for (const tier of TIER_DISPLAY_ORDER) {
      items.push({
        id: tierRowId(tier),
        label: tierDisplayName(tier, t),
        description: this.tierDescription(tier),
        currentValue: tierRowValue(tier, this.state.mapping, t),
        submenu: (_currentValue, done) =>
          new ChoicePicker({
            title: tierDisplayName(tier, t),
            theme: this.options.theme,
            t,
            options: this.candidates.map((candidate) => ({
              value: tierCandidateValue(candidate),
              label: tierCandidateValue(candidate),
              description: candidate.authenticated
                ? t("module.subagents.tier.authenticated")
                : t("module.subagents.tier.noAuthRequired"),
            })),
            onSelect: (value, label) => {
              void (async () => {
                const outcome = await saveTier(this.options, tier, value);
                this.reportSave(outcome);
                if (outcome.ok) this.refreshRows();
                done(outcome.ok ? label : undefined);
              })();
            },
            onCancel: () => done(),
          }),
      });

      // 档位默认思考等级行（工单 23）：未设置 + 七个规范等级；等级代码是
      // 跨语言通用代码，不 localized（与宿主设置页一致）。
      const currentLevel = this.state.tierThinking[tier] ?? null;
      items.push({
        id: tierThinkingRowId(tier),
        label: t("module.subagents.tier.thinking.label", { tier: tierDisplayName(tier, t) }),
        description: t("module.subagents.tier.thinking.description", {
          tier: tierDisplayName(tier, t),
        }),
        currentValue: tierThinkingRowValue(tier, this.state.tierThinking, t),
        submenu: (_currentValue, done) =>
          new ChoicePicker({
            title: t("module.subagents.tier.thinking.label", { tier: tierDisplayName(tier, t) }),
            theme: this.options.theme,
            t,
            options: [null, ...THINKING_LEVELS].map((level) => ({
              value: level ?? "__unset__",
              label: level ?? t("module.subagents.tier.thinking.unset"),
              ...(level === currentLevel ? { description: t("common.current") } : {}),
            })),
            onSelect: (value, label) => {
              void (async () => {
                const level = value === "__unset__" ? null : (value as ThinkingLevel);
                const outcome = await saveTierThinking(this.options, tier, level);
                this.reportSave(outcome);
                if (outcome.ok) this.refreshRows();
                done(outcome.ok ? label : undefined);
              })();
            },
            onCancel: () => done(),
          }),
      });
    }

    items.push({
      id: ROW_ROUTE,
      label: t("module.subagents.route.label"),
      description: t("module.subagents.route.description"),
      currentValue: tierRoutingSummary(this.loadTierConfig(), this.state.mapping, this.state.tierThinking, t),
    });

    return items;
  }
}

/** 模块的菜单行：一行入口，进去是子代理配置页 */
export function buildSubagentsMenuItems(context: ModuleMenuContext): readonly SettingItem[] {
  const t = context.t;
  const section = context.getConfig();
  const state = readPanelState(section);
  const load = () =>
    loadEffectiveTierConfig({ cwd: context.context.cwd, agentDir: context.agentDir });
  // 缺映射（或本节点配置非法）时把原版报错摆在入口行的描述里，不进子菜单也能看见
  const problem = firstTierProblem(state.mapping, load) ?? state.problems[0];

  return [
    {
      id: SUBAGENTS_MENU_ITEM_ID,
      label: t("module.subagents.menu.label"),
      description: problem ?? t("module.subagents.menu.description"),
      currentValue: configuredCountValue(state.mapping, t),
      submenu: (_currentValue, done) =>
        new SubagentsPanel({
          t,
          theme: context.theme,
          context: context.context,
          agentDir: context.agentDir,
          saveConfig: (patch, hooks) => context.saveConfig(patch, hooks),
          requestRender: () => context.requestRender(),
          getSection: () => context.getConfig(),
          packageStatusEnabled: readPackageStatusEnabled(),
          onDone: (value) => done(value),
        }),
    },
  ];
}
