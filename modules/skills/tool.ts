import type { Translator } from "../../i18n/index.ts";
import { renderToolCardCall, renderToolCardResult } from "../../kit/tool-card.ts";
import type {
  AgentToolResult,
  Theme,
  ToolDefinition,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import {
  ambiguousSkillError,
  findSkill,
  noSkillsError,
  notIndexedError,
  unknownSkillError,
  type SkillRegistry,
} from "./registry.ts";
import { formatSkillResult, listBundledFiles, readSkillFile } from "./content.ts";

export const skillParameters = Type.Object({
  skill: Type.String({
    description: 'Skill name exactly as listed in <available_skills>, for example "grilling" or "/skill:grilling".',
  }),
  args: Type.Optional(
    Type.String({
      description: "Optional request text appended after the skill instructions, like /skill:<name> arguments.",
    }),
  ),
});

export type SkillToolParams = Static<typeof skillParameters>;

export interface SkillToolDetails {
  readonly name: string;
  readonly filePath: string;
  readonly baseDir: string;
  readonly lines: number;
  readonly bundledFiles: readonly string[];
  readonly truncated: boolean;
}

const DESCRIPTION = [
  "Load one Pi skill's full instructions by exact name.",
  "Pi provides the resolved skill name, description, and location in <available_skills>.",
  "Call this tool instead of reading a SKILL.md file directly.",
  "Resolve relative references against the baseDir returned in the result.",
].join(" ");

const PROMPT_GUIDELINES = [
  "Use the skill tool when a task matches a skill in <available_skills>, when the user names a skill, or when loaded instructions say to call the Skill tool.",
  "Pass the exact skill name from <available_skills>; do not pass a filesystem path and do not choose a fuzzy match.",
  "After loading a skill, resolve its relative references against the baseDir reported by the tool result.",
];

export type SkillRegistryGetter = () => SkillRegistry | undefined;

export function createSkillTool(
  getRegistry: SkillRegistryGetter,
  label = "Skill",
  t?: Translator,
): ToolDefinition<typeof skillParameters, SkillToolDetails> {
  return {
    name: "skill",
    label,
    description: DESCRIPTION,
    promptSnippet: "Load a skill's full instructions by exact name",
    promptGuidelines: PROMPT_GUIDELINES,
    parameters: skillParameters,
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    async execute(_toolCallId, params): Promise<AgentToolResult<SkillToolDetails>> {
      const registry = getRegistry();
      if (registry === undefined) throw notIndexedError();
      if (registry.skills.length === 0) throw noSkillsError();

      const lookup = findSkill(registry.skills, params.skill);
      if (lookup.kind === "missing") throw unknownSkillError(registry, params.skill);
      if (lookup.kind === "ambiguous") throw ambiguousSkillError(lookup.skills, params.skill);

      const { body, truncated } = await readSkillFile(lookup.skill);
      const bundledFiles = await listBundledFiles(lookup.skill.baseDir);
      const text = formatSkillResult({
        skill: lookup.skill,
        body,
        args: params.args,
        bundledFiles,
        truncated,
      });

      return {
        content: [{ type: "text", text }],
        details: {
          name: lookup.skill.name,
          filePath: lookup.skill.filePath,
          baseDir: lookup.skill.baseDir,
          lines: body === "" ? 0 : body.split("\n").length,
          bundledFiles: bundledFiles.files,
          truncated,
        },
      };
    },
    renderShell: "self",
    renderCall(args: SkillToolParams, theme: Theme, context) {
      const title = t?.("module.skills.tool.skill.display") ?? "skill";
      return renderToolCardCall({ title, object: args.skill }, theme, context);
    },
    renderResult(
      result: AgentToolResult<SkillToolDetails>,
      options: ToolRenderResultOptions,
      theme: Theme,
      context,
    ) {
      const textPart = result.content.find((part) => part.type === "text");
      const fullText = textPart && textPart.type === "text" ? textPart.text : "";
      const status = t?.("module.skills.tool.skill.result.loaded", {
        name: result.details.name,
        lines: result.details.lines,
      }) ?? `Skill loaded: ${result.details.name} (${result.details.lines} lines)`;
      return renderToolCardResult(
        { title: t?.("module.skills.tool.skill.display") ?? "skill", object: result.details.name, status, details: options.expanded ? fullText.split("\n") : [] },
        theme,
        options,
        context,
      );
    },
  };
}
