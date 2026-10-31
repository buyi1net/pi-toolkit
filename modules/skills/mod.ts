import type { ModuleContext } from "../../kit/module.ts";
import { registryFromEvent, type SkillRegistry } from "./registry.ts";
import { createSkillTool } from "./tool.ts";

export function registerSkills(context: ModuleContext): void {
  let registry: SkillRegistry | undefined;

  context.pi.on("before_agent_start", (event) => {
    const next = registryFromEvent(event);
    if (next !== undefined) registry = next;
  });

  context.pi.registerTool(createSkillTool(() => registry, context.t("module.skills.tool.skill.label"), context.t));
}
