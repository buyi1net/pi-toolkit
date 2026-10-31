import * as piHost from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { CodexAgentMessage } from "./checkpoint.ts";

export interface HostProjectionEntry {
  readonly sourceEntry: SessionEntry;
  readonly messages: readonly CodexAgentMessage[];
}

export interface HostSessionProjection {
  readonly entries: readonly HostProjectionEntry[];
  readonly messages: readonly CodexAgentMessage[];
}

export type SessionProjectionFn = (entries: readonly SessionEntry[], leafId: string | null) => HostSessionProjection;

export class CodexHostProjectionUnsupportedError extends Error {
  constructor() {
    super("Host pi-coding-agent does not provide buildSessionProjection (Pi 1.3.0+ required)");
    this.name = "CodexHostProjectionUnsupportedError";
  }
}

export function hostSessionProjection(entries: readonly SessionEntry[], leafId: string | null): HostSessionProjection {
  const build = piHost.buildSessionProjection;
  if (typeof build !== "function") throw new CodexHostProjectionUnsupportedError();
  const projection = build([...entries], leafId);
  return {
    entries: projection.entries.map((slot) => ({ sourceEntry: slot.sourceEntry, messages: [...slot.messages] })),
    messages: [...projection.messages],
  };
}
