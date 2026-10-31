import type { ContextUsage, ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";
import {
	truncateToWidth,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";
import type { UsageRuntimeState } from "../../providers/api.ts";
import {
	resolveStatusSettings,
	type ResolvedStatusSettings,
	type SessionStatusSnapshot,
	type TurnTimerSnapshot,
} from "../../status/api.ts";
import { sanitizeStyledSingleLine } from "../../../shared/sanitize.ts";
import { resolveGlyphs, type IconGlyphs } from "../renderer/icons.ts";
import { renderProjectStatusLine } from "../status/project-status.ts";
import { renderStatusLineSegments } from "../status/segment-layout.ts";
import { buildEditorUsageSegments } from "../status/session-status.ts";
import type {
	FooterLayoutSource,
	ProjectEnvironmentSource,
	SessionStatusSource,
	StatusAppearance,
} from "./status-sources.ts";

const EMPTY_SESSION_STATUS: SessionStatusSnapshot = Object.freeze({
	sessionId: "",
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	cost: 0,
	turns: 0,
	compactions: 0,
});

export interface ProjectStatusFooterHooks {
	beforeDispose?: () => void;
}

export class ProjectStatusFooter implements Component {
	private readonly theme: Theme;
	private readonly footerData: ReadonlyFooterDataProvider;
	private readonly getProjectStatus: ProjectEnvironmentSource["getProjectStatus"];
	private readonly cwd: string;
	private readonly beforeDispose: (() => void) | undefined;
	private readonly getGlyphs: () => IconGlyphs;
	private readonly getSettings: () => ResolvedStatusSettings;
	private readonly getRuntimeStatus: ProjectEnvironmentSource["getRuntimeStatus"];
	private readonly reportHeight: ((height: number) => void) | undefined;
	private readonly getTimer: () => TurnTimerSnapshot | undefined;
	private readonly getSessionStatus: () => SessionStatusSnapshot;
	private readonly getContextUsage: () => ContextUsage | undefined;
	private readonly getContextWindow: () => number | undefined;
	private readonly getCompressionLabel: (compact: boolean) => string;
	private disposed = false;

	constructor(
		_tui: TUI,
		theme: Theme,
		footerData: ReadonlyFooterDataProvider,
		appearance: StatusAppearance = {},
		project: ProjectEnvironmentSource = {},
		session: SessionStatusSource = {},
		layout: FooterLayoutSource = {},
		hooks: ProjectStatusFooterHooks = {},
	) {
		this.theme = theme;
		this.footerData = footerData;
		this.getGlyphs = appearance.getGlyphs ?? (() => resolveGlyphs("unicode"));
		this.getSettings = appearance.getSettings ?? (() => resolveStatusSettings({}));
		this.getProjectStatus = project.getProjectStatus;
		this.getRuntimeStatus = project.getRuntimeStatus;
		this.cwd = project.cwd ?? process.cwd();
		this.reportHeight = layout.reportHeight;
		this.getTimer = session.getTimer ?? (() => undefined);
		this.getSessionStatus = () => session.getSessionStatus?.() ?? EMPTY_SESSION_STATUS;
		this.getContextUsage = session.getContextUsage ?? (() => undefined);
		this.getContextWindow = session.getContextWindow ?? (() => undefined);
		this.getCompressionLabel = session.getCompressionLabel ?? (() => "");
		this.beforeDispose = hooks.beforeDispose;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const glyphs = this.getGlyphs();
		const settings = this.getSettings();

		const contentWidth = Math.max(1, width);

		const projectLine = renderProjectStatusLine(
			{

				...(this.getProjectStatus?.() ?? { cwd: this.cwd, branch: null }),
				runtime: this.getRuntimeStatus?.(),
				duration: this.getTimer(),
			},
			contentWidth,
			this.theme,
			undefined,
			glyphs,
			settings.footerPrimary,
			false,
		);

		const contextUsage = this.getContextUsage();
		const usageSegments = buildEditorUsageSegments(
			this.getSessionStatus(),
			contextUsage,
			this.getContextWindow(),
			this.theme,
			glyphs,
			contextUsage === undefined
				? settings.footerUsage.filter((segment) => segment === "context")
				: settings.footerUsage,
			{
				text: this.getCompressionLabel(false),
				compactText: this.getCompressionLabel(true),
			},
			true,
		);
		const nativeFooterSeparator = " ";
		const renderedUsageSegments = renderStatusLineSegments(
			usageSegments,
			contentWidth,
			nativeFooterSeparator,
		);
		const usageLine = usageSegments.length > 0
			? this.theme.fg("dim", truncateToWidth(renderedUsageSegments, contentWidth))
			: "";
		const showExtensions = settings.footerExtra.includes("extensions");
		const statuses = showExtensions
			? [...this.footerData.getExtensionStatuses().entries()]
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([, status]) => sanitizeStyledSingleLine(status))
				.filter(Boolean)
			: [];
		const lines = projectLine ? [projectLine] : [];
		if (usageLine) lines.push(usageLine);
		if (statuses.length > 0) {
			lines.push(truncateToWidth(statuses.join(" · "), contentWidth, this.theme.fg("dim", "…")));
		}
		this.reportHeight?.(lines.length);
		return lines;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.beforeDispose?.();
		this.reportHeight?.(0);
	}
}
