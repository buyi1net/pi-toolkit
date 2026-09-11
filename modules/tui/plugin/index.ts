import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPiTuiLifecycle, type PiTuiPluginDependencies } from "./lifecycle.ts";
import type { VisibleScreenOutput } from "./screen-transition.ts";

// 视图与机制的稳定出口：测试和下游从这里 import，物理位置变化不影响调用方。
export { PiUiEditor, formatModel } from "./editor.ts";
export { ProjectStatusFooter } from "./footer.ts";
export {
	flashVisibleScreen,
	restoreVisibleMainScreen,
} from "./screen-transition.ts";
export { AutoCompactionStatusController } from "../status/auto-compaction.ts";
export type { PiTuiPluginDependencies } from "./lifecycle.ts";
// 数据源分组接口是视图构造器的公开面，随视图一起从稳定出口导出。
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
