import type { ProjectStatusSegmentId } from "./project-status.ts";
import type { EditorUsageSegmentId } from "./session-status.ts";

export type StatusPresetName = "minimal" | "default" | "full";
export type EditorLeftSegmentId = "provider" | "model" | "thinking" | "balance" | "subscription" | "duration";
export type FooterExtraSegmentId = "extensions";
export type StatusSegmentId =
	| EditorLeftSegmentId
	| EditorUsageSegmentId
	| ProjectStatusSegmentId
	| FooterExtraSegmentId;

export interface ResolvedStatusSettings {
	preset: StatusPresetName;
	editorLeft: EditorLeftSegmentId[];
	footerUsage: EditorUsageSegmentId[];
	footerPrimary: ProjectStatusSegmentId[];
	footerExtra: FooterExtraSegmentId[];
}

export interface StatusSettingsOverride {
	preset?: StatusPresetName;
	segments?: readonly StatusSegmentId[] | null;
}

const PRESET_SEGMENTS: Readonly<Record<StatusPresetName, readonly StatusSegmentId[]>> = {
	minimal: ["model", "context", "project", "git"],
	default: ["provider", "model", "thinking", "balance", "subscription", "tokens", "cache", "context", "project", "git", "duration", "extensions"],
	full: ["provider", "model", "thinking", "balance", "subscription", "tokens", "cache", "context", "project", "git", "duration", "runtime", "extensions"],
};

const VALID_PRESETS = new Set<StatusPresetName>(["minimal", "default", "full"]);
const VALID_SEGMENTS = new Set<StatusSegmentId>(PRESET_SEGMENTS.full);
const EDITOR_LEFT = new Set<StatusSegmentId>(["provider", "model", "thinking", "balance", "subscription", "duration"]);
const FOOTER_USAGE = new Set<StatusSegmentId>(["tokens", "cache", "context"]);
const FOOTER_PRIMARY = new Set<StatusSegmentId>(["project", "git", "runtime"]);
const FOOTER_EXTRA = new Set<StatusSegmentId>(["extensions"]);

export const STATUS_PRESET_NAMES: readonly StatusPresetName[] = ["minimal", "default", "full"];
export const STATUS_SEGMENT_IDS: readonly StatusSegmentId[] = PRESET_SEGMENTS.full;

export function statusPresetSegments(preset: StatusPresetName): StatusSegmentId[] {
	return [...PRESET_SEGMENTS[preset]];
}

export function readStatusPreset(
	env: Readonly<Record<string, string | undefined>> = process.env,
): StatusPresetName {
	const candidate = env.PI_UI_STATUS_PRESET?.trim().toLowerCase() as StatusPresetName | undefined;
	return candidate && VALID_PRESETS.has(candidate) ? candidate : "default";
}

function readSegmentOrder(
	preset: StatusPresetName,
	env: Readonly<Record<string, string | undefined>>,
): StatusSegmentId[] {
	const raw = env.PI_UI_STATUS_SEGMENTS?.trim();
	if (!raw) return [...PRESET_SEGMENTS[preset]];

	const seen = new Set<StatusSegmentId>();
	for (const token of raw.split(",")) {
		const segment = token.trim().toLowerCase() as StatusSegmentId;
		if (VALID_SEGMENTS.has(segment)) seen.add(segment);
	}
	return seen.size > 0 ? [...seen] : [...PRESET_SEGMENTS[preset]];
}

function normalizeSegmentOrder(segments: readonly StatusSegmentId[]): StatusSegmentId[] {
	const seen = new Set<StatusSegmentId>();
	for (const segment of segments) {
		if (VALID_SEGMENTS.has(segment)) seen.add(segment);
	}
	return [...seen];
}

export function resolveStatusSettings(
	env: Readonly<Record<string, string | undefined>> = process.env,
	override: StatusSettingsOverride = {},
): ResolvedStatusSettings {
	const preset = env.PI_UI_STATUS_PRESET?.trim()
		? readStatusPreset(env)
		: override.preset ?? "default";
	const segments = env.PI_UI_STATUS_SEGMENTS?.trim()
		? readSegmentOrder(preset, env)
		: override.segments === undefined || override.segments === null
			? statusPresetSegments(preset)
			: normalizeSegmentOrder(override.segments);
	return {
		preset,
		editorLeft: segments.filter((segment): segment is EditorLeftSegmentId => EDITOR_LEFT.has(segment)),
		footerUsage: segments.filter((segment): segment is EditorUsageSegmentId => FOOTER_USAGE.has(segment)),
		footerPrimary: segments.filter((segment): segment is ProjectStatusSegmentId => FOOTER_PRIMARY.has(segment)),
		footerExtra: segments.filter((segment): segment is FooterExtraSegmentId => FOOTER_EXTRA.has(segment)),
	};
}
