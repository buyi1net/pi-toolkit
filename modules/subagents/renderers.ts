import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, MouseRegion, Text, truncateToWidth, stripTerminalSequences, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { expandedToolCardIds as expandedCardIds, formatToolCardLine, cardBackground } from "../../kit/tool-card.ts";
import type { SessionStats } from "./session.ts";
import { contextWindowFor, formatContextUsage, formatElapsed, formatUsageSegments } from "./display.ts";
import { subagentsTableTranslator, type SubagentsTranslate } from "./messages/index.ts";

function subagentResultKey(details: unknown): string | null {
  if (typeof details !== "object" || details === null) return null;
  const record = details as Record<string, unknown>;
  const deliveryId = record.delivery_id;
  if (typeof deliveryId === "string" && deliveryId.trim() !== "") return `delivery:${deliveryId}`;
  const sessionFile = typeof record.sessionFile === "string" ? record.sessionFile : "";
  const name = typeof record.name === "string" ? record.name : "";
  return sessionFile !== "" || name !== "" ? `session:${sessionFile}\u0000name:${name}` : null;
}

function customCardKey(customType: string, timestamp: number | undefined): string {
  return `${customType}\u0000${timestamp ?? 0}`;
}

function cardWithClick(key: string | null, component: Component): MouseRegion {
  return new MouseRegion(component, (event) => {
    if (key === null || event.type !== "click" || event.button !== "left") return undefined;
    if (expandedCardIds.has(key)) expandedCardIds.delete(key);
    else expandedCardIds.set(key, true);
    return { handled: true };
  });
}

