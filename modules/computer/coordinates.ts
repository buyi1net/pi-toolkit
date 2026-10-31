import type { ComputerBounds, ComputerCaptureRecord } from "./contract.ts";

export interface ComputerImageFrame {

  readonly originX: number;
  readonly originY: number;

  readonly width: number;
  readonly height: number;

  readonly scaleX: number;

  readonly scaleY: number;

  readonly imageWidth: number;
  readonly imageHeight: number;
}

export interface ComputerImagePoint {
  readonly x: number;
  readonly y: number;
}

const FRAME_EPSILON = 1e-9;

export function isValidImageFrame(
  region: ComputerBounds,
  image: { readonly width: number; readonly height: number; readonly scale: number },
): boolean {
  if (!(region.width > 0) || !(region.height > 0)) return false;
  if (!(image.width > 0) || !(image.height > 0)) return false;
  if (!(image.scale > 0) || !Number.isFinite(image.scale)) return false;
  return Math.abs(image.scale - image.width / region.width) <= FRAME_EPSILON;
}

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
    imageWidth: image.width,
    imageHeight: image.height,
  };
}

export function desktopPointToImage(frame: ComputerImageFrame, x: number, y: number): ComputerImagePoint {
  return {
    x: Math.round((x - frame.originX) * frame.scaleX),
    y: Math.round((y - frame.originY) * frame.scaleY),
  };
}

export function imagePointToDesktop(frame: ComputerImageFrame, x: number, y: number): ComputerImagePoint {
  return {
    x: frame.originX + x / frame.scaleX,
    y: frame.originY + y / frame.scaleY,
  };
}

export const imagePointToScreenPoint = imagePointToDesktop;

export function screenPointToWindowLocal(
  windowFrame: ComputerBounds,
  x: number,
  y: number,
): ComputerImagePoint {
  return { x: x - windowFrame.x, y: y - windowFrame.y };
}

export function isImagePointInFrame(frame: ComputerImageFrame, x: number, y: number): boolean {
  return Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x < frame.imageWidth && y < frame.imageHeight;
}

export function desktopBoundsToImage(frame: ComputerImageFrame, bounds: ComputerBounds): ComputerBounds {
  const left = Math.round((bounds.x - frame.originX) * frame.scaleX);
  const top = Math.round((bounds.y - frame.originY) * frame.scaleY);
  const right = Math.round((bounds.x + bounds.width - frame.originX) * frame.scaleX);
  const bottom = Math.round((bounds.y + bounds.height - frame.originY) * frame.scaleY);
  return { x: left, y: top, width: right - left, height: bottom - top };
}
