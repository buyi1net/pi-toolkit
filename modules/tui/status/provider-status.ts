import type { Theme } from "@earendil-works/pi-coding-agent";
import { sanitizeQuotaWindowLabel } from "../kernel/usage-core.ts";
import type { UsageRuntimeState } from "../kernel/usage-node.ts";
import type { StatusLineSegment } from "./session-status.ts";
import { sanitizeSingleLine } from "./project-status.ts";

const PROVIDER_CORAL = {
	dark: {
		truecolor: "38;2;217;119;87",
		"256color": "38;5;173",
	},
	light: {
		truecolor: "38;2;168;78;51",
		"256color": "38;5;130",
	},
} as const;

function isLightThemeName(name: string | undefined): boolean {
	return /(?:^|[-_])(light|latte|dawn)(?:$|[-_])/.test(name?.toLowerCase() ?? "");
}

function colorProviderBrand(theme: Theme, text: string): string {
	const palette = isLightThemeName(theme.name) ? PROVIDER_CORAL.light : PROVIDER_CORAL.dark;
	const mode = typeof theme.getColorMode === "function" ? theme.getColorMode() : "truecolor";
	return `\u001b[${palette[mode]}m${text}\u001b[39m`;
}

function formatMoney(amount: number, currency: "CNY" | "USD"): string {
	const value = amount.toLocaleString("en-US", {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	});
	return currency === "CNY" ? `¥${value}` : `$${value}`;
}

function remainingColor(percent: number): Parameters<Theme["fg"]>[0] {
	if (percent <= 10) return "error";
	if (percent <= 30) return "warning";
	if (percent < 60) return "accent";
	return "success";
}

export function formatResetCountdown(resetMs: number | null, now = Date.now()): string {
	if (resetMs === null) return "";
	const remainingMinutes = Math.max(0, Math.ceil((resetMs - now) / 60_000));
	if (remainingMinutes < 60) return `${remainingMinutes}m`;
	const hours = Math.floor(remainingMinutes / 60);
	const minutes = remainingMinutes % 60;
	if (hours < 24) return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
	const days = Math.floor(hours / 24);
	const remainingHours = hours % 24;
	return remainingHours > 0 ? `${days}d${remainingHours}h` : `${days}d`;
}

export interface EditorProviderSegments {
	provider: StatusLineSegment;
	balance: StatusLineSegment | null;
	subscription: StatusLineSegment | null;
}

function providerBrand(brandName: string): string {
	return sanitizeSingleLine(brandName);
}

/** 订阅额度窗口全部进入顶边 subscription 段；紧凑形态去掉重置倒计时。 */
function buildSubscriptionSegment(
	state: UsageRuntimeState,
	theme: Theme,
	now = Date.now(),
): StatusLineSegment | null {
	const snapshot = state.snapshot;
	if (
		!snapshot ||
		(snapshot.billingMode !== "subscription" && snapshot.billingMode !== "hybrid") ||
		snapshot.windows.length === 0
	) {
		return null;
	}
	const renderWindow = (withReset: boolean): string => snapshot.windows!
		.map((window) => {
			const label = sanitizeQuotaWindowLabel(window.label);
			const percent = theme.bold(`${Math.round(window.remainingPercent)}%`);
			const base = theme.fg(remainingColor(window.remainingPercent), `${label} ${percent}`);
			if (!withReset) return base;
			const reset = formatResetCountdown(window.resetMs, now);
			return reset ? `${base} ${theme.fg("muted", reset)}` : base;
		})
		.join(theme.fg("muted", " · "));
	return {
		id: "subscription",
		text: renderWindow(true),
		compactText: renderWindow(false),
		priority: 3,
	};
}

export function buildEditorProviderSegments(
	state: UsageRuntimeState,
	theme: Theme,
	now = Date.now(),
): EditorProviderSegments | null {
	if (!state.provider) return null;
	const snapshot = state.status === "ready" ? state.snapshot : null;
	const brand = providerBrand(state.provider.brandName);
	return {
		provider: {
			id: "provider",
			text: brand ? colorProviderBrand(theme, brand) : "",
			priority: 4,
		},
		balance: snapshot?.balance && (snapshot.billingMode === "api" || snapshot.billingMode === "hybrid")
			? {
				id: "balance",
				text: theme.fg("warning", formatMoney(snapshot.balance.amount, snapshot.balance.currency)),
				priority: 3,
			}
			: null,
		subscription: snapshot ? buildSubscriptionSegment(state, theme, now) : null,
	};
}
