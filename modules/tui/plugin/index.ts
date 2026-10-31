import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPiTuiLifecycle, type PiTuiPluginDependencies } from "./lifecycle.ts";
import type { VisibleScreenOutput } from "./screen-transition.ts";

export { PiUiEditor, formatModel } from "./editor.ts";
export { ProjectStatusFooter } from "./footer.ts";
export {
	flashVisibleScreen,
	restoreVisibleMainScreen,
} from "./screen-transition.ts";
export type { PiTuiPluginDependencies } from "./lifecycle.ts";

export type {
	EditorLayoutSource,
	FooterLayoutSource,
	ProjectEnvironmentSource,
	ProviderUsageSource,
	SessionStatusSource,
	StatusAppearance,
} from "./status-sources.ts";

export default function (
	pi: ExtensionAPI,
	output: VisibleScreenOutput = process.stdout,
	dependencies: PiTuiPluginDependencies = {},
): void {
	registerPiTuiLifecycle(pi, output, dependencies);
}
