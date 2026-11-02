import { createTableTranslator } from "../../../i18n/index.ts";
import type { MessageTables, MessageVars, ResolvedLanguage, Translator } from "../../../i18n/index.ts";

const EN = {
  "module.skills.label": "Skill tool",
  "module.skills.description": "Load Pi skills by exact name through the Claude Code compatible Skill tool",
  "module.skills.enabled.label": "Enable Skill tool",
  "module.skills.enabled.description": "Register the Claude Code compatible skill tool using Pi's resolved skill registry",
  "module.skills.tool.skill.label": "Skill",
  "module.skills.tool.skill.display": "skill",
  "module.skills.tool.skill.result.loaded": "Skill loaded: {name} ({lines} lines)",
  "module.skills.tool.skill.result.notIndexed": "Skill index is not ready yet; it will retry automatically next turn.",
  "module.skills.tool.skill.result.noSkills": "No skills are available in this session.",
  "module.skills.tool.skill.result.unknown": "Unknown skill: {name}",
  "module.skills.tool.skill.result.ambiguous": "Multiple skills match \"{name}\"",
  "module.skills.tool.skill.result.loadFailed": "Skill load failed",
  "module.skills.tool.skill.result.suggestion": "Did you mean: {suggestion}?",
  "module.skills.tool.skill.result.truncatedBody": "Body truncated; full text at {path}",
} satisfies Record<string, string>;

const ZH_CN: typeof EN = {
  "module.skills.label": "Skill 工具",
  "module.skills.description": "按精确名称通过 Claude Code 兼容的 Skill 工具加载 Pi skill",
  "module.skills.enabled.label": "启用 Skill 工具",
  "module.skills.enabled.description": "使用 Pi 已解析的 skill registry 注册 Claude Code 兼容的 skill 工具",
  "module.skills.tool.skill.label": "Skill",
  "module.skills.tool.skill.display": "技能",
  "module.skills.tool.skill.result.loaded": "已加载 Skill：{name}（{lines} 行）",
  "module.skills.tool.skill.result.notIndexed": "技能索引尚未就绪，下一轮会自动重试。",
  "module.skills.tool.skill.result.noSkills": "当前会话没有可用技能。",
  "module.skills.tool.skill.result.unknown": "未知技能：{name}",
  "module.skills.tool.skill.result.ambiguous": "「{name}」匹配到多个技能",
  "module.skills.tool.skill.result.loadFailed": "技能加载失败",
  "module.skills.tool.skill.result.suggestion": "你是不是想找：{suggestion}？",
  "module.skills.tool.skill.result.truncatedBody": "内容已截断，完整文件：{path}",
};

const ZH_TW: typeof EN = {
  "module.skills.label": "Skill 工具",
  "module.skills.description": "按精確名稱透過 Claude Code 相容的 Skill 工具載入 Pi skill",
  "module.skills.enabled.label": "啟用 Skill 工具",
  "module.skills.enabled.description": "使用 Pi 已解析的 skill registry 註冊 Claude Code 相容的 skill 工具",
  "module.skills.tool.skill.label": "Skill",
  "module.skills.tool.skill.display": "技能",
  "module.skills.tool.skill.result.loaded": "已載入 Skill：{name}（{lines} 行）",
  "module.skills.tool.skill.result.notIndexed": "技能索引尚未就緒，下一輪會自動重試。",
  "module.skills.tool.skill.result.noSkills": "目前工作階段沒有可用技能。",
  "module.skills.tool.skill.result.unknown": "未知技能：{name}",
  "module.skills.tool.skill.result.ambiguous": "「{name}」匹配到多個技能",
  "module.skills.tool.skill.result.loadFailed": "技能載入失敗",
  "module.skills.tool.skill.result.suggestion": "你是不是想找：{suggestion}？",
  "module.skills.tool.skill.result.truncatedBody": "內容已截斷，完整檔案：{path}",
};

export const SKILLS_MESSAGES = { en: EN, "zh-CN": ZH_CN, "zh-TW": ZH_TW } satisfies MessageTables;
export type SkillsMessageKey = keyof typeof EN;

export function skillsTableTranslator(language: ResolvedLanguage): Translator {
  return createTableTranslator(SKILLS_MESSAGES[language], language);
}
