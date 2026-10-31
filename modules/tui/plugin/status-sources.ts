import type { ContextUsage } from "@earendil-works/pi-coding-agent";
import type { UsageRuntimeState } from "../../providers/api.ts";
import type {
	ProjectStatusSnapshot,
	ResolvedStatusSettings,
	RuntimeStatusSnapshot,
	SessionStatusSnapshot,
	TurnTimerSnapshot,
} from "../../status/api.ts";
import type { IconGlyphs } from "../renderer/icons.ts";

export interface SessionStatusSource {
	getTimer?: () => TurnTimerSnapshot | undefined;
	getSessionStatus?: () => SessionStatusSnapshot | undefined;

	getSessionId?: () => string | null;
	getContextUsage?: () => ContextUsage | undefined;
	getContextWindow?: () => number | undefined;

	getCompressionLabel?: (compact: boolean) => string;
}

export interface ProviderUsageSource {
	getState?: () => UsageRuntimeState | undefined;
}

export interface ProjectEnvironmentSource {
	getProjectStatus?: () => Readonly<ProjectStatusSnapshot> | undefined;
	getRuntimeStatus?: () => Readonly<RuntimeStatusSnapshot> | null | undefined;
	cwd?: string;
}

export interface FooterLayoutSource {
	reportHeight?: (height: number) => void;
}

export interface EditorLayoutSource {
	getFooterHeight?: () => number;
}

export interface StatusAppearance {
	getGlyphs?: () => IconGlyphs;

	getSettings?: () => ResolvedStatusSettings;
}
