// pi-toolkit 入口：装配模块，注册 /pi-toolkit 控制菜单。
// 菜单用 pi 原生 SettingsList + getSettingsListTheme()（与原生 /settings 同组件同主题）。

import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { languageLabelKey } from "./i18n.ts";
import { groupItemId } from "./menu/items.ts";
import { createMenuTheme } from "./menu/theme.ts";
import { applyMenuChange, ToolkitMenu } from "./menu/toolkit-menu.ts";
import { ENABLED_FIELD } from "./module.ts";
import { BUILT_IN_MODULES } from "./modules/index.ts";
import { createToolkit, type Toolkit } from "./toolkit.ts";

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

function registerControlCommand(pi: ExtensionAPI, toolkit: Toolkit): void {
  pi.registerCommand("pi-toolkit", {
    // 命令说明在注册时定稿（命令表不支持随语言重建），取装载时的配置语言。
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

          if (result.kind === "language") {
            const name = t()(languageLabelKey(result.language));
            ctx.ui.notify(t()("notify.languageChanged", { language: name }), "info");
            // 语言变了要重建菜单，否则列表里的文案还是旧语言
            menu?.refresh(groupItemId("general"));
            return;
          }

          if (result.field === ENABLED_FIELD) {
            const definition = toolkit.getModuleDefinition(result.moduleId);
            const name = definition ? t()(definition.labelKey) : result.moduleId;
            ctx.ui.notify(t()("notify.moduleTogglePending", { module: name }), "warning");
          }
        } catch (error) {
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
