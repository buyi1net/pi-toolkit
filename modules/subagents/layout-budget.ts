/**
 * 布局预算 —— 子代理 pane 的最小可用尺寸。
 *
 * 背景(2026-08-30 事故):同一 tab 内连环分屏会把每个 pane 挤到极窄,
 * 63 列时宿主 TUI 状态栏渲染超宽直接崩溃 pi(uncaughtException)。即使
 * 不崩,过窄的 pane 也无法正常使用。防线必须在编排层:低于预算的 pane
 * 不能作为子代理载体;单 Tab 无法继续安全分屏时直接拒绝创建。
 *
 * 两表面(herdr/tmux)共用;调整阈值时两边行为自动一致。
 */

/** 子代理 pane 的最小列数。63 列已实证崩溃,70 留出余量。 */
export const MIN_PANE_COLS = 70;

/** 子代理 pane 的最小行数。 */
export const MIN_PANE_ROWS = 15;

export interface PaneRect {
  width: number;
  height: number;
}

/** 尺寸是否满足子代理最低可用预算。 */
export function rectMeetsBudget(rect: PaneRect | null | undefined): boolean {
  return !!rect && rect.width >= MIN_PANE_COLS && rect.height >= MIN_PANE_ROWS;
}
