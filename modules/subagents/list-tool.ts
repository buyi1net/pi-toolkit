import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import type { ListedAgentDefinition } from "./agents.ts";
import type { NameRegistry, NameRegistryEntry, SubagentLoadout } from "./session.ts";
import type { RuntimeRegistry } from "./registry.ts";
import {
  inheritanceBadgeText,
  routingInheritanceCause,
  routingModelOrigin,
  type RoutingInheritanceCause,
  type RoutingModelOrigin,
} from "./routing-snapshot.ts";
import type { SubagentsTranslate } from "./messages/index.ts";

export interface SubagentsListDeps {
  discoverAgents: () => ListedAgentDefinition[];

  getArtifactDir?: (sessionDir: string, sessionId: string) => string;

  registry?: RuntimeRegistry;
  readNameRegistry?: (artifactDir: string) => NameRegistry;
  readSubagentLoadout?: (sessionFile: string) => SubagentLoadout | null;
  readonly t?: SubagentsTranslate;
}

export interface SessionSubagentView {
  name: string;
  agent?: string | null;

  status: "running" | "finished" | "discarded";

  member?: boolean;

  memberRound?: "idle" | "dispatched";

  resumable: boolean;
  model?: string | null;
  tier?: string | null;

  modelSource?: RoutingModelOrigin;

  inheritanceCause?: RoutingInheritanceCause;
  cohortId?: string;
}

export function buildSessionSubagentViews(
  registry: NameRegistry,
  runtime: RuntimeRegistry | undefined,
  readSubagentLoadout: (sessionFile: string) => SubagentLoadout | null,
): SessionSubagentView[] {
  const views: SessionSubagentView[] = [];
  const consider = (name: string, entry: NameRegistryEntry) => {
    const running = runtime?.findByName(name);
    if (running) {

      const routing = running.modelRouting ?? null;
      const origin = routingModelOrigin(routing);
      const model = routing ? routing.model : running.model ?? null;
      const tier = routing ? routing.tier : running.tier ?? null;
      views.push({
        name,
        ...(running.agent ? { agent: running.agent } : {}),
        status: "running",
        ...(running.member ? { member: true, memberRound: running.dispatchedRound ? "dispatched" : "idle" } : {}),
        resumable: false,
        ...(model ? { model } : {}),
        ...(tier ? { tier } : {}),
        ...(origin ? { modelSource: origin } : {}),

        ...(origin === "parent" ? { inheritanceCause: routingInheritanceCause(routing) ?? undefined } : {}),
        ...(running.cohortId ? { cohortId: running.cohortId } : {}),
      });
      return;
    }
    const sessionExists = Boolean(entry.sessionFile) && existsSync(entry.sessionFile);
    if (!sessionExists) {

      views.push({
        name,
        status: "discarded",
        resumable: false,
        ...(entry.cohortId ? { cohortId: entry.cohortId } : {}),
      });
      return;
    }
    const loadout = readSubagentLoadout(entry.sessionFile);
    const cohortId = loadout?.cohortId ?? entry.cohortId;
    const routing = loadout?.routing ?? null;
    const origin = routingModelOrigin(routing);
    const model = routing ? routing.model : loadout?.model ?? null;
    const tier = routing ? routing.tier : loadout?.tier ?? null;
    views.push({
      name,
      ...(loadout?.agent ? { agent: loadout.agent } : {}),
      status: "finished",
      ...(loadout?.member ? { member: true } : {}),
      resumable: Boolean(loadout),
      ...(model ? { model } : {}),
      ...(tier ? { tier } : {}),
      ...(origin ? { modelSource: origin } : {}),
      ...(origin === "parent" ? { inheritanceCause: routingInheritanceCause(routing) ?? undefined } : {}),
      ...(cohortId ? { cohortId } : {}),
    });
  };
  for (const [name, entry] of Object.entries(registry)) {
    if (entry && typeof entry.sessionFile === "string") consider(name, entry);
  }

  if (runtime) {
    const known = new Set(views.map((view) => view.name));
    for (const running of runtime.list()) {
      if (!known.has(running.name)) consider(running.name, {
        sessionFile: running.sessionFile,
        sessionId: null,
        ...(running.cohortId ? { cohortId: running.cohortId } : {}),
      });
    }
  }
  views.sort((a, b) => a.name.localeCompare(b.name));
  return views;
}

