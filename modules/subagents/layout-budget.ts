export const MIN_PANE_COLS = 70;

export const MIN_PANE_ROWS = 15;

export interface PaneRect {
  width: number;
  height: number;
}

export function rectMeetsBudget(rect: PaneRect | null | undefined): boolean {
  return !!rect && rect.width >= MIN_PANE_COLS && rect.height >= MIN_PANE_ROWS;
}
