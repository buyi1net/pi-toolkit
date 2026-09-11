// 图片输入的 base64/MIME/大小预算校验与压缩。
// sharp 只在本文件被真正需要时才动态加载：模块加载、注册与未触发预处理时都不会 require 它。
// 失败不在这里拼用户文案（错误带 code，文案取 i18n 键表，见 describeVisionImageError）。

import { Buffer } from "node:buffer";
import type { MessageKey, Translator } from "../../i18n.ts";
import type { VisionImage } from "./vision-types.ts";

export const VISION_IMAGE_POLICY = Object.freeze({
  maxWidth: 2000,
  maxHeight: 2000,
  maxBase64Bytes: 4.5 * 1024 * 1024,
  totalBase64Bytes: 24 * 1024 * 1024,
  jpegQuality: 80,
});

/** sharp 未安装时给用户的安装命令（写进安装指引文案） */
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

const MESSAGE_KEYS: Record<VisionImageErrorCode, MessageKey> = {
  empty: "module.eyes.imageError.empty",
  unsupportedMime: "module.eyes.imageError.unsupportedMime",
  invalidBase64: "module.eyes.imageError.invalidBase64",
  corruptBase64: "module.eyes.imageError.corruptBase64",
  tooLarge: "module.eyes.imageError.tooLarge",
  decodeFailed: "module.eyes.imageError.decodeFailed",
  totalTooLarge: "module.eyes.imageError.totalTooLarge",
  sharpMissing: "module.eyes.sharpMissing",
};

/** 图片预处理失败：只带错误码与参数，文案交给 i18n 键表 */
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

/** sharp 缺失时供调用方决定是否弹安装指引 */
export function isSharpMissingError(error: unknown): boolean {
  return isVisionImageError(error) && error.code === "sharpMissing";
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 错误 → 当前语言文案；非本模块抛出的错误按“解码/压缩失败”兜底 */
export function describeVisionImageError(error: unknown, t: Translator): string {
  if (isVisionImageError(error)) return t(MESSAGE_KEYS[error.code], { ...error.params });
  return t("module.eyes.imageError.decodeFailed", { reason: describeError(error) });
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

/**
 * 懒加载 sharp：只有真正要压缩图片时才第一次 require。
 * 加载失败抛出 sharpMissing（附安装命令），并且不缓存失败结果，装好以后无需重启即可重试成功。
 */
export function loadSharp(): Promise<SharpFactory> {
  sharpPromise ??= (async (): Promise<SharpFactory> => {
    try {
      // 用变量而不是字面量 'sharp'：sharp 是 optionalDependency，未安装的环境下
      // 字面量 import 会让 tsc 报“找不到模块”，而运行时本来就应该允许它缺席。
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
    // sharp 不可用时，本来就不需要重编码的 JPEG 仍可直接透传；其它格式给安装指引。
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
