import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { languageLabelKey } from "./i18n/index.ts";
import { ID_LANGUAGE } from "./kit/menu/items.ts";
import { createMenuTheme } from "./kit/menu/theme.ts";
import { applyMenuChange, ToolkitMenu } from "./kit/menu/toolkit-menu.ts";
import { ENABLED_FIELD } from "./kit/module.ts";
import { BUILT_IN_MODULES } from "./modules/index.ts";
import { createToolkit, type Toolkit } from "./kit/toolkit.ts";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default async function piToolkit(pi: ExtensionAPI): Promise<void> {
  const toolkit = await createToolkit({
    pi,
    agentDir: getAgentDir(),
    modules: BUILT_IN_MODULES,
  });

  registerControlCommand(pi, toolkit);
  reportProblems(pi, toolkit);
}

function reportProblems(pi: ExtensionAPI, toolkit: Toolkit): void {
  if (toolkit.problems.length === 0) return;
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    const t = toolkit.getTranslator();
    for (const problem of toolkit.problems) {
      const label = t(problem.kind === "config" ? "problem.config" : "problem.module");
      ctx.ui.notify(
        t("problem.summary", { label, source: problem.source, detail: problem.detail }),
        "warning",
      );
    }
  });
}

export function registerControlCommand(pi: ExtensionAPI, toolkit: Toolkit): void {
  pi.registerCommand("pi-toolkit", {

    description: toolkit.getTranslator()("command.description"),
    handler: async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const t = () => toolkit.getTranslator();
      if (!ctx.hasUI) {
        ctx.ui.notify(t()("notify.nonInteractive"), "warning");
        return;
      }

      let menu: ToolkitMenu | undefined;

      const handleChange = async (id: string, value: string): Promise<void> => {
        try {
          const result = await applyMenuChange(toolkit, id, value);
          if (result.kind === "ignored") return;

          if (result.kind === "unmapped") {

            menu?.restoreValue(id);
            ctx.ui.notify(t()("notify.valueUnrecognized", { value }), "error");
            return;
          }

          if (result.kind === "language") {
            const name = t()(languageLabelKey(result.language));
            ctx.ui.notify(t()("notify.languageChanged", { language: name }), "info");

            registerControlCommand(pi, toolkit);
            ctx.ui.addAutocompleteProvider((current) => current);

            menu?.refresh(ID_LANGUAGE);
            return;
          }

          if (result.field === ENABLED_FIELD) {
            const definition = toolkit.getModuleDefinition(result.moduleId);
            const name = definition ? t()(definition.labelKey) : result.moduleId;
            ctx.ui.notify(t()("notify.moduleTogglePending", { module: name }), "warning");
          }
        } catch (error) {

          menu?.restoreValue(id);
          ctx.ui.notify(t()("notify.saveFailed", { reason: describeError(error) }), "error");
        }
      };

      await ctx.ui.custom((tui, theme, _keybindings, done) => {
        menu = new ToolkitMenu({
          toolkit,
          theme: createMenuTheme(theme),
          context: ctx,
          agentDir: getAgentDir(),
          requestRender: () => tui.requestRender(),
          onChange: (id, value) => {
            void handleChange(id, value);
          },
          onClose: () => done(undefined),
        });
        return menu;
      });
    },
  });
}
