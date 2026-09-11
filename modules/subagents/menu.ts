// 子代理配置子菜单：子代理组里的 `子代理配置` 行打开这一页（原生 SettingsList 形态）。
// 页面五行：
//   状态显示   —— 对应 pi-toolkit.json `modules.subagents.status.enabled`（开/关）
//   fast 档模型   —— SelectList 选模型，候选来自 ctx.modelRegistry
//   balanced 档模型
//   deep 档模型
//   tier 路由状态 —— 只读展示当前生效的 tier 路由解析结果
//
// 写盘落点（工单 04 归一裁决）全在 pi-toolkit.json 的 `modules.subagents` 节；
// tier 解析仍是六级覆盖链，本页只写第 4 级。缺映射时行描述直接用
// routing.ts 的原版报错文案（不翻译、不改写），与真正 spawn 时抛出的字符串一致。

import { type ExtensionContext, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, Text } from "@earendil-works/pi-tui";
import type { Translator } from "../../i18n/index.ts";
import { ChoicePicker } from "../../kit/menu/panels.ts";
import { I18nSettingsList } from "../../kit/menu/settings-list.ts";
import type { MenuTheme } from "../../kit/menu/theme.ts";
import type { ModuleMenuContext } from "../../kit/module.ts";
import {
  loadEffectiveTierConfig,
  MODEL_TIERS,
  readSubagentsSection,
  saveStatusEnabled,
  saveTierModel,
  tierRouteError,
  type ModelTier,
  type TierConfigLoadResult,
  type TierMapping,
} from "./config.ts";
import { loadStatusConfig } from "./status.ts";

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

export function tierRowId(tier: ModelTier): string {
  return `subagents.settings.tier.${tier}`;
}

/** 面板行的 id 清单（渲染顺序，自测用） */
export function panelRowIds(): readonly string[] {
  return [ROW_STATUS, ...MODEL_TIERS.map(tierRowId), ROW_ROUTE];
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

/** 一行里展示的 tier 取值：没配就显示"未配置"文案 */
export function tierRowValue(tier: ModelTier, mapping: TierMapping, t: Translator): string {
  return mapping[tier] ?? t("module.subagents.tier.unmapped");
}

/** 只读路由摘要：逐档展示取值，配置读取本身出错时把原版错误一并带上 */
export function tierRoutingSummary(
  load: TierConfigLoadResult,
  mapping: TierMapping,
  t: Translator,
): string {
  const parts = MODEL_TIERS.map((tier) => `${tier}=${tierRowValue(tier, mapping, t)}`);
  if (load.error) return `${parts.join(" · ")} · ${load.error}`;
  return parts.join(" · ");
}

/**
 * 第一档缺映射时的原版报错文案。取 routing.ts 的 resolveTierForParams 输出，
 * 与真正 spawn 时抛出的字符串逐字一致；三档都配齐时返回 undefined。
 */
export function firstTierProblem(
  mapping: TierMapping,
  load: () => TierConfigLoadResult,
): string | undefined {
  for (const tier of MODEL_TIERS) {
    if (mapping[tier]) continue;
    const error = tierRouteError(tier, load);
    if (error) return error;
  }
  return undefined;
}

export interface SubagentsMenuRuntime {
  /** 写盘后重载状态中枢的内存副本，让 getConfig() 跟上磁盘 */
  reload: () => Promise<void>;
}

export interface SubagentsPanelOptions {
  readonly t: Translator;
  readonly theme: MenuTheme;
  readonly context: ExtensionContext;
  readonly agentDir: string;
  readonly runtime: SubagentsMenuRuntime;
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
  readonly statusEnabled: boolean | undefined;
  readonly problems: readonly string[];
}

export function readPanelState(section: Record<string, unknown>): SubagentsPanelState {
  const view = readSubagentsSection(section);
  return { mapping: view.tier, statusEnabled: view.statusEnabled, problems: view.problems };
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

/** 写一档 tier 并让状态中枢重载配置；返回结果供 UI 与自测判定 */
export async function saveTier(
  options: SubagentsPanelOptions,
  tier: ModelTier,
  model: string,
): Promise<SaveOutcome> {
  try {
    await saveTierModel(tier, model, { agentDir: options.agentDir });
    await options.runtime.reload();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

/** 写状态显示开关并让状态中枢重载配置 */
export async function saveStatus(
  options: SubagentsPanelOptions,
  enabled: boolean,
): Promise<SaveOutcome> {
  try {
    await saveStatusEnabled(enabled, { agentDir: options.agentDir });
    await options.runtime.reload();
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
    for (const tier of MODEL_TIERS) {
      this.list?.updateValue(tierRowId(tier), tierRowValue(tier, this.state.mapping, t));
    }
    this.list?.updateValue(ROW_STATUS, statusRowValue(this.state, this.options.packageStatusEnabled, t));
    this.list?.updateValue(ROW_ROUTE, tierRoutingSummary(this.loadTierConfig(), this.state.mapping, t));
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

    for (const tier of MODEL_TIERS) {
      items.push({
        id: tierRowId(tier),
        label: t("module.subagents.tier.label", { tier }),
        description: this.tierDescription(tier),
        currentValue: tierRowValue(tier, this.state.mapping, t),
        submenu: (_currentValue, done) =>
          new ChoicePicker({
            title: t("module.subagents.tier.label", { tier }),
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
    }

    items.push({
      id: ROW_ROUTE,
      label: t("module.subagents.route.label"),
      description: t("module.subagents.route.description"),
      currentValue: tierRoutingSummary(this.loadTierConfig(), this.state.mapping, t),
    });

    return items;
  }
}

/** 模块的菜单行：一行入口，进去是子代理配置页 */
export function buildSubagentsMenuItems(
  context: ModuleMenuContext,
  runtime: SubagentsMenuRuntime,
): readonly SettingItem[] {
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
          runtime,
          requestRender: () => context.requestRender(),
          getSection: () => context.getConfig(),
          packageStatusEnabled: readPackageStatusEnabled(),
          onDone: (value) => done(value),
        }),
    },
  ];
}
