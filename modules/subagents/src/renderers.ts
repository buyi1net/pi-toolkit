import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Box, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { SessionStats } from "./session.ts";
import { contextWindowFor, formatContextUsage, formatElapsed, formatUsageSegments } from "./display.ts";

export function registerSubagentRenderers(pi: ExtensionAPI): void {
  pi.registerMessageRenderer("subagent_result", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      invalidate() {},
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const exitCode = details.exitCode ?? 0;
        const errorMessage = typeof details.errorMessage === "string" ? details.errorMessage : "";
        const userClosed = details.userClosed === true;
        const late = details.lateDelivery === "detached";
        const failed = !userClosed && (exitCode !== 0 || !!errorMessage);
        const elapsed = details.elapsed != null ? formatElapsed(details.elapsed) : "?";
        const bgFn = userClosed
          ? (text: string) => theme.bg("customMessageBg", text)
          : failed
            ? (text: string) => theme.bg("toolErrorBg", text)
            : (text: string) => theme.bg("toolSuccessBg", text);
        const stats = (details.stats ?? null) as SessionStats | null;
        const icon = userClosed ? theme.fg("warning", "✕") : failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
        const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
        const modelTag = stats?.model ? theme.fg("dim", ` (${stats.model})`) : "";
        const lateTag = late ? theme.fg("accent", " (late delivery after detached wait)") : "";
        const title = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag}${modelTag} ${theme.fg("dim", "—")} `;

        let header: string;
        if (userClosed) {
          // 用户直接关闭 pane:稳定分类,不是 provider/agent 错误。
          header = `${title}${theme.fg("warning", "closed by user")} ${theme.fg("dim", `· ${elapsed}`)}${lateTag}`;
        } else if (failed) {
          const reason = errorMessage ? "failed (provider/agent error)" : `failed (exit ${exitCode})`;
          header = `${title}${theme.fg("error", reason)} ${theme.fg("dim", `· ${elapsed}`)}${lateTag}`;
        } else {
          const toolPart = stats ? `${stats.toolCount} tools · ${elapsed}` : elapsed;
          header = `${title}${theme.fg("dim", toolPart)}${lateTag}`;
        }

        let usageLine: string | null = null;
        if (stats) {
          const segments = formatUsageSegments(stats).map((segment) => theme.fg("dim", segment));
          if (stats.contextTokens > 0) {
            const window = contextWindowFor(stats.model);
            const context = formatContextUsage(stats.contextTokens, window);
            const percent = window ? (stats.contextTokens / window) * 100 : 0;
            segments.push(percent > 90 ? theme.fg("error", context) : percent > 70 ? theme.fg("warning", context) : theme.fg("dim", context));
          }
          if (segments.length > 0) usageLine = segments.join(theme.fg("dim", " "));
        }

        const rawContent = typeof message.content === "string" ? message.content : "";
        const summary = rawContent
          .replace(/\n\nFollow up with subagent_message[\s\S]+$/, "")
          .replace(`Sub-agent "${name}" completed (${elapsed}).\n\n`, "")
          .replace(`Sub-agent "${name}" failed (exit code ${exitCode}).\n\n`, "")
          .replace(new RegExp(`^Sub-agent "${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" failed after ${elapsed} \\(provider/agent error — auto-retry exhausted\\)\\.\\n\\n`), "");

        const contentLines = [header];
        if (usageLine) contentLines.push(usageLine);
        if (options.expanded) {
          if (summary) contentLines.push(...summary.split("\n").map((line) => truncateToWidth(line, Math.max(0, width - 6))));
          if (details.name || details.sessionFile) {
            contentLines.push("");
            if (details.name) contentLines.push(theme.fg("dim", `Session preserved: message only for NEW instructions → subagent_message({ name: "${details.name}" })`));
            if (details.sessionFile) contentLines.push(theme.fg("muted", `Session file: ${details.sessionFile}`));
          }
        } else {
          if (summary) {
            const previewLines = summary.split("\n").slice(0, 5);
            contentLines.push(...previewLines.map((line) => theme.fg("dim", truncateToWidth(line, Math.max(0, width - 6)))));
            if (summary.split("\n").length > 5) contentLines.push(theme.fg("muted", `… ${summary.split("\n").length - 5} more lines`));
          }
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  // 历史会话兼容:旧版本曾以 subagent_batch_result 消息回注批次结果,
  // 生成逻辑已随硬屏障移除,但渲染器保留,保证 /reload 或恢复会话时旧消息仍可显示。
  pi.registerMessageRenderer("subagent_batch_result", (message, options, theme) => {
    const details = message.details as any;
    const results = Array.isArray(details?.results) ? details.results : [];
    if (results.length === 0) return undefined;

    return {
      invalidate() {},
      render(width: number): string[] {
        const lineWidth = Math.max(0, width - 6);
        const contentLines = [
          `${theme.fg("accent", "◆")} ${theme.fg("toolTitle", theme.bold(`Sub-agent batch · ${results.length} results`))}`,
        ];
        for (const entry of results) {
          const failed = (entry.exitCode ?? 0) !== 0 || !!entry.errorMessage;
          const icon = failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
          const elapsed = entry.elapsed != null ? formatElapsed(entry.elapsed) : "?";
          const agentTag = entry.agent ? theme.fg("dim", ` (${entry.agent})`) : "";
          const reason = failed
            ? (entry.errorMessage ? "failed (provider/agent error)" : `failed (exit ${entry.exitCode})`)
            : "completed";
          contentLines.push(
            `${icon} ${theme.fg("toolTitle", theme.bold(entry.name ?? "subagent"))}${agentTag}` +
              theme.fg(failed ? "error" : "dim", ` — ${reason}`) +
              theme.fg("dim", ` · ${elapsed}`),
          );
        }
        if (options.expanded) {
          for (const entry of results) {
            contentLines.push("", theme.fg("toolTitle", theme.bold(entry.name ?? "subagent")));
            const summary = typeof entry.summary === "string" ? entry.summary : "";
            if (summary) {
              contentLines.push(...summary.split("\n").map((line: string) => theme.fg("dim", truncateToWidth(line, lineWidth))));
            }
            if (entry.sessionFile) contentLines.push(theme.fg("muted", `Session file: ${entry.sessionFile}`));
          }
        } else {
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }
        const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  pi.registerMessageRenderer("subagent_status", (message, options, theme) => {
    const details = message.details as any;
    const lines = Array.isArray(details?.lines) ? details.lines : [];
    const overflow = typeof details?.overflow === "number" ? details.overflow : 0;
    if (lines.length === 0 && overflow === 0) return undefined;

    return {
      invalidate() {},
      render(width: number): string[] {
        const lineWidth = Math.max(0, width - 6);
        const contentLines = [
          `${theme.fg("accent", "•")} ${theme.fg("toolTitle", theme.bold("Subagent status"))}`,
          ...lines.map((line: string) => theme.fg("dim", truncateToWidth(line, lineWidth))),
        ];
        if (overflow > 0) contentLines.push(theme.fg("muted", `+${overflow} more running.`));
        if (!options.expanded) contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  pi.registerMessageRenderer("subagent_question", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;
    return {
      invalidate() {},
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
        const header = `${theme.fg("accent", "?")} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "— asks a question")}`;
        const contentLines = [header];
        if (options.expanded) {
          contentLines.push("", details.question ?? "", "", theme.fg("dim", `Reply: subagent_message({ name: "${name}", message: "…" })`));
        } else {
          contentLines.push(theme.fg("dim", (details.question ?? "").split("\n")[0].slice(0, Math.max(0, width - 10))), theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }
        const box = new Box(1, 1, (text: string) => theme.bg("toolSuccessBg", text));
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });
}
