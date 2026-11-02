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
  SkillToolError,
  type SkillToolErrorCode,
  unknownSkillError,
  type SkillRegistry,
} from "./registry.ts";
import { formatSkillResult, listBundledFiles, readSkillFile, skillCardBodyLines } from "./content.ts";

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
  readonly error?: string;
  readonly errorCode?: SkillToolErrorCode;
  readonly errorDetail?: string;
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
      try {
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
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        const errorCode = error instanceof SkillToolError ? error.code : "load_failed";
        const errorDetail = error instanceof SkillToolError ? error.detail : text;
        return {
          content: [{ type: "text", text }],
          details: {
            name: params.skill,
            filePath: "",
            baseDir: "",
            lines: 0,
            bundledFiles: [],
            truncated: false,
            error: text,
            errorCode,
            errorDetail,
          },
          isError: true,
        };
      }
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
      const status = skillCardStatus(t, result.details);
      return renderToolCardResult(
        {
          title: t?.("module.skills.tool.skill.display") ?? "skill",
          object: result.details.name,
          status,
          details: options.expanded ? skillCardDetailLines(t, result.details, fullText) : [],
        },
        theme,
        options,
        context,
      );
    },
  };
}

function skillCardStatus(t: Translator | undefined, details: SkillToolDetails): string | undefined {
  if (details.error === undefined) {
    return t?.("module.skills.tool.skill.result.loaded", {
      name: details.name,
      lines: details.lines,
    }) ?? `Skill loaded: ${details.name} (${details.lines} lines)`;
  }
  if (t === undefined) return details.error;
  switch (details.errorCode) {
    case "not_indexed":
      return t("module.skills.tool.skill.result.notIndexed");
    case "no_skills":
      return t("module.skills.tool.skill.result.noSkills");
    case "unknown":
      return t("module.skills.tool.skill.result.unknown", { name: details.name });
    case "ambiguous":
      return t("module.skills.tool.skill.result.ambiguous", { name: details.name });
    default:
      return t("module.skills.tool.skill.result.loadFailed");
  }
}

function skillCardDetailLines(t: Translator | undefined, details: SkillToolDetails, fullText: string): string[] {
  if (details.error !== undefined) {
    switch (details.errorCode) {
      case "unknown":
        return details.errorDetail && t !== undefined
          ? [t("module.skills.tool.skill.result.suggestion", { suggestion: details.errorDetail })]
          : [];
      case "ambiguous":
        return (details.errorDetail ?? "").split("; ").filter((line) => line !== "");
      case "load_failed":
        return details.errorDetail ? [details.errorDetail] : [];
      default:
        return [];
    }
  }
  const lines = skillCardBodyLines(fullText);
  if (details.truncated && t !== undefined) {
    lines.push(t("module.skills.tool.skill.result.truncatedBody", { path: details.filePath }));
  }
  return lines;
}
