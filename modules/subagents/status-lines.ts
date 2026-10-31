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

  const collapsed = line.replace(/\s+/g, " ").trim();
  if (collapsed.length <= MAX_STATUS_LINE_LENGTH) return collapsed;
  if (MAX_STATUS_LINE_LENGTH <= 1) return collapsed.slice(0, MAX_STATUS_LINE_LENGTH);
  return `${collapsed.slice(0, MAX_STATUS_LINE_LENGTH - 1)}…`;
}

export function statusLabelText(t: SubagentsTranslate, code: SubagentStatusLabelCode): string {
  return code === "done"
    ? t("module.subagents.widget.status.done")
    : t("module.subagents.widget.problem.wrongId");
}

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
