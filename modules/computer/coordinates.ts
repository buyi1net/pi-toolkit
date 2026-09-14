// 坐标换算链（工单 17）：截图像素 ↔ 虚拟桌面物理坐标。
//
// 口径定稿 screenshot_pixels：观察带图时，图的像素坐标系由采集记录定义——
//   image.x = (desktop.x − region.x) × (image.width / region.width)
//   image.y = (desktop.y − region.y) × (image.height / region.height)
// 两个方向分别换算：helper 逐边取整（窄边兜到 1 像素），纵向比例因此可能与横向的
// `scale` 相差万分之一；只有一个比例会让图的另一侧整体偏移，所以帧里存两个。
// 采集记录与 stateId 一一绑定（state.ts），旧图与新图不混用；没有图的快照不带 bounds。
//
// 本文件只有纯逻辑：不碰后端、不碰状态层，任何平台可测。
// 规格来源：工单 17、docs/pi-computer/规划书.md 的坐标口径决策、桥协议 v1 的 capture result 约束。

import type { ComputerBounds, ComputerCaptureRecord } from "./contract.ts";

/** 图的像素坐标系：由采集记录里的 region 与图像尺寸定义 */
export interface ComputerImageFrame {
  /** 采集区域左上角在虚拟桌面物理坐标里的位置（可为负） */
  readonly originX: number;
  readonly originY: number;
  /** 采集区域尺寸（物理像素，正数） */
  readonly width: number;
  readonly height: number;
  /** 横向比例：image.width / region.width（与采集记录的 scale 同值） */
  readonly scaleX: number;
  /** 纵向比例：image.height / region.height（逐边取整时与 scaleX 可差万分之一） */
  readonly scaleY: number;
}

export interface ComputerImagePoint {
  readonly x: number;
  readonly y: number;
}

/** scale 与图像宽/区域宽的一致性容差：线上 double 由同一串除法得出，这里只做防呆 */
const FRAME_EPSILON = 1e-9;

/**
 * 采集区域与图像的字段能不能构成一张可换算的图：区域有正面积、图像有正尺寸、
 * 记录的 `scale` 与「图像宽 / 区域宽」一致（协议要求 scale 就是横向比例）。
 * 桥边界与状态层共用这一份判定，避免两处容差各自漂移。
 */
export function isValidImageFrame(
  region: ComputerBounds,
  image: { readonly width: number; readonly height: number; readonly scale: number },
): boolean {
  if (!(region.width > 0) || !(region.height > 0)) return false;
  if (!(image.width > 0) || !(image.height > 0)) return false;
  if (!(image.scale > 0) || !Number.isFinite(image.scale)) return false;
  return Math.abs(image.scale - image.width / region.width) <= FRAME_EPSILON;
}

/**
 * 从采集记录取出图面几何；字段自相矛盾时判不可用。
 * 调用方按「这份记录不能用来换算」处理，不拿它凑合：换算错的坐标比没有坐标危险。
 */
export function imageFrameOf(capture: ComputerCaptureRecord): ComputerImageFrame | undefined {
  const { region, image } = capture;
  if (!isValidImageFrame(region, image)) return undefined;
  return {
    originX: region.x,
    originY: region.y,
    width: region.width,
    height: region.height,
    scaleX: image.width / region.width,
    scaleY: image.height / region.height,
  };
}

/** 虚拟桌面物理坐标 → 图像像素（四舍五入到整像素） */
export function desktopPointToImage(frame: ComputerImageFrame, x: number, y: number): ComputerImagePoint {
  return {
    x: Math.round((x - frame.originX) * frame.scaleX),
    y: Math.round((y - frame.originY) * frame.scaleY),
  };
}

/**
 * 图像像素 → 虚拟桌面物理坐标。
 * 保留小数：图像像素是对物理像素的采样，整数图点反算不一定落在整数物理像素上。
 */
export function imagePointToDesktop(frame: ComputerImageFrame, x: number, y: number): ComputerImagePoint {
  return {
    x: frame.originX + x / frame.scaleX,
    y: frame.originY + y / frame.scaleY,
  };
}

/**
 * 矩形换算：两个角分别换算再取差值，换算后的矩形覆盖原区域。
 * 缩小时出现 0 宽/高属如实结果（元素比一个图点还小），不硬凑成 1 像素。
 */
export function desktopBoundsToImage(frame: ComputerImageFrame, bounds: ComputerBounds): ComputerBounds {
  const left = Math.round((bounds.x - frame.originX) * frame.scaleX);
  const top = Math.round((bounds.y - frame.originY) * frame.scaleY);
  const right = Math.round((bounds.x + bounds.width - frame.originX) * frame.scaleX);
  const bottom = Math.round((bounds.y + bounds.height - frame.originY) * frame.scaleY);
  return { x: left, y: top, width: right - left, height: bottom - top };
}
