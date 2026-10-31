import { Buffer } from "node:buffer";
import type { Translator } from "../../i18n/index.ts";
import type { VisionMessageKey } from "./messages/index.ts";
import type { VisionImage } from "./vision-types.ts";

export const VISION_IMAGE_POLICY = Object.freeze({
  maxWidth: 2000,
  maxHeight: 2000,
  maxBase64Bytes: 4.5 * 1024 * 1024,
  totalBase64Bytes: 24 * 1024 * 1024,
  jpegQuality: 80,
});

export const SHARP_INSTALL_COMMAND = "npm install sharp";

export type VisionImageErrorCode =
  | "empty"
  | "unsupportedMime"
  | "invalidBase64"
  | "corruptBase64"
  | "tooLarge"
  | "decodeFailed"
  | "totalTooLarge"
  | "sharpMissing";

const MESSAGE_KEYS: Record<VisionImageErrorCode, VisionMessageKey> = {
  empty: "module.vision.imageError.empty",
  unsupportedMime: "module.vision.imageError.unsupportedMime",
  invalidBase64: "module.vision.imageError.invalidBase64",
  corruptBase64: "module.vision.imageError.corruptBase64",
  tooLarge: "module.vision.imageError.tooLarge",
  decodeFailed: "module.vision.imageError.decodeFailed",
  totalTooLarge: "module.vision.imageError.totalTooLarge",
  sharpMissing: "module.vision.sharpMissing",
};

export class VisionImageError extends Error {
  readonly code: VisionImageErrorCode;
  readonly params: Readonly<Record<string, string | number>>;

  constructor(code: VisionImageErrorCode, params: Readonly<Record<string, string | number>> = {}) {
    super(`vision image preprocess failed: ${code}`);
    this.name = "VisionImageError";
    this.code = code;
    this.params = params;
  }
}

export function isVisionImageError(error: unknown): error is VisionImageError {
  return error instanceof VisionImageError;
}

export function isSharpMissingError(error: unknown): boolean {
  return isVisionImageError(error) && error.code === "sharpMissing";
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function describeVisionImageError(error: unknown, t: Translator): string {
  if (isVisionImageError(error)) return t(MESSAGE_KEYS[error.code], { ...error.params });
  return t("module.vision.imageError.decodeFailed", { reason: describeError(error) });
}

interface SharpPipeline {
  rotate(): SharpPipeline;
  resize(options: { width: number; height: number; fit: "inside"; withoutEnlargement: boolean }): SharpPipeline;
  jpeg(options: { quality: number; mozjpeg: boolean }): SharpPipeline;
  toBuffer(): Promise<Buffer>;
}

type SharpFactory = (input: Buffer) => SharpPipeline;

const SHARP_SPECIFIER = "sharp";

let sharpPromise: Promise<SharpFactory> | undefined;

export function loadSharp(): Promise<SharpFactory> {
  sharpPromise ??= (async (): Promise<SharpFactory> => {
    try {

      const imported = (await import(SHARP_SPECIFIER)) as { default?: unknown };
      const factory = imported?.default ?? imported;
      if (typeof factory !== "function") throw new Error("sharp 模块没有可调用的默认导出");
      return factory as unknown as SharpFactory;
    } catch (error) {
      sharpPromise = undefined;
      throw new VisionImageError("sharpMissing", {
        command: SHARP_INSTALL_COMMAND,
        reason: describeError(error),
      });
    }
  })();
  return sharpPromise;
}

function imageError(code: VisionImageErrorCode, params: Record<string, string | number>): VisionImageError {
  return new VisionImageError(code, params);
}

function validateBase64(data: string, index: number): Buffer {
  const compact = data.replace(/\s+/g, "");
  if (!compact || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 === 1) {
    throw imageError("invalidBase64", { index: index + 1 });
  }
  const bytes = Buffer.from(compact, "base64");
  if (!bytes.length || bytes.toString("base64").replace(/=+$/, "") !== compact.replace(/=+$/, "")) {
    throw imageError("corruptBase64", { index: index + 1 });
  }
  return bytes;
}

function passthroughJpeg(bytes: Buffer, mediaType: string): VisionImage | undefined {
  return mediaType === "image/jpeg" && bytes.length <= VISION_IMAGE_POLICY.maxBase64Bytes
    ? { data: bytes.toString("base64"), mediaType }
    : undefined;
}

async function resizeIfNeeded(bytes: Buffer, mediaType: string): Promise<VisionImage> {
  let sharp: SharpFactory;
  try {
    sharp = await loadSharp();
  } catch (error) {

    const fallback = isSharpMissingError(error) ? passthroughJpeg(bytes, mediaType) : undefined;
    if (fallback) return fallback;
    throw error;
  }

  try {
    let quality = VISION_IMAGE_POLICY.jpegQuality;
    const encode = async (): Promise<Buffer> =>
      sharp(bytes)
        .rotate()
        .resize({
          width: VISION_IMAGE_POLICY.maxWidth,
          height: VISION_IMAGE_POLICY.maxHeight,
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer();
    let output = await encode();
    while (output.length > VISION_IMAGE_POLICY.maxBase64Bytes * 0.75 && quality > 45) {
      quality -= 10;
      output = await encode();
    }
    const data = output.toString("base64");
    if (Buffer.byteLength(data, "utf8") > VISION_IMAGE_POLICY.maxBase64Bytes) {
      throw imageError("tooLarge", { bytes: VISION_IMAGE_POLICY.maxBase64Bytes });
    }
    return { data, mediaType: "image/jpeg" };
  } catch (error) {
    if (isVisionImageError(error)) throw error;
    const fallback = passthroughJpeg(bytes, mediaType);
    if (fallback) return fallback;
    throw imageError("decodeFailed", { reason: describeError(error) });
  }
}

export async function prepareVisionImage(image: VisionImage, index: number): Promise<VisionImage> {
  if (!image || typeof image.data !== "string" || !image.data) {
    throw imageError("empty", { index: index + 1 });
  }
  if (!image.mediaType.startsWith("image/")) {
    throw imageError("unsupportedMime", { index: index + 1, mediaType: image.mediaType });
  }
  const bytes = validateBase64(image.data, index);
  return resizeIfNeeded(bytes, image.mediaType);
}

export async function prepareVisionImages(images: VisionImage[]): Promise<VisionImage[]> {
  const prepared = await Promise.all(images.map((image, index) => prepareVisionImage(image, index)));
  const total = prepared.reduce((sum, image) => sum + Buffer.byteLength(image.data, "utf8"), 0);
  if (total > VISION_IMAGE_POLICY.totalBase64Bytes) {
    throw imageError("totalTooLarge", { bytes: VISION_IMAGE_POLICY.totalBase64Bytes });
  }
  return prepared;
}
