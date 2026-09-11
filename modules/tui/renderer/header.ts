import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
	CUSTOM_HEADER_ANIMATION_DURATIONS_MS,
	CUSTOM_HEADER_LOGO_FRAMES,
	renderCustomHeader,
	type CustomHeaderSnapshot,
} from "./custom-header.ts";
import type { IconGlyphs } from "./icons.ts";

export class PiTuiHeader implements Component {
	private readonly getSnapshot: () => CustomHeaderSnapshot;
	private readonly getTheme: () => Theme;
	private readonly getGlyphs: () => IconGlyphs;
	private readonly requestRender: () => void;
	private animationFrame = 0;
	private animationStopped = false;
	private cancelAnimation: (() => void) | undefined;
	private readonly scheduleTimeout: (callback: () => void, delayMs: number) => () => void;

	constructor(
		getSnapshot: () => CustomHeaderSnapshot,
		getTheme: () => Theme,
		getGlyphs: () => IconGlyphs,
		requestRender: () => void = () => {},
		// 为保持与 setTimeout 一致，注入调度器也须延后调用，并返回取消函数。
		scheduleTimeout = (callback: () => void, delayMs: number): (() => void) => {
			const timer = setTimeout(callback, delayMs);
			return () => clearTimeout(timer);
		},
	) {
		this.getSnapshot = getSnapshot;
		this.getTheme = getTheme;
		this.getGlyphs = getGlyphs;
		this.requestRender = requestRender;
		this.scheduleTimeout = scheduleTimeout;
		this.scheduleNextAnimationFrame();
	}

	private scheduleNextAnimationFrame(): void {
		if (this.animationStopped || this.animationFrame >= CUSTOM_HEADER_LOGO_FRAMES.length - 1) return;
		this.cancelAnimation = this.scheduleTimeout(() => {
			this.cancelAnimation = undefined;
			this.animationFrame += 1;
			this.requestRender();
			this.scheduleNextAnimationFrame();
		}, CUSTOM_HEADER_ANIMATION_DURATIONS_MS[this.animationFrame] ?? 80);
	}

	private stopAnimation(): void {
		// 重绘回调可能同步 dispose，此时尚未安排下一帧，单靠取消定时器无法阻止续播。
		this.animationStopped = true;
		this.cancelAnimation?.();
		this.cancelAnimation = undefined;
	}

	invalidate(): void {}

	render(width: number): string[] {
		return renderCustomHeader(
			this.getSnapshot(),
			width,
			this.getTheme(),
			this.getGlyphs(),
			CUSTOM_HEADER_LOGO_FRAMES[this.animationFrame],
		);
	}

	dispose(): void {
		this.stopAnimation();
	}
}
