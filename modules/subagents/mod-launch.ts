import { dirname, join, resolve, sep } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { shellEscape } from "./surface.ts";
import { latestPi } from "./mod.ts";
import { getAgentConfigDir, getToolExtensionPath, SUBAGENTS_DIR } from "./mod-host.ts";
import { resolveAppliedThinking } from "./routing-snapshot.ts";
import { modelOwnThinkingSuffix } from "./routing.ts";
import { canGrantSpawningToChild, declaredMcpTools, SPAWNING_TOOLS } from "./launch-config.ts";
import { sanitizeSubagentFileName } from "./names.ts";
import { isWithin } from "./descendants.ts";
import type { SubagentLoadout } from "./session.ts";
import { debugLog } from "./diagnostics.ts";

export function buildHeadlessPrompt(
  effectiveSkills: string | undefined,
  task: string,
  resolveSkill: (name: string) => { path: string } | null = (name) => {
    try {
      const command = latestPi?.getCommands().find(
        (candidate) => candidate.source === "skill" && candidate.name === `skill:${name}`,
      );
      const path = command?.sourceInfo?.path;
      return typeof path === "string" && existsSync(path) ? { path } : null;
    } catch (error) {
      debugLog(`Could not resolve skill ${name} for headless prompt`, error);
      return null;
    }
  },
): string {
  const names = (effectiveSkills ?? "")
    .split(",")
    .map((name) => name.trim().replace(/^\/skill:/, ""))
    .filter(Boolean);
  const blocks: string[] = [];
  const unresolved: string[] = [];

  for (const name of names) {
    const resolved = resolveSkill(name);
    if (!resolved) {
      unresolved.push(name);
      continue;
    }
    try {
      const raw = readFileSync(resolved.path, "utf8");
      const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, "").trim();
      if (!body) {
        unresolved.push(name);
        continue;
      }
      blocks.push(
        `<skill name="${name}" location="${resolved.path}">\n` +
          `References are relative to ${dirname(resolved.path)}.\n\n` +
          `${body}\n</skill>`,
      );
    } catch (error) {
      unresolved.push(name);
      debugLog(`Could not read skill ${name} at ${resolved.path}`, error);
    }
  }

  if (unresolved.length > 0) {

    blocks.push(
      `The following configured skills could not be expanded by the orchestrator: ` +
        `${unresolved.join(", ")}. Before acting, locate and read each skill's ` +
        `SKILL.md from the available skills list if it is present.`,
    );
  }

  return [...blocks, task].filter((part) => part.length > 0).join("\n\n");
}

function ownPackageName(): string | null {
  try {
    const pkg: unknown = JSON.parse(readFileSync(join(SUBAGENTS_DIR, "..", "..", "package.json"), "utf8"));
    const name = (pkg as { name?: unknown } | null)?.name;
    return typeof name === "string" && name ? name : null;
  } catch {
    return null;
  }
}

function entryPackageName(entry: string, baseDir: string): string | null {
  if (entry.startsWith("npm:")) {
    let spec = entry.slice("npm:".length);
    if (spec.startsWith("@")) {

      const rest = spec.slice(1);
      const at = rest.indexOf("@");
      spec = at >= 0 ? `@${rest.slice(0, at)}` : `@${rest}`;
    } else {
      const at = spec.indexOf("@");
      if (at >= 0) spec = spec.slice(0, at);
    }
    return spec;
  }
  if (entry.startsWith("git:")) {
    const pathPart = entry.split("#")[0].replace(/^git:(https?:\/\/)?/, "");
    return pathPart.split("/").filter(Boolean).pop() ?? null;
  }
  return resolve(baseDir, entry).split(/[\\/]/).filter(Boolean).pop() ?? null;
}

function childDiscoversOwnPackage(agentDir: string | null): boolean {
  const dir = agentDir ?? join(homedir(), ".pi", "agent");
  const target = resolve(SUBAGENTS_DIR);
  const own = ownPackageName();
  try {
    const settings: unknown = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
    const packages = (settings as { packages?: unknown } | null)?.packages;
    if (!Array.isArray(packages)) return false;
    for (const raw of packages) {

      const entry = typeof raw === "string"
        ? raw
        : raw && typeof raw === "object"
          ? [((raw as { source?: unknown }).source), ((raw as { id?: unknown }).id)].find(
              (value): value is string => typeof value === "string",
            ) ?? null
          : null;
      if (!entry) continue;
      const isLocalEntry = !entry.startsWith("npm:") && !entry.startsWith("git:");
      const name = entryPackageName(entry, dir);
      if (own && name === own) return true;
      if (own && !entry.startsWith("npm:") && name === own.split("/").pop()) return true;

      if (isLocalEntry && isWithin(target, resolve(dir, entry))) return true;
    }
  } catch {
    return false;
  }
  return false;
}

export function applySandboxToParts(
  parts: string[],
  loadout: SubagentLoadout,
  opts: { artifactDir: string; name: string },

  options?: { escape?: (value: string) => string },
): string[] {
  const escape = options?.escape ?? shellEscape;

  if (loadout.model) {

    const requested = resolveAppliedThinking(loadout).level;
    let model = loadout.model;
    if (requested != null) {
      const own = modelOwnThinkingSuffix(model);
      if (own) model = model.slice(0, model.length - own.length - 1);
      model = `${model}:${requested}`;
    }
    parts.push("--model", escape(model));
  }

  const contextArtifacts: string[] = [];
  if (loadout.identity) {
    const flag = loadout.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt";
    const spTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const spSafeName = sanitizeSubagentFileName(opts.name);
    const spPath = join(opts.artifactDir, `context/${spSafeName || "subagent"}-sysprompt-${spTimestamp}.md`);
    mkdirSync(dirname(spPath), { recursive: true });
    writeFileSync(spPath, loadout.identity, "utf8");
    contextArtifacts.push(spPath);
    parts.push(flag, escape(spPath));
  }

  if (typeof loadout.toolAllowlist === "string") {
    parts.push("--tools", escape(loadout.toolAllowlist));

    const extPaths = new Set<string>();
    for (const tool of loadout.toolAllowlist.split(",")) {
      const extPath = getToolExtensionPath(tool);
      if (extPath && existsSync(extPath)) extPaths.add(extPath);
    }

    const trustedRoots = [resolve(SUBAGENTS_DIR), resolve(join(getAgentConfigDir(), "extensions"))];

    const selfEntryPath = resolve(fileURLToPath(new URL("./mod.ts", import.meta.url)));
    const skipSelfInjection = childDiscoversOwnPackage(loadout.agentDir);
    for (const extPath of extPaths) {
      const resolved = resolve(extPath);
      if (!trustedRoots.some((root) => resolved === root || resolved.startsWith(root + sep))) continue;
      if (skipSelfInjection && resolved === selfEntryPath) continue;
      parts.push("-e", escape(resolved));
    }
  }

  if (typeof loadout.toolAllowlist === "string" && declaredMcpTools(loadout.toolAllowlist).length === 0) {
    parts.push("--no-mcp");
  }

  const excluded = new Set<string>();
  if (!canGrantSpawningToChild()) {
    for (const tool of SPAWNING_TOOLS) excluded.add(tool);
  }
  if (loadout.forkTurns === "all") {
    excluded.add("peers_list");
    excluded.add("peers_send");
  }
  if (excluded.size > 0) {
    parts.push("--exclude-tools", escape([...excluded].join(",")));
  }
  return contextArtifacts;
}
