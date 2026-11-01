import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import { runtimeRegistry, latestCtx, latestPi } from "./mod.ts";
import { widgetText } from "./mod-host.ts";
import {
  buildFirstLayerOnlySnapshot,
  type DescendantsTracker,
  type WidgetSnapshot,
} from "./descendants.ts";
import {
  borderBottom,
  borderLine,
  borderTop,
  buildSubagentMetadataSegment,
  type SubagentMetadataLevel,
  subagentTreePrefix,
  subagentTreeTier,
  SUBAGENT_WIDGET_SEGMENT_PRIORITIES,
  widgetIcon,
} from "./display.ts";
import { layoutTwoColumnSegments, type StatusSegment } from "../tui/status/segment-layout.ts";
import { activeScopeLabel, statusLabelText } from "./status-lines.ts";
import type { StatusSnapshot } from "./status.ts";
import type { RunningSubagent } from "./types.ts";

const WIDGET_INTERVAL_KEY = Symbol.for("pi-subagents/widget-interval");

export const widgetRuntime: {
  interval: ReturnType<typeof setInterval> | null;
  tree: DescendantsTracker | null;
  snapshot: WidgetSnapshot | null;
} = { interval: null, tree: null, snapshot: null };

export function isStatusEnabled(): boolean {
  return true;
}

function formatWidgetRightLabel(snapshot: StatusSnapshot): string {
  const t = widgetText;
  if (snapshot.kind === "starting") return ` ${t("module.subagents.widget.status.starting")} `;
  if (snapshot.kind === "running") return ` ${t("module.subagents.widget.status.running")} ${snapshot.elapsedText} `;
  if (snapshot.kind === "active") {
    const label = activeScopeLabel(snapshot);
    const duration = snapshot.activeDurationText ? ` ${snapshot.activeDurationText}` : "";
    return label ? ` ${t("module.subagents.widget.status.active")} · ${label}${duration} ` : ` ${t("module.subagents.widget.status.active")} `;
  }
  if (snapshot.kind === "waiting") {
    const duration = snapshot.waitingDurationText ? ` ${snapshot.waitingDurationText}` : "";
    const detail = snapshot.statusLabel ? ` · ${statusLabelText(t, snapshot.statusLabel)}` : "";
    return ` ${t("module.subagents.widget.status.waiting")}${duration}${detail} `;
  }

  if (snapshot.kind === "stale-tool") {
    const duration = snapshot.activeDurationText ?? snapshot.staleDurationText ?? "";
    return ` ${t("module.subagents.widget.stale.toolRunning", { duration })} `;
  }
  if (snapshot.kind === "stale") {
    const last = activeScopeLabel(snapshot) ?? snapshot.latestEvent ?? "—";
    const duration = snapshot.staleDurationText ?? "";
    return ` ${t("module.subagents.widget.stale.noActivity", { duration, last })} `;
  }
  if (snapshot.stalledWithEvidence) {
    const duration = snapshot.snapshotProblemText ?? snapshot.staleDurationText ?? "";
    return ` ${t("module.subagents.widget.stalled.evidence", { duration })} `;
  }

  const detail = snapshot.statusLabel ? ` · ${statusLabelText(t, snapshot.statusLabel)}` : "";
  const duration = snapshot.snapshotProblemText ? ` ${snapshot.snapshotProblemText}` : "";
  return ` ${t("module.subagents.widget.status.stalled")}${detail}${duration} `;
}

