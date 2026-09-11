// 视觉模块的类型契约：图片、视觉笔记、消息数组。
// 消息类型直接从 pi 的 context 事件推导，避免依赖 pi-ai / pi-agent-core 的内部包名。

import type { ContextEvent } from "@earendil-works/pi-coding-agent";

/** 传给视觉模型的图片片段（base64 数据 + MIME） */
export interface VisionImage {
  data: string;
  mediaType: string;
}

export interface VisionResource {
  messageIndex: number;
  image: VisionImage;
  hash: string;
}

export interface VisionNote {
  key: string;
  note: string;
  imageHash: string;
  question: string;
  model: string;
  updatedAt: number;
}

export interface VisionNotesFile {
  version: 1;
  notes: Record<string, VisionNote>;
}

/** 一次 LLM 调用前的消息数组（pi `context` 事件携带的形状） */
export type VisionMessages = ContextEvent["messages"];