function inheritedBadge(view: SessionSubagentView): string {
  if (view.modelSource !== "parent") return "";
  return inheritanceBadgeText(view.inheritanceCause);
}

function formatSessionViewLine(view: SessionSubagentView): string {
  const memberBadge = view.member
    ? view.status === "running"
      ? ` (member · ${view.memberRound ?? "idle"})`
      : " (member · offline)"
    : "";
  const badge =
    view.status === "running" && !view.member ? " (running)"
      : view.status === "discarded" ? " (discarded)" : "";
  const resumable = view.status === "finished" ? (view.resumable ? " [resumable]" : " [not resumable]") : "";
  const agent = view.agent ? ` — ${view.agent}` : "";
  const model = view.model ? ` [${view.model}]` : "";
  const tier = view.tier ? ` [tier: ${view.tier}]` : "";
  const cohort = view.cohortId ? ` [cohort: ${view.cohortId}]` : "";
  return `• ${view.name}${memberBadge}${badge}${resumable}${agent}${model}${tier}${inheritedBadge(view)}${cohort}`;
}

export function registerSubagentsListTool(
  pi: ExtensionAPI,
  deps: SubagentsListDeps,
): void {
  pi.registerTool({
    name: "subagents_list",
    label: "List Subagents",
    description:
      "List all available subagent definitions. " +
      "Scans project-local .pi/agents/ and global ~/.pi/agent/agents/. " +
      "Project-local agents override global ones with the same name. " +
      "scope=session|all additionally shows a READ-ONLY view of the subagents registered by the CURRENT parent session: " +
      "their names, whether their session files still exist, running/finished/resumable state, model/tier, " +
      "model source from the routing snapshot (fallback runs are labeled as inheriting the parent session with the reason), " +
      "and optional cohortId. " +
      "No credentials are included.",
    promptSnippet:
      "List available subagent definitions; scope=session|all also shows a read-only view of this session's registered subagents (name, session present, running/finished/resumable, model/tier, parent-session inheritance label, cohortId).",
    parameters: Type.Object({
      scope: Type.Optional(
        Type.Union(
          [Type.Literal("definitions"), Type.Literal("session"), Type.Literal("all")],
          {
            description:
              "'definitions' (default): available agent definitions only. 'session': subagents registered by the current parent session only. " +
              "'all': both views.",
          },
        ),
      ),
    }),

    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold(deps.t?.("module.subagents.tool.subagents_list.display") ?? "List subagents")), 0, 0);
    },

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const scope = params?.scope ?? "definitions";
      const definitionList = deps.discoverAgents().filter((agent) => !agent.disableModelInvocation);

      const definitionsResult = () => {
        if (definitionList.length === 0) {
          return {
            text: "No subagent definitions found.",
            details: { scope, agents: [] as ListedAgentDefinition[] },
          };
        }
        const lines = definitionList.map((agent) => {
          const badge = agent.source === "project" ? " (project)" : "";
          const description = agent.description ? ` — ${agent.description}` : "";
          const route = agent.tier ? ` [tier: ${agent.tier}]` : agent.model ? ` [${agent.model}]` : "";
          return `• ${agent.name}${badge}${route}${description}`;
        });
        return {
          text: lines.join("\n"),
          details: { scope, agents: definitionList },
        };
      };

      if (scope === "definitions") {
        const result = definitionsResult();
        return { content: [{ type: "text", text: result.text }], details: result.details };
      }

      const sessionFile = ctx?.sessionManager?.getSessionFile?.();
      if (!sessionFile || !deps.getArtifactDir || !deps.readNameRegistry) {
        return {
          content: [{
            type: "text",
            text:
              "The session view is unavailable in this context: no parent session file or no registry access. " +
              "Start pi with a persistent session to see registered subagents.",
          }],
          details: { scope, error: "session-unavailable" },
        };
      }
      const artifactDir = deps.getArtifactDir(
        ctx.sessionManager.getSessionDir(),
        ctx.sessionManager.getSessionId(),
      );
      const registry = deps.readNameRegistry(artifactDir);
      const views = buildSessionSubagentViews(registry, deps.registry, (file) =>
        deps.readSubagentLoadout
          ? deps.readSubagentLoadout(file)
          : null,
      );

      const sessionLines = () =>
        views.length === 0
          ? "No subagents have been registered in this session yet."
          : views.map(formatSessionViewLine).join("\n");

      if (scope === "session") {
        return {
          content: [{ type: "text", text: sessionLines() }],
          details: { scope, subagents: views },
        };
      }

      const definitions = definitionsResult();
      const agents = definitions.details.agents;
      const text = agents.length > 0 ? definitions.text : "No subagent definitions found.";
      return {
        content: [{
          type: "text",
          text: `${text}\n\n— Session subagents —\n${sessionLines()}`,
        }],
        details: { scope: "all", agents: definitions.details.agents, subagents: views },
      };
    },

    renderResult(result, _opts, theme) {
      const details = result.details as any;
      const scope = details?.scope ?? "definitions";
      const renderDefinitions = (): string | null => {
        const agents = details?.agents ?? [];
        if (agents.length === 0) return null;
        return agents
          .map((agent: any) => {
            const badge = agent.source === "project" ? theme.fg("accent", " (project)") : "";
            const description = agent.description ? theme.fg("dim", ` — ${agent.description}`) : "";
            const route = agent.tier
              ? theme.fg("dim", ` [tier: ${agent.tier}]`)
              : agent.model
                ? theme.fg("dim", ` [${agent.model}]`)
                : "";
            return `  ${theme.fg("toolTitle", theme.bold(agent.name))}${badge}${route}${description}`;
          })
          .join("\n");
      };
      const renderSession = (): string => {
        const subagents: SessionSubagentView[] = details?.subagents ?? [];
        if (subagents.length === 0) {
          return theme.fg("dim", "No subagents have been registered in this session yet.");
        }
        return subagents
          .map((view) => {
            const memberBadge = view.member
              ? view.status === "running"
                ? theme.fg("accent", ` (member · ${view.memberRound ?? "idle"})`)
                : theme.fg("muted", " (member · offline)")
              : "";
            const statusColor =
              view.status === "running" && !view.member ? "accent" : view.status === "discarded" ? "muted" : view.member ? "muted" : "success";
            const badge = memberBadge
              || (view.status === "running"
                ? theme.fg("accent", " (running)")
                : view.status === "discarded"
                  ? theme.fg("dim", " (discarded)")
                  : "");
            const resumable =
              view.status === "finished"
                ? view.resumable
                  ? theme.fg("success", " [resumable]")
                  : theme.fg("dim", " [not resumable]")
                : "";
            const agent = view.agent ? theme.fg("dim", ` — ${view.agent}`) : "";
            const model = view.model ? theme.fg("dim", ` [${view.model}]`) : "";
            const tier = view.tier ? theme.fg("dim", ` [tier: ${view.tier}]`) : "";
            const inherited = view.modelSource === "parent"
              ? theme.fg("warning", inheritanceBadgeText(view.inheritanceCause))
              : "";
            const cohort = view.cohortId ? theme.fg("dim", ` [cohort: ${view.cohortId}]`) : "";
            return `  ${theme.fg("toolTitle", theme.bold(view.name))}${theme.fg(statusColor, badge)}${resumable}${agent}${model}${tier}${inherited}${cohort}`;
          })
          .join("\n");
      };

      if (scope === "session") return new Text(renderSession(), 0, 0);
      if (scope === "all") {
        const defs = renderDefinitions();
        return new Text(
          `${defs ?? theme.fg("dim", "No subagent definitions found.")}\n\n${theme.fg("toolTitle", "— Session subagents —")}\n${renderSession()}`,
          0,
          0,
        );
      }
      const defs = renderDefinitions();
      return new Text(defs ?? theme.fg("dim", "No subagent definitions found."), 0, 0);
    },
  });
}