export function registerSubagentRenderers(
  pi: ExtensionAPI,
  t: SubagentsTranslate = subagentsTableTranslator("en"),
): void {
  pi.registerMessageRenderer("subagent_result", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;
    const key = subagentResultKey(details);

    const component = {
      invalidate() {},
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const exitCode = details.exitCode ?? 0;
        const errorMessage = typeof details.errorMessage === "string" ? details.errorMessage : "";
        const userClosed = details.userClosed === true;
        const late = details.lateDelivery === "detached";
        const failed = !userClosed && (exitCode !== 0 || !!errorMessage);
        const elapsed = details.elapsed != null ? formatElapsed(details.elapsed) : "?";
        const bgToken = userClosed ? "toolPendingBg" : failed ? "toolErrorBg" : "toolSuccessBg";
        const stats = (details.stats ?? null) as SessionStats | null;
        const status = userClosed
          ? t("module.subagents.widget.result.closedByUser")
          : failed
            ? (errorMessage
              ? t("module.subagents.widget.result.failedProvider")
              : t("module.subagents.widget.result.failedExit", { code: exitCode }))
            : t("module.subagents.widget.result.completed");
        const lateTag = late ? ` ${t("module.subagents.widget.result.late")}` : "";
        const object = [name, stats?.model].filter(Boolean).join(" · ") || undefined;

        const expanded = options.expanded || (key !== null && expandedCardIds.has(key));
        const contentLines = [formatToolCardLine({ title: t("module.subagents.widget.result.title"), object, status: `${status}${lateTag}` }, theme, failed)];

        if (expanded) {
          const meta = [
            stats ? t("module.subagents.widget.result.tools", { count: stats.toolCount }) : "",
            elapsed,
          ].filter(Boolean).join(" · ");
          contentLines.push(theme.fg("dim", meta));

          if (stats) {
            const segments = formatUsageSegments(stats).map((segment) => theme.fg("dim", segment));
            if (stats.contextTokens > 0) {
              const window = contextWindowFor(stats.model);
              const context = formatContextUsage(stats.contextTokens, window);
              const percent = window ? (stats.contextTokens / window) * 100 : 0;
              segments.push(percent > 90 ? theme.fg("error", context) : percent > 70 ? theme.fg("warning", context) : theme.fg("dim", context));
            }
            if (segments.length > 0) contentLines.push(segments.join(theme.fg("dim", " ")));
          }

          const rawContent = typeof message.content === "string" ? message.content : "";
          const summary = rawContent
            .replace(/\n\nFollow up with subagent_message[\s\S]+$/, "")
            .replace(`Sub-agent "${name}" completed (${elapsed}).\n\n`, "")
            .replace(`Sub-agent "${name}" failed (exit code ${exitCode}).\n\n`, "")
            .replace(new RegExp(`^Sub-agent "${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" failed after ${elapsed} \\(provider/agent error — auto-retry exhausted\\)\\.\\n\\n`), "");
          const summaryLines = summary
            ? summary.split("\n").flatMap((line: string) => wrapTextWithAnsi(stripTerminalSequences(line), Math.max(1, width - 2)))
            : [];
          if (summaryLines.length > 0) contentLines.push(...summaryLines.map((line) => theme.fg("dim", line)));

          if (details.name || details.sessionFile) {
            contentLines.push("");
            if (details.name) contentLines.push(theme.fg("dim", `Session preserved: continue NEW instructions with followup_task({ target: "${details.name}", task: "…" })`));
            if (details.sessionFile) contentLines.push(theme.fg("muted", `Session file: ${details.sessionFile}`));
          }
        }

        const box = new Box(1, 1, cardBackground(theme, bgToken));
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
    return cardWithClick(key, component);
  });

  pi.registerMessageRenderer("subagent_batch_result", (message, options, theme) => {
    const details = message.details as any;
    const results = Array.isArray(details?.results) ? details.results : [];
    if (results.length === 0) return undefined;
    const key = customCardKey("subagent_batch_result", message.timestamp);

    const component = {
      invalidate() {},
      render(width: number): string[] {
        const anyFailed = results.some((entry: any) => (entry.exitCode ?? 0) !== 0 || !!entry.errorMessage);
        const contentLines = [formatToolCardLine({
          title: t("module.subagents.widget.batch.title"),
          object: t("module.subagents.widget.batch.results", { count: results.length }),
          status: anyFailed ? t("module.subagents.widget.result.failed") : t("module.subagents.widget.result.completed"),
        }, theme, anyFailed)];

        const expanded = options.expanded || expandedCardIds.has(key);
        if (expanded) {
          for (const entry of results) {
            const failed = (entry.exitCode ?? 0) !== 0 || !!entry.errorMessage;
            const icon = failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
            const elapsed = entry.elapsed != null ? formatElapsed(entry.elapsed) : "?";
            const reason = failed
              ? (entry.errorMessage
                ? t("module.subagents.widget.result.failedProvider")
                : t("module.subagents.widget.result.failedExit", { code: entry.exitCode }))
              : t("module.subagents.widget.result.completed");
            contentLines.push(
              `${icon} ${theme.fg("toolTitle", theme.bold(entry.name ?? "subagent"))}` +
                theme.fg(failed ? "error" : "dim", ` — ${reason}`) +
                theme.fg("dim", ` · ${elapsed}`),
            );
            const summary = typeof entry.summary === "string" ? entry.summary : "";
            if (summary) {
              contentLines.push(...summary.split("\n").flatMap((line: string) =>
                wrapTextWithAnsi(stripTerminalSequences(line), Math.max(1, width - 2)).map((wrapped) => theme.fg("dim", wrapped)),
              ));
            }
            if (entry.sessionFile) contentLines.push(theme.fg("muted", `Session file: ${entry.sessionFile}`));
          }
        }

        const bgToken = anyFailed ? "toolErrorBg" : "toolSuccessBg";
        const box = new Box(1, 1, cardBackground(theme, bgToken));
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
    return cardWithClick(key, component);
  });

  pi.registerMessageRenderer("subagent_status", (message, options, theme) => {
    const details = message.details as any;
    const lines = Array.isArray(details?.lines) ? details.lines : [];
    const overflow = typeof details?.overflow === "number" ? details.overflow : 0;
    if (lines.length === 0 && overflow === 0) return undefined;
    const stalled = details?.tone === "error";
    const key = customCardKey("subagent_status", message.timestamp);

    const component = {
      invalidate() {},
      render(width: number): string[] {
        const lineWidth = Math.max(0, width - 6);
        const contentLines = [formatToolCardLine({
          title: t("module.subagents.widget.aggregate.title"),
          object: t("module.subagents.widget.aggregate.updates", { count: lines.length }),
          status: stalled ? t("module.subagents.widget.status.stalled") : undefined,
        }, theme, stalled)];

        const expanded = options.expanded || expandedCardIds.has(key);
        if (expanded) {
          contentLines.push(...lines.map((line: string) => theme.fg("dim", truncateToWidth(line, lineWidth))));
          if (overflow > 0) {
            contentLines.push(theme.fg("muted", t("module.subagents.widget.aggregate.overflow", { count: overflow })));
          }
        }

        const box = new Box(1, 1, cardBackground(theme, stalled ? "toolErrorBg" : "toolSuccessBg"));
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
    return cardWithClick(key, component);
  });

  pi.registerMessageRenderer("subagent_question", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;
    const key = customCardKey("subagent_question", message.timestamp);

    const component = {
      invalidate() {},
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const contentLines = [formatToolCardLine({
          title: t("module.subagents.widget.question.title"),
          object: name,
          status: t("module.subagents.widget.question.asks"),
        }, theme)];

        const expanded = options.expanded || expandedCardIds.has(key);
        if (expanded) {
          const question = typeof details.question === "string" ? details.question : "";
          const questionLines = question
            .split("\n")
            .flatMap((line: string) => wrapTextWithAnsi(stripTerminalSequences(line), Math.max(1, width - 2)));
          contentLines.push("", ...questionLines, "", theme.fg("dim", `Reply: send_message({ target: "${name}", message: "…" })`));
        }

        const box = new Box(1, 1, cardBackground(theme, "toolPendingBg"));
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
    return cardWithClick(key, component);
  });
}
