import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { VisionImage, VisionNote, VisionNotesFile } from "./vision-types.ts";

const MAX_CACHE_ENTRIES = 256;
// 会话旁挂缓存文件：随会话文件同目录，名字用 pi-toolkit 前缀（合并后不再沿用旧插件名）
const NOTES_FILE = "pi-toolkit-vision-notes.json";

export function imageHash(image: VisionImage): string {
  return createHash("sha256")
    .update(image.mediaType || "image/png")
    .update("\0")
    .update(image.data)
    .digest("hex");
}

export function noteKey(imageDigest: string, question: string, model: any): string {
  return createHash("sha256")
    .update(imageDigest)
    .update("\0")
    .update(question)
    .update("\0")
    .update(`${model?.provider || ""}/${model?.id || ""}`)
    .digest("hex");
}

export class VisionNoteCache {
  private readonly memory = new Map<string, VisionNote>();
  private loadedSession?: string;
  private writeTail: Promise<void> = Promise.resolve();

  async load(ctx: ExtensionContext): Promise<void> {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile || sessionFile === this.loadedSession) return;
    this.loadedSession = sessionFile;
    this.memory.clear();
    try {
      const parsed = JSON.parse(await readFile(this.filePath(sessionFile), "utf8")) as VisionNotesFile;
      for (const note of Object.values(parsed.notes || {})) this.memory.set(note.key, note);
    } catch (error: any) {
      if (error?.code !== "ENOENT") return;
    }
    this.trim();
  }

  get(key: string): VisionNote | undefined {
    return this.memory.get(key);
  }

  async set(ctx: ExtensionContext, note: VisionNote): Promise<void> {
    this.memory.set(note.key, note);
    this.trim();
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) return;
    const write = async () => {
      const filePath = this.filePath(sessionFile);
      let data: VisionNotesFile = { version: 1, notes: {} };
      try {
        data = JSON.parse(await readFile(filePath, "utf8")) as VisionNotesFile;
      } catch (error: any) {
        if (error?.code !== "ENOENT") return;
      }
      data.notes[note.key] = note;
      await mkdir(dirname(filePath), { recursive: true });
      const temporary = `${filePath}.tmp-${process.pid}`;
      await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      await rename(temporary, filePath);
    };
    const next = this.writeTail.then(write, write);
    this.writeTail = next.catch(() => {});
    await next;
  }

  private filePath(sessionFile: string): string {
    // 同一项目的会话共用目录，加入会话文件名以避免不同会话互相读取视觉笔记。
    return join(dirname(sessionFile), `${basename(sessionFile)}.${NOTES_FILE}`);
  }

  private trim(): void {
    if (this.memory.size <= MAX_CACHE_ENTRIES) return;
    const entries = [...this.memory.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    for (const [key] of entries.slice(0, this.memory.size - MAX_CACHE_ENTRIES)) this.memory.delete(key);
  }
}
