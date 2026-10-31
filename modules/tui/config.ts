import type { ModuleConfigRecord } from "../../kit/module.ts";
import {
	parseTuiSection,
	type LoadedPiTuiConfig,
	type PiTuiConfig,
} from "./plugin/settings-config.ts";

export const TUI_MODULE_ID = "tui";
export const TUI_SECTION_LABEL = `modules.${TUI_MODULE_ID}`;

export type TuiSectionUpdate = {
	appearance?: Partial<PiTuiConfig["appearance"]>;
	advanced?: Partial<PiTuiConfig["advanced"]>;
};

export function readTuiSection(section: Record<string, unknown> | undefined): LoadedPiTuiConfig {
	return parseTuiSection(section);
}

export function tuiSectionPatch(update: TuiSectionUpdate): ModuleConfigRecord {
	return { ...update } as ModuleConfigRecord;
}
