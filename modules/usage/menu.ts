// 模型与用量面板的用户入口与面板视图（工单 28）。
//
// 入口是子代理组的一行菜单（`usage.panel`）：进去是一页只读面板，展示
// 当前会话 / 今日 / 本周 / 历史四个时间窗口、候选模型状态与代理/任务排行。
// 数据全部来自 `usage.snapshot` 句柄，面板不解析任何 TUI 文本，也不直接读磁盘。
// 余额/额度/健康状态未知时按“未知”展示，不显示成 0。

import { Container, getKeybindings, Text, type SettingItem } from "@earendil-works/pi-tui";
import type { Translator } from "../../i18n/index.ts";
import type { MenuTheme } from "../../kit/menu/theme.ts";
import type { ModuleMenuContext } from "../../kit/module.ts";
import type { ServiceRegistry } from "../../kit/services.ts";
import {
  USAGE_SNAPSHOT_SERVICE_NAME,
  type UsageBreakdown,
  type UsageModelView,
  type UsageSnapshotService,
  type UsageSnapshotView,
} from "./api.ts";
import type { UsageMessageKey } from "./messages/index.ts";

/** 分组页里的入口行 id */
export const USAGE_MENU_ITEM_ID = "usage.panel";

const HEALTH_KEYS: Readonly<Record<string, UsageMessageKey>> = {
  available: "module.usage.panel.health.available",
  unstable: "module.usage.panel.health.unstable",
  "quota-blocked": "module.usage.panel.health.quota-blocked",
  offline: "module.usage.panel.health.offline",
  unknown: "module.usage.panel.health.unknown",
  unconfigured: "module.usage.panel.health.unconfigured",
};

const OUTCOME_KEYS: Readonly<Record<string, UsageMessageKey>> = {
  completed: "module.usage.panel.outcome.completed",
  failed: "module.usage.panel.outcome.failed",
  cancelled: "module.usage.panel.outcome.cancelled",
};

