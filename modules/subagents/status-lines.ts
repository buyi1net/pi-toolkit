// 宿主侧整句状态/过渡通知的渲染层（工单 44 从 status.ts 拆出）。
// status.ts 是纯状态机（只出 kind / statusLabel 等码，零语言）；
// 这里负责把码拼成当前语言的句子——en 句式与拆出前逐字一致，
// 三语句式由 module.subagents.widget.line.* / detail.* 键表承载。
// 取词函数默认本模块英文表（独立 -e 装载无宿主译者），宿主装配时注入
// toolkit 译者（读实时语言，切换后无需重建）。

import {
  capStatusLines,
  MAX_STATUS_LINE_LENGTH,
  normalizeStatusName,
  type StatusSnapshot,
  type SubagentStatusLabelCode,
  type SubagentStatusTransition,
} from "./status.ts";
import { subagentsTableTranslator, type SubagentsTranslate } from "./messages/index.ts";

function boundStatusLine(line: string): string {
  // 与 status.ts 拆出前同序：先归并空白再截断，保证 en 行为逐字不变
  const collapsed = line.replace(/\s+/g, " ").trim();
  if (collapsed.length <= MAX_STATUS_LINE_LENGTH) return collapsed;
  if (MAX_STATUS_LINE_LENGTH <= 1) return collapsed.slice(0, MAX_STATUS_LINE_LENGTH);
  return `${collapsed.slice(0, MAX_STATUS_LINE_LENGTH - 1)}…`;
}

/** statusLabel 码 → 显示词：done 走状态词，问题码走问题标签 */
export function statusLabelText(t: SubagentsTranslate, code: SubagentStatusLabelCode): string {
  return code === "done"
    ? t("module.subagents.widget.status.done")
    : t("module.subagents.widget.problem.wrongId");
}

/**
 * 活跃期范围标签：工具名与活动码都是数据（跨语言通用），一律原样展示——
 * 这里的第二字段是活动标识，不是自然语言（工单 44 后续修正：只有状态词与
 * 整句句式走三语，标识不翻）。scope 缺席但 label 存在的旧快照同样原样展示
 * （不推测它是哪一类）。
 */
export function activeScopeLabel(
  snapshot: Pick<StatusSnapshot, "activityLabel" | "activeScope">,
): string | null {
  return snapshot.activityLabel ?? snapshot.activeScope ?? null;
}

function formatActiveDetail(t: SubagentsTranslate, snapshot: StatusSnapshot): string {
  const label = activeScopeLabel(snapshot);
  if (!label) return t("module.subagents.widget.status.active");
  const duration = snapshot.activeDurationText ? ` ${snapshot.activeDurationText}` : "";
  return t("module.subagents.widget.detail.active", { label, duration });
}

function formatWaitingDetail(t: SubagentsTranslate, snapshot: StatusSnapshot): string {
  const duration = snapshot.waitingDurationText ? ` ${snapshot.waitingDurationText}` : "";
  return `${t("module.subagents.widget.status.waiting")}${duration}`;
}

function formatStalledDetail(t: SubagentsTranslate, snapshot: StatusSnapshot): string {
  // 工单 45：证据停滞（快照与会话双静默 ≥120s）带证据文字；现行 60s 停滞
  // 维持原句式（问题标签 + 快照问题时长）。
  if (snapshot.stalledWithEvidence) {
    const duration = snapshot.snapshotProblemText ?? snapshot.staleDurationText ?? "";
    return t("module.subagents.widget.stalled.evidence", { duration });
  }
  const detail = snapshot.statusLabel
    ? t("module.subagents.widget.detail.paren", { label: statusLabelText(t, snapshot.statusLabel) })
    : "";
  const duration = snapshot.snapshotProblemText ? ` ${snapshot.snapshotProblemText}` : "";
  return `${t("module.subagents.widget.status.stalled")}${duration}${detail}`;
}

/** 工单 45：stale 档（信息陈旧）的最后活动标签；拿不到时用中性破折号。 */
function staleLastLabel(t: SubagentsTranslate, snapshot: Pick<StatusSnapshot, "activityLabel" | "activeScope" | "latestEvent">): string {
  return activeScopeLabel(snapshot) ?? snapshot.latestEvent ?? "—";
}

