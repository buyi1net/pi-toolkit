import type { ContextEvent } from "@earendil-works/pi-coding-agent";

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

export type VisionMessages = ContextEvent["messages"];
