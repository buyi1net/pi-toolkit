// 视觉桥：收集消息里的图片、保存最近一张截图、调用辅助视觉模型并把结构化视觉笔记注入上下文。
// 文案（注入告警、询问失败说明）全部走 pi-toolkit 三语键表；纯文本模型才走注入，原生多模态模型旁路。

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Translator } from "../../i18n/index.ts";
import { VisionChain, type VisionAnswer } from "./chain.ts";
import { imageHash, noteKey, VisionNoteCache } from "./vision-cache.ts";
import { contextBlock, formatNote, isStructuredVisionResponse, neutralizeVisionDelimiters, notePrompt } from "./vision-prompt.ts";
import {
  describeVisionImageError,
  isSharpMissingError,
  prepareVisionImages,
} from "./vision-preprocess.ts";
import type { VisionImage, VisionMessages, VisionNote, VisionResource } from "./vision-types.ts";

const CONTEXT_START = "<vision-context>";
const CONTEXT_END = "</vision-context>";
const TASK_DEADLINE_MS = 120_000;
const PER_CALL_MS = 120_000;

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block: any) => block?.type === "text").map((block: any) => block.text || "").join("\n");
}

function isTextOnlyModel(model: any): boolean {
  return Array.isArray(model?.input) && !model.input.includes("image");
}

function modelQuestion(messages: VisionMessages): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if ((messages[index] as any)?.role !== "user") continue;
    const text = contentText((messages[index] as any)?.content)
      .replace(/<vision-context>[\s\S]*?<\/vision-context>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (text) return text.slice(0, 2000);
  }
  return "Describe the image accurately and report only visible evidence.";
}

function collectImages(messages: VisionMessages): VisionResource[] {
  const resources: VisionResource[] = [];
  messages.forEach((message: any, messageIndex) => {
    if (contentText(message?.content).includes(CONTEXT_START)) return;
    if (!Array.isArray(message?.content)) return;
    message.content.forEach((block: any) => {
      if (block?.type !== "image") return;
      const image: VisionImage = {
        data: block.data || block.source?.data,
        mediaType: block.mimeType || block.mediaType || block.source?.mediaType || "image/png",
      };
      if (typeof image.data !== "string" || !image.data) return;
      resources.push({ messageIndex, image, hash: imageHash(image) });
    });
  });
  return resources;
}

function removeImages(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.filter((block: any) => block?.type !== "image");
}

function addText(content: unknown, text: string): unknown {
  if (typeof content === "string") return `${text}${content}`;
  if (Array.isArray(content)) return [{ type: "text", text }, ...content];
  return [{ type: "text", text }];
}

function lastUserMessageIndex(messages: VisionMessages): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if ((messages[index] as any)?.role === "user") return index;
  }
  return -1;
}

function failureMessages(messages: VisionMessages, failure: string): VisionMessages {
  const index = lastUserMessageIndex(messages);
  return messages.map((message: any, messageIndex) => {
    const content = removeImages(message.content);
    return messageIndex === index
      ? { ...message, content: addText(content, `${CONTEXT_START}\n${neutralizeVisionDelimiters(failure)}\n${CONTEXT_END}\n\n`) }
      : Array.isArray(message.content) && content !== message.content
        ? { ...message, content }
        : message;
  });
}

export class VisionBridge {
  private readonly cache = new VisionNoteCache();
  private readonly chain: VisionChain;
  private readonly t: Translator;
  private readonly latestImages = new Map<string, VisionImage>();
  private latestSessionKey?: string;

  constructor(chain: VisionChain, t: Translator) {
    this.chain = chain;
    this.t = t;
  }

  private sessionKey(ctx: ExtensionContext): string {
    return ctx.sessionManager.getSessionFile() || `cwd:${ctx.cwd || "unknown"}`;
  }

  private rememberLatest(ctx: ExtensionContext, image: VisionImage): void {
    const key = this.sessionKey(ctx);
    if (this.latestSessionKey && this.latestSessionKey !== key) this.latestImages.clear();
    this.latestSessionKey = key;
    this.latestImages.set(key, image);
  }

  /** sharp 缺失属于可操作的安装问题，单独给用户弹提示（其余预处理失败只注入上下文） */
  private reportPreprocessFailure(error: unknown, ctx: ExtensionContext): void {
    if (!ctx.hasUI || !isSharpMissingError(error)) return;
    ctx.ui.notify(describeVisionImageError(error, this.t), "error");
  }