function formatStaleDetail(t: SubagentsTranslate, snapshot: StatusSnapshot): string {
  const duration = snapshot.staleDurationText ?? "";
  return t("module.subagents.widget.stale.noActivity", { duration, last: staleLastLabel(t, snapshot) });
}

function formatStaleToolDetail(t: SubagentsTranslate, snapshot: StatusSnapshot): string {
  const duration = snapshot.activeDurationText ?? snapshot.staleDurationText ?? "";
  return t("module.subagents.widget.stale.toolRunning", { duration });
}

export function formatStatusLine(
  name: string,
  snapshot: StatusSnapshot,
  t: SubagentsTranslate = subagentsTableTranslator("en"),
): string {
  const boundedName = normalizeStatusName(name);

  if (snapshot.kind === "starting") {
    const detail = snapshot.statusLabel
      ? t("module.subagents.widget.detail.paren", { label: statusLabelText(t, snapshot.statusLabel) })
      : "";
    return boundStatusLine(
      t("module.subagents.widget.line.starting", { name: boundedName, elapsed: snapshot.elapsedText, detail }),
    );
  }

  if (snapshot.kind === "running") {
    return boundStatusLine(
      t("module.subagents.widget.line.running", { name: boundedName, elapsed: snapshot.elapsedText }),
    );
  }

  if (snapshot.kind === "active") {
    return boundStatusLine(
      t("module.subagents.widget.line.detail", {
        name: boundedName,
        elapsed: snapshot.elapsedText,
        detail: formatActiveDetail(t, snapshot),
      }),
    );
  }

  if (snapshot.kind === "waiting") {
    const problem = snapshot.statusLabel
      ? t("module.subagents.widget.detail.paren", { label: statusLabelText(t, snapshot.statusLabel) })
      : "";
    return boundStatusLine(
      t("module.subagents.widget.line.detail", {
        name: boundedName,
        elapsed: snapshot.elapsedText,
        detail: `${formatWaitingDetail(t, snapshot)}${problem}`,
      }),
    );
  }

  // 工单 45：stale / stale-tool 不冒充 active，也不误报 stalled。
  if (snapshot.kind === "stale") {
    return boundStatusLine(
      t("module.subagents.widget.line.detail", {
        name: boundedName,
        elapsed: snapshot.elapsedText,
        detail: formatStaleDetail(t, snapshot),
      }),
    );
  }

  if (snapshot.kind === "stale-tool") {
    return boundStatusLine(
      t("module.subagents.widget.line.detail", {
        name: boundedName,
        elapsed: snapshot.elapsedText,
        detail: formatStaleToolDetail(t, snapshot),
      }),
    );
  }

  return boundStatusLine(
    t("module.subagents.widget.line.detail", {
      name: boundedName,
      elapsed: snapshot.elapsedText,
      detail: formatStalledDetail(t, snapshot),
    }),
  );
}

export function formatTransitionLine(
  name: string,
  snapshot: StatusSnapshot,
  transition: Exclude<SubagentStatusTransition, null>,
  t: SubagentsTranslate = subagentsTableTranslator("en"),
): string {
  const boundedName = normalizeStatusName(name);

  if (transition === "recovered") {
    const detail = snapshot.kind === "waiting"
      ? formatWaitingDetail(t, snapshot)
      : formatActiveDetail(t, snapshot);
    return boundStatusLine(
      t("module.subagents.widget.line.recovered", { name: boundedName, elapsed: snapshot.elapsedText, detail }),
    );
  }

  return formatStatusLine(boundedName, snapshot, t);
}

export function formatStatusAggregate(
  lines: string[],
  lineLimit: number,
  t: SubagentsTranslate = subagentsTableTranslator("en"),
): string {
  const { visibleLines, overflow } = capStatusLines(lines, lineLimit);
  const bulletLines = visibleLines.map((line) => `• ${line}`);
  if (overflow > 0) {
    bulletLines.push(`• ${t("module.subagents.widget.aggregate.overflow", { count: overflow })}`);
  }
  return `${t("module.subagents.widget.aggregate.title")}:\n${bulletLines.join("\n")}`;
}