function formatElapsedMMSS(startTime: number): string {
  const seconds = Math.floor((Date.now() - startTime) / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const DESCENDANT_NAME_LIMIT = 16;

function formatRowRightLabel(row: { orphan: boolean; snapshot: StatusSnapshot }): string {
  if (!isStatusEnabled()) {
    return row.orphan
      ? ` ${widgetText("module.subagents.widget.orphan")} `
      : ` ${widgetText("module.subagents.widget.status.starting")} `;
  }
  if (!row.orphan) return formatWidgetRightLabel(row.snapshot);
  return ` ${widgetText("module.subagents.widget.orphan")} · ${formatWidgetRightLabel(row.snapshot).trim()} `;
}

function widgetBorderColor(
  _snapshot: WidgetSnapshot,
  theme: any,
  _currentSessionThinkingLevel: string | undefined,
): ((text: string) => string) | undefined {
  if (!theme || typeof theme.fg !== "function") return undefined;
  return (text: string) => theme.fg("border", text);
}

function rowIdentityAndMetadata(
  row: WidgetSnapshot["rows"][number],
  tier: ReturnType<typeof subagentTreeTier>,
  level: SubagentMetadataLevel,
  muted: ((text: string) => string) | undefined,
  text?: (text: string) => string,
): { prefix: string; left: string; right: string } {
  const icon = widgetIcon(row.snapshot.kind);

  const prefix = row.depth === 0
    ? ` ${icon}  `
    : ` ${subagentTreePrefix(row.depth, row.lastFlags, row.isLast, tier, muted ?? ((text) => text))}`;
  const name = row.depth === 0 ? row.name : truncateToWidth(row.name, DESCENDANT_NAME_LIMIT, "…");
  const metadata = level === "hidden" ? null : buildSubagentMetadataSegment(row.model, row.thinking, level);
  const identity = `${formatElapsedMMSS(row.startTime)}  ${name}`;
  const left = metadata ? `${identity}  ${metadata.text}` : identity;

  const paint = text ?? ((value: string) => value);
  return { prefix, left: paint(left), right: paint(formatRowRightLabel(row)) };
}

function widgetMetadataLevel(snapshot: WidgetSnapshot, width: number, tier: ReturnType<typeof subagentTreeTier>): SubagentMetadataLevel {
  for (const level of ["full", "compact"] as const) {
    const fits = snapshot.rows.every((row) => {
      const parts = rowIdentityAndMetadata(row, tier, level, undefined);
      const budget = Math.max(0, width - 2 - visibleWidth(parts.prefix));
      return visibleWidth(parts.left) + 1 + visibleWidth(parts.right) <= budget;
    });
    if (fits) return level;
  }
  return "hidden";
}

export function renderWidgetSnapshotLines(
  snapshot: WidgetSnapshot,
  width: number,
  theme?: any,
  currentSessionThinkingLevel?: string,
): string[] {

  const colorize = widgetBorderColor(snapshot, theme, currentSessionThinkingLevel);

  const muted = theme && typeof theme.fg === "function"
    ? (text: string) => theme.fg("muted", text)
    : undefined;

  const textPaint = theme && typeof theme.fg === "function"
    ? (text: string) => theme.fg("text", text)
    : undefined;
  const lines: string[] = [
    borderTop("Subagents", widgetText("module.subagents.widget.count.running", { count: snapshot.counts.allCount }), width, colorize),
  ];
  const tier = subagentTreeTier(width);
  const metadataLevel = widgetMetadataLevel(snapshot, width, tier);

  for (const row of snapshot.rows) {
    const parts = rowIdentityAndMetadata(row, tier, metadataLevel, muted, textPaint);
    const left: StatusSegment[] = [{
      id: "identity",
      text: parts.left,
      priority: SUBAGENT_WIDGET_SEGMENT_PRIORITIES.identity,
      required: true,
    }];
    const right: StatusSegment[] = [{
      id: "status",
      text: parts.right,
      priority: SUBAGENT_WIDGET_SEGMENT_PRIORITIES.status,
      required: true,
    }];

    const prefix = parts.prefix;
    const budget = Math.max(0, width - 2 - visibleWidth(prefix));
    const layout = layoutTwoColumnSegments(left, right, budget);
    lines.push(borderLine(prefix + layout.left, layout.right, width, colorize));
    if (row.collapseAfter != null && row.collapseAfter > 0) {

      lines.push(borderLine(` ${muted ? muted("└─") : "└─"} … +${row.collapseAfter} more`, "", width, colorize));
    }
  }

  if (snapshot.counts.globalOverflow > 0) {
    lines.push(borderLine(` … +${snapshot.counts.globalOverflow} more`, "", width, colorize));
  }
  lines.push(borderBottom(width, colorize));
  return lines;
}

export function renderSubagentWidgetLines(
  agents: RunningSubagent[],
  width: number,
  theme?: any,
  currentSessionThinkingLevel?: string,
): string[] {
  return renderWidgetSnapshotLines(
    buildFirstLayerOnlySnapshot(agents, Date.now()),
    width,
    theme,
    currentSessionThinkingLevel,
  );
}

export function updateWidget() {
  if (!latestCtx?.hasUI) return;

  const firstLayer = runtimeRegistry.list();
  const snapshot = widgetRuntime.tree
    ? widgetRuntime.tree.snapshot(firstLayer, Date.now())
    : buildFirstLayerOnlySnapshot(firstLayer, Date.now());
  widgetRuntime.snapshot = snapshot;

  if (snapshot.counts.allCount === 0) {
    latestCtx.ui.setWidget("subagent-status", undefined);
    if (widgetRuntime.interval) {
      clearInterval(widgetRuntime.interval);
      widgetRuntime.interval = null;
      (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
    }
    return;
  }

  latestCtx.ui.setWidget(
    "subagent-status",
    (_tui: any, theme: any) => {
      return {
        invalidate() {},
        render(width: number) {
          return widgetRuntime.snapshot
          ? renderWidgetSnapshotLines(
              widgetRuntime.snapshot,
              width,
              theme,
              typeof latestPi?.getThinkingLevel === "function"
                ? latestPi.getThinkingLevel()
                : latestCtx?.thinkingLevel,
            )
          : [];
        },
      };
    },
    { placement: "aboveEditor" },
  );
}

export function startWidgetRefresh() {

  if (!widgetRuntime.interval) {
    widgetRuntime.interval = setInterval(() => {
      updateWidget();
    }, 1000);
    (globalThis as any)[WIDGET_INTERVAL_KEY] = widgetRuntime.interval;
  }
  updateWidget();
}
