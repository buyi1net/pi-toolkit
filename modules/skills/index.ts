import { enabledField, type ModuleConfigSchema, type ModuleContext, type ModuleDefinition } from "../../kit/module.ts";
import { registerSkills } from "./mod.ts";

export const SKILLS_MODULE_ID = "skills";

const SKILLS_CONFIG_SCHEMA: ModuleConfigSchema = {
  enabled: enabledField("module.skills.enabled.label", "module.skills.enabled.description"),
};

export function createSkillsModule(): ModuleDefinition {
  return {
    id: SKILLS_MODULE_ID,
    labelKey: "module.skills.label",
    descriptionKey: "module.skills.description",
    group: "general",
    configSchema: SKILLS_CONFIG_SCHEMA,
    topLevel: () => [],
    register(context: ModuleContext): void {
      registerSkills(context);
    },
  };
}

export const skillsModule: ModuleDefinition = createSkillsModule();
