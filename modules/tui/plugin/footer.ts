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

/** 会话快照缺省值：宿主会话管理器未就绪时的零值占位（结构与旧行为一致） */
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

/** 生命周期钩子：卸载前的宿主过渡动作，不属于任何数据源，单独成组。 */
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

	// 宿主回调参数（tui/theme/footerData）保持原位；其余入参按数据源分组，
	// 缺省时回落到与旧位置参数一致的默认行为。段位设置每帧读取（getSettings），
	// 菜单改预设后无需重装组件即可生效。
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
		// Pi 原生 Footer 直接占用整行，不额外增加左右内边距。
		const contentWidth = Math.max(1, width);
		// Footer 第一行只展示项目路径与 Git 状态；会话短码位于编辑框顶边右侧。
		const projectLine = renderProjectStatusLine(
			{
				// 快照未接线时仍保留占位，保证 Footer 结构从首帧起定型。
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
		// 第二行沿用 Pi 原生 Footer 排版，保留实际上下文占用与压缩状态标签
		// （标签两形态一起交给段位压缩循环，窄屏自动退到紧凑形态）。
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
