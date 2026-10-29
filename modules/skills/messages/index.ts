import { formatMessage } from "../../../i18n/index.ts";
import type { MessageTables, MessageVars, ResolvedLanguage, Translator } from "../../../i18n/index.ts";

const EN = {
  "module.skills.label": "Skill tool",
  "module.skills.description": "Load Pi skills by exact name through the Claude Code compatible Skill tool",
  "module.skills.enabled.label": "Enable Skill tool",
  "module.skills.enabled.description": "Register the Claude Code compatible skill tool using Pi's resolved skill registry",
  "module.skills.tool.skill.label": "Skill",
} satisfies Record<string, string>;

const ZH_CN: typeof EN = {
  "module.skills.label": "Skill 工具",
  "module.skills.description": "按精确名称通过 Claude Code 兼容的 Skill 工具加载 Pi skill",
  "module.skills.enabled.label": "启用 Skill 工具",
  "module.skills.enabled.description": "使用 Pi 已解析的 skill registry 注册 Claude Code 兼容的 skill 工具",
  "module.skills.tool.skill.label": "Skill",
};

const ZH_TW: typeof EN = {
  "module.skills.label": "Skill 工具",
  "module.skills.description": "按精確名稱透過 Claude Code 相容的 Skill 工具載入 Pi skill",
  "module.skills.enabled.label": "啟用 Skill 工具",
  "module.skills.enabled.description": "使用 Pi 已解析的 skill registry 註冊 Claude Code 相容的 skill 工具",
  "module.skills.tool.skill.label": "Skill",
};

export const SKILLS_MESSAGES = { en: EN, "zh-CN": ZH_CN, "zh-TW": ZH_TW } satisfies MessageTables;
export type SkillsMessageKey = keyof typeof EN;

export function skillsTableTranslator(language: ResolvedLanguage): Translator {
  const table: Record<string, string> = SKILLS_MESSAGES[language];
  return (key, vars?: MessageVars) => formatMessage(table[key], key, vars);
}
