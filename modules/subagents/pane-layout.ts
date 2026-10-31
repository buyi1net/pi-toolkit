import type { PaneRect } from "./layout-budget.ts";

export type SplitDirection = "right" | "down";

export interface LayoutPane {
  pane_id: string;
  rect: PaneRect;
}

export function chooseSplitTarget(
  layout: LayoutPane[] | null,
  parentId: string,
  managedPaneIds: Set<string>,
): LayoutPane | null {
  if (!layout) return null;
  const managed = layout.filter((pane) => managedPaneIds.has(pane.pane_id));
  if (managed.length === 0) {
    return layout.find((pane) => pane.pane_id === parentId) ?? null;
  }
  return managed.reduce<LayoutPane | null>(
    (largest, pane) =>
      !largest || pane.rect.width * pane.rect.height > largest.rect.width * largest.rect.height ? pane : largest,
    null,
  );
}

export function chooseSplitDirection(
  rect: PaneRect,
  minCols: number,
  minRows: number,
): SplitDirection | null {
  const canSplitRight = rect.width >= minCols * 2;
  const canSplitDown = rect.height >= minRows * 2;
  if (canSplitRight && canSplitDown) return rect.width >= rect.height ? "right" : "down";
  if (canSplitRight) return "right";
  if (canSplitDown) return "down";
  return null;
}
