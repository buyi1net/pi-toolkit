import type { PaneRect } from "./layout-budget.ts";

export type SplitDirection = "right" | "down";

export interface LayoutPane {
  pane_id: string;
  rect: PaneRect;
}

/**
 * 选择下一次分屏的目标 pane。
 *
 * 布局契约:主 pane(parentId)稳定占据一侧。已有本扩展管理的 pane 时,
 * 只在 managed 区域内选面积最大的继续切分——无论 parent 面积多大都不再切
 * parent,避免主 pane 被后续分屏挤成小窗;当前布局中已无任何 managed pane
 * (尚未创建过,或均已被外部关闭)时,才首次/重新从 parent 切出。
 * managedPaneIds 里已失效的 id(pane 已不存在)会被当前布局自然过滤,
 * 不影响上述判断。
 */
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

/** 优先沿仍能满足最小尺寸的方向切分;两边都可用时沿较长轴切分。 */
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