  private async analyze(image: VisionImage, question: string, ctx: ExtensionContext, deadlineAt: number): Promise<VisionNote | undefined> {
    const currentModel = ctx.model ? { provider: ctx.model.provider, modelId: ctx.model.id } : undefined;
    const target = this.chain.selectTarget(ctx.modelRegistry, currentModel);
    const cacheModel = target
      ? { provider: target.provider, id: target.modelId }
      : currentModel ? { provider: currentModel.provider, id: currentModel.modelId } : undefined;
    const key = noteKey(imageHash(image), question, cacheModel);
    const cached = this.cache.get(key);
    if (cached) return cached;

    const answer = await this.chain.ask(ctx.modelRegistry, [image], notePrompt(question), {
      signal: ctx.signal,
      deadlineAt,
      currentModel,
      perCallMs: PER_CALL_MS,
    });
    if (!answer.ok) return undefined;

    let responseText = answer.text;
    let correctionBackend = answer.backend;
    if (!isStructuredVisionResponse(responseText)) {
      const correction = await this.chain.ask(
        ctx.modelRegistry,
        [image],
        `${notePrompt(question)}\n上一次输出格式无效。现在只返回完整 JSON，不要添加 Markdown 或解释。`,
        { signal: ctx.signal, deadlineAt, currentModel, perCallMs: PER_CALL_MS },
      );
      if (!correction.ok || !isStructuredVisionResponse(correction.text)) return undefined;
      responseText = correction.text;
      correctionBackend = correction.backend;
    }

    const note: VisionNote = {
      key,
      note: formatNote(responseText, question),
      imageHash: imageHash(image),
      question,
      model: correctionBackend,
      updatedAt: Date.now(),
    };
    await this.cache.set(ctx, note);
    return note;
  }

  /** 让主模型针对最近一张截图自由追问辅助视觉模型。 */
  async queryLatest(question: string, ctx: ExtensionContext): Promise<VisionAnswer> {
    const normalizedQuestion = question.trim();
    if (!normalizedQuestion) return { ok: false, json: this.t("module.vision.queryEmpty") };
    await this.cache.load(ctx);
    const image = this.latestImages.get(this.sessionKey(ctx));
    if (!image) return { ok: false, json: this.t("module.vision.queryNoImage") };
    let preparedImage: VisionImage;
    try {
      [preparedImage] = await prepareVisionImages([image]);
    } catch (error) {
      this.reportPreprocessFailure(error, ctx);
      return {
        ok: false,
        json: this.t("module.vision.injectPreprocessFailed", { reason: describeVisionImageError(error, this.t) }),
      };
    }
    const note = await this.analyze(preparedImage, normalizedQuestion, ctx, Date.now() + TASK_DEADLINE_MS);
    return note
      ? { ok: true, text: note.note, backend: note.model }
      : { ok: false, json: this.t("module.vision.queryFailed") };
  }

  async prepare(messages: VisionMessages, ctx: ExtensionContext): Promise<VisionMessages> {
    const resources = collectImages(messages);
    if (!resources.length) return messages;
    if (!isTextOnlyModel(ctx.model)) {
      this.rememberLatest(ctx, resources[resources.length - 1].image);
      return messages;
    }
    await this.cache.load(ctx);

    const question = modelQuestion(messages);
    let preparedImages: VisionImage[];
    try {
      preparedImages = await prepareVisionImages(resources.map((resource) => resource.image));
    } catch (error) {
      this.reportPreprocessFailure(error, ctx);
      return failureMessages(messages, describeVisionImageError(error, this.t));
    }

    this.rememberLatest(ctx, preparedImages[preparedImages.length - 1]);
    const deadlineAt = Date.now() + TASK_DEADLINE_MS;
    const notes: VisionNote[] = [];
    for (let resourceIndex = 0; resourceIndex < resources.length; resourceIndex += 1) {
      const note = await this.analyze(preparedImages[resourceIndex], question, ctx, deadlineAt);
      if (!note) return failureMessages(messages, this.t("module.vision.injectUnavailable"));
      notes.push(note);
    }

    const byMessage = new Map<number, VisionNote[]>();
    resources.forEach((resource, index) => {
      const list = byMessage.get(resource.messageIndex) || [];
      list.push(notes[index]);
      byMessage.set(resource.messageIndex, list);
    });
    return messages.map((message: any, index) => {
      const localNotes = byMessage.get(index);
      return localNotes?.length
        ? { ...message, content: addText(removeImages(message.content), contextBlock(localNotes)) }
        : message;
    });
  }
}

/** context 注入钩子：只有模块启用时才会被注册（装配器负责按 enabled 跳过） */
export function registerVisionContext(pi: ExtensionAPI, bridge: VisionBridge): void {
  pi.on("context", async (event, ctx) => ({ messages: await bridge.prepare(event.messages, ctx) }));
}