/** Token 数量的紧凑显示：1234 → "1.2k" */
export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function formatCost(value: number): string {
  const safe = Number.isFinite(value) && value > 0 ? value : 0;
  return `$${safe.toFixed(4)}`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round((Number.isFinite(ms) ? ms : 0) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
}

function healthLabel(verdict: string, t: Translator): string {
  const key = HEALTH_KEYS[verdict];
  return key ? t(key) : t("module.usage.panel.health.unknown");
}

function balanceText(model: UsageModelView, t: Translator): string {
  if (!model.balance) return t("module.usage.panel.unknown");
  return t("module.usage.panel.balanceKnown", {
    amount: model.balance.amount,
    currency: model.balance.currency,
  });
}

function quotaText(model: UsageModelView, t: Translator): string {
  if (model.quota == null) return t("module.usage.panel.unknown");
  if (model.quota.length === 0) return t("module.usage.panel.quotaNone");
  // 额度窗口取剩余百分比最低的那个：最紧的约束对用户最有用
  const tightest = model.quota.reduce((a, b) => (b.remainingPercent < a.remainingPercent ? b : a));
  return t("module.usage.panel.quotaKnown", {
    label: tightest.label,
    percent: tightest.remainingPercent,
  });
}

function outcomeLabel(outcome: string, t: Translator): string {
  const key = OUTCOME_KEYS[outcome];
  return key ? t(key) : outcome;
}

function routingLabel(downgraded: boolean | null, t: Translator): string {
  if (downgraded === true) return t("module.usage.panel.routing.downgraded");
  if (downgraded === false) return t("module.usage.panel.routing.preferred");
  return t("module.usage.panel.unknown");
}

function rankSection(headerKey: UsageMessageKey, buckets: readonly UsageBreakdown[], t: Translator): string[] {
  const top = buckets.slice(0, 5);
  if (top.length === 0) return [];
  return [
    "",
    t(headerKey),
    ...top.map(
      (bucket) =>
        `  ${t("module.usage.panel.rankLine", { key: bucket.key, tokens: formatTokenCount(bucket.totalTokens) })}`,
    ),
  ];
}

/** 面板正文（纯函数，供组件与自测共用）：四窗口 + 候选模型 + 代理/任务排行。 */
export function buildUsagePanelReport(view: UsageSnapshotView, t: Translator): string {
  const lines: string[] = [];
  const windows: Array<[keyof UsageSnapshotView["windows"], UsageMessageKey]> = [
    ["current", "module.usage.panel.window.current"],
    ["today", "module.usage.panel.window.today"],
    ["week", "module.usage.panel.window.week"],
    ["history", "module.usage.panel.window.history"],
  ];
  for (const [key, labelKey] of windows) {
    const window = view.windows[key];
    lines.push(
      t("module.usage.panel.windowLine", {
        label: t(labelKey),
        runs: window.runs,
        tokens: formatTokenCount(window.totalTokens),
        cost: formatCost(window.costUsd),
        duration: formatDuration(window.durationMs),
      }),
    );
  }

  lines.push("");
  if (view.models.length === 0) {
    lines.push(t("module.usage.panel.noModels"));
  } else {
    lines.push(t("module.usage.panel.modelsHeader", { count: view.models.length }));
    for (const model of view.models) {
      const today = view.windows.today.byModel.find((bucket) => bucket.key === model.model);
      lines.push(
        `  ${t("module.usage.panel.modelLine", {
          model: model.model,
          tiers: model.tiers.join("/"),
          health: healthLabel(model.health.verdict, t),
          today: formatTokenCount(today?.totalTokens ?? 0),
          total: formatTokenCount(model.totals.totalTokens),
          balance: balanceText(model, t),
          quota: quotaText(model, t),
        })}`,
      );
    }
  }

  const recent = view.recent.slice(0, 5);
  if (recent.length > 0) {
    lines.push("");
    lines.push(t("module.usage.panel.recentHeader"));
    for (const record of recent) {
      lines.push(
        `  ${t("module.usage.panel.recentLine", {
          task: record.taskLabel,
          model: record.model ?? t("module.usage.panel.unknown"),
          thinking: record.thinking ?? "—",
          outcome: outcomeLabel(record.outcome, t),
          routing: routingLabel(record.downgraded, t),
        })}`,
      );
    }
  }
  lines.push(...rankSection("module.usage.panel.agentsHeader", view.windows.history.byAgent, t));
  lines.push(...rankSection("module.usage.panel.tasksHeader", view.windows.history.byTask, t));
  if (view.windows.history.runs === 0) {
    lines.push("");
    lines.push(t("module.usage.panel.empty"));
  }
  return lines.join("\n");
}

export interface UsagePanelOptions {
  readonly t: Translator;
  readonly theme: MenuTheme;
  readonly services: ServiceRegistry;
  readonly cwd?: string;
  readonly requestRender: () => void;
  readonly onDone: () => void;
}

/** 只读面板：打开时读一次快照，r 触发刷新后重读，Esc 返回上级菜单。 */
export class UsagePanel extends Container {
  private readonly options: UsagePanelOptions;
  private readonly text: Text;

  constructor(options: UsagePanelOptions) {
    super();
    this.options = options;
    this.addChild(new Text(options.theme.title(options.t("module.usage.panel.title")), 1, 0));
    this.text = new Text(this.buildReport(), 1, 0);
    this.addChild(this.text);
    this.addChild(new Text(options.theme.hint(options.t("module.usage.panel.hint")), 1, 0));
  }

  handleInput(data: string): void {
    if (getKeybindings().matches(data, "tui.select.cancel")) {
      this.options.onDone();
      return;
    }
    if (data === "r" || data === "R") void this.refresh();
  }

  private service(): UsageSnapshotService | undefined {
    return this.options.services.get<UsageSnapshotService>(USAGE_SNAPSHOT_SERVICE_NAME);
  }

  private buildReport(): string {
    const service = this.service();
    if (!service) return this.options.t("module.usage.panel.unavailable");
    return buildUsagePanelReport(service.snapshot({ cwd: this.options.cwd }), this.options.t);
  }

  private async refresh(): Promise<void> {
    const service = this.service();
    if (service) {
      try {
        await service.refresh({ cwd: this.options.cwd });
      } catch {
        // 刷新失败只影响新鲜度；面板照常展示最近已知状态
      }
    }
    this.text.setText(this.buildReport());
    this.options.requestRender();
  }
}

function usageMenuSummary(context: ModuleMenuContext): string {
  const service = context.services.get<UsageSnapshotService>(USAGE_SNAPSHOT_SERVICE_NAME);
  if (!service) return context.t("module.usage.panel.unavailable");
  const view = service.snapshot({ cwd: context.context.cwd });
  if (view.windows.today.runs === 0) return context.t("module.usage.menu.empty");
  return context.t("module.usage.menu.summary", {
    runs: view.windows.today.runs,
    tokens: formatTokenCount(view.windows.today.totalTokens),
  });
}

/** 模块的菜单行：一行入口，进去是模型与用量面板 */
export function buildUsageMenuItems(context: ModuleMenuContext): readonly SettingItem[] {
  const t = context.t;
  return [
    {
      id: USAGE_MENU_ITEM_ID,
      label: t("module.usage.menu.label"),
      description: t("module.usage.menu.description"),
      currentValue: usageMenuSummary(context),
      submenu: (_currentValue, done) =>
        new UsagePanel({
          t,
          theme: context.theme,
          services: context.services,
          cwd: context.context.cwd,
          requestRender: () => context.requestRender(),
          onDone: () => done(),
        }),
    },
  ];
}
