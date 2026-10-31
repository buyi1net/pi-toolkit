import type { ModuleConfigRecord } from "../../kit/module.ts";
import type { ProjectStatusSegmentId } from "./project-status.ts";
import type { EditorUsageSegmentId } from "./session-status.ts";

export const STATUS_MODULE_ID = "status";
export const STATUS_SECTION_LABEL = `modules.${STATUS_MODULE_ID}`;

export type StatusPresetName = "minimal" | "default" | "full";
export type EditorLeftSegmentId = "provider" | "model" | "thinking" | "balance" | "subscription" | "duration";
export type EditorRightSegmentId = "session";
export type FooterExtraSegmentId = "extensions";
export type StatusSegmentId =
	| EditorLeftSegmentId
	| EditorRightSegmentId
	| EditorUsageSegmentId
	| ProjectStatusSegmentId
	| FooterExtraSegmentId;

export interface ResolvedStatusSettings {
	preset: StatusPresetName;
	editorLeft: EditorLeftSegmentId[];
	editorRight: EditorRightSegmentId[];
	footerUsage: EditorUsageSegmentId[];
	footerPrimary: ProjectStatusSegmentId[];
	footerExtra: FooterExtraSegmentId[];
}

export interface StatusSettingsOverride {
	preset?: StatusPresetName;
	segments?: readonly StatusSegmentId[] | null;
}

const PRESET_SEGMENTS: Readonly<Record<StatusPresetName, readonly StatusSegmentId[]>> = {
	minimal: ["model", "context", "project", "session", "git"],
	default: ["provider", "model", "thinking", "balance", "subscription", "tokens", "cache", "context", "project", "session", "git", "duration", "extensions"],
	full: ["provider", "model", "thinking", "balance", "subscription", "tokens", "cache", "context", "project", "session", "git", "duration", "runtime", "extensions"],
};

const VALID_PRESETS = new Set<StatusPresetName>(["minimal", "default", "full"]);
const VALID_SEGMENTS = new Set<StatusSegmentId>(PRESET_SEGMENTS.full);
const EDITOR_LEFT = new Set<StatusSegmentId>(["provider", "model", "thinking", "balance", "subscription", "duration"]);
const EDITOR_RIGHT = new Set<StatusSegmentId>(["session"]);
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
		editorRight: segments.filter((segment): segment is EditorRightSegmentId => EDITOR_RIGHT.has(segment)),
		footerUsage: segments.filter((segment): segment is EditorUsageSegmentId => FOOTER_USAGE.has(segment)),
		footerPrimary: segments.filter((segment): segment is ProjectStatusSegmentId => FOOTER_PRIMARY.has(segment)),
		footerExtra: segments.filter((segment): segment is FooterExtraSegmentId => FOOTER_EXTRA.has(segment)),
	};
}

export interface StatusSectionConfig {
	preset: StatusPresetName;
	segments: StatusSegmentId[] | null;
	telemetry: boolean;
}

export interface LoadedStatusSection {
	readonly config: StatusSectionConfig;
	readonly warnings: string[];
}

export const DEFAULT_STATUS_SECTION: Readonly<StatusSectionConfig> = Object.freeze({
	preset: "default",
	segments: null,
	telemetry: true,
});

export type StatusSectionUpdate = Partial<{
	preset: StatusPresetName;
	segments: StatusSegmentId[] | null;
	telemetry: boolean;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readBoolean(value: unknown, fallback: boolean, field: string, warnings: string[]): boolean {
	if (value === undefined) return fallback;
	if (typeof value !== "boolean") {
		warnings.push(`${field} 必须是布尔值，已使用默认值`);
		return fallback;
	}
	return value;
}

function readPresetValue(value: unknown, warnings: string[]): StatusPresetName {
	if (value === undefined) return DEFAULT_STATUS_SECTION.preset;
	if (value === "ascii") return "default";
	if (typeof value !== "string" || !VALID_PRESETS.has(value as StatusPresetName)) {
		warnings.push("status.preset 的值无效，已使用默认值");
		return DEFAULT_STATUS_SECTION.preset;
	}
	return value as StatusPresetName;
}

function readSegments(value: unknown, warnings: string[]): StatusSegmentId[] | null {
	if (value === undefined || value === null) return null;
	if (!Array.isArray(value)) {
		warnings.push("status.segments 必须是数组或 null，已使用默认值");
		return null;
	}
	const seen = new Set<StatusSegmentId>();
	for (const segment of value) {
		if (typeof segment !== "string" || !VALID_SEGMENTS.has(segment as StatusSegmentId)) {
			warnings.push(`status.segments 包含无效值: ${String(segment)}，已忽略`);
			continue;
		}
		seen.add(segment as StatusSegmentId);
	}
	return [...seen];
}

export function readStatusSection(section: Record<string, unknown> | undefined): LoadedStatusSection {
	const warnings: string[] = [];
	const source = isRecord(section) ? section : {};
	return {
		config: {
			preset: readPresetValue(source.preset, warnings),
			segments: readSegments(source.segments, warnings),
			telemetry: readBoolean(source.telemetry, DEFAULT_STATUS_SECTION.telemetry, "status.telemetry", warnings),
		},
		warnings,
	};
}

export function statusSettingsFromSection(
	section: Record<string, unknown> | undefined,
	env: Readonly<Record<string, string | undefined>> = process.env,
): ResolvedStatusSettings {
	const { preset, segments } = readStatusSection(section).config;
	return resolveStatusSettings(env, { preset, segments });
}

export function statusSectionPatch(update: StatusSectionUpdate): ModuleConfigRecord {
	return { ...update } as ModuleConfigRecord;
}
