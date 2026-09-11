// 视觉探测素材：一张 6 格彩色格子 PNG，加上从左到右、从上到下的期望颜色。
// 常量 VISION_PROBE_IMAGE / VISION_PROBE_EXPECTED 随本模块装配原样迁入，
// 不改图也不改期望值，探测判定仍是 6 格过 5 格。

import type { PiVisionImage } from "./pi-model-backend.ts";

/** 6 格彩色格子探测图（100x64 PNG） */
export const VISION_PROBE_IMAGE: PiVisionImage = {
  mediaType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAGAAAABACAYAAADlNHIOAAAAlklEQVR4nO3RwQkAMAgEwSs9nRvSQ+BARty/MplkmuWU674/9QsAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMAOgLfFkm7tAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD7MBUWbzxwABZ5XAAAAAElFTkSuQmCC",
};

/** 6 格的期望颜色，顺序与图上的格子一致 */
export const VISION_PROBE_EXPECTED: readonly string[] = [
  "red",
  "green",
  "blue",
  "yellow",
  "black",
  "white",
];
