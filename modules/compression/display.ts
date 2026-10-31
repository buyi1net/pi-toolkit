import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import type { Translator } from "../../i18n/index.ts";
import type { CompressionMode } from "./api.ts";
import type { CompressionStrategyResolution } from "./strategy.ts";

export type CompressionDisplayOwner = "native" | "extension";

export type CompressionDisplayState =
  | "in-progress"
  | "succeeded"
  | "failed"
  | "protected"
  | "expired"

  | "concluded"

  | "recovering"

  | "recovery-succeeded"

  | "recovery-failed";

export const COMPRESSION_DISPLAY_ENTRY_TYPE = "pi-toolkit.compression.display";

export interface CompressionDisplayEntryData {
  readonly owner: CompressionDisplayOwner;
  readonly mode: CompressionMode;
  readonly state: CompressionDisplayState;

  readonly reason?: string;

  readonly at: number;
}

export interface DisplaySeamChoice {

  readonly nativeMasking: "available" | "unavailable";

  readonly seam: "extension-custom-entry";
}

export function decideDisplayOwner(
  resolution: CompressionStrategyResolution | undefined,
): CompressionDisplayOwner {
  if (resolution === undefined) return "native";
  return resolution.mode === "native" ? "native" : "extension";
}

export function isDisplayEntry(entry: SessionEntry): entry is SessionEntry & {
  type: "custom";
  customType: string;
  data?: CompressionDisplayEntryData;
} {
  return entry.type === "custom" && entry.customType === COMPRESSION_DISPLAY_ENTRY_TYPE;
}

export function latestDisplayEntry(
  entries: readonly SessionEntry[],
  owner: CompressionDisplayOwner,
): CompressionDisplayEntryData | undefined {
  let latest: CompressionDisplayEntryData | undefined;
  for (const entry of entries) {
    if (!isDisplayEntry(entry)) continue;
    const data = entry.data;
    if (data && data.owner === owner) latest = data;
  }
  return latest;
}

export function resolveDisplaySeam(): DisplaySeamChoice {

  return { nativeMasking: "unavailable", seam: "extension-custom-entry" };
}

export interface DisplayController {

  readonly current: CompressionDisplayEntryData | undefined;

  restore(entries: readonly SessionEntry[]): CompressionDisplayEntryData | undefined;

  start(owner: CompressionDisplayOwner, mode: CompressionMode): CompressionDisplayEntryData | undefined;

  succeed(mode: CompressionMode): CompressionDisplayEntryData | undefined;

  fail(mode: CompressionMode, reason: string): CompressionDisplayEntryData | undefined;

  protect(mode: CompressionMode, reason: string): CompressionDisplayEntryData | undefined;

  conclude(mode: CompressionMode): CompressionDisplayEntryData | undefined;

  beginRecovery(mode: CompressionMode): CompressionDisplayEntryData | undefined;

  recoverSucceed(mode: CompressionMode): CompressionDisplayEntryData | undefined;

  recoverFail(mode: CompressionMode, reason: string): CompressionDisplayEntryData | undefined;
}

export function createDisplayController(): DisplayController {
  let current: CompressionDisplayEntryData | undefined;

  function commit(entry: CompressionDisplayEntryData): CompressionDisplayEntryData {
    current = entry;
    return entry;
  }

  function fromCurrentMode(mode: CompressionMode): boolean {
    return current !== undefined && current.mode === mode;
  }

  function terminalEntry(
    mode: CompressionMode,
    state: "failed" | "protected",
    reason: string,
  ): CompressionDisplayEntryData | undefined {
    if (current?.state === "in-progress" && current.mode === mode) {
      return commit({ ...current, state, reason, at: Date.now() });
    }
    if (current?.state === "in-progress" || current?.state === "recovering") return undefined;
    if (current?.mode === mode) return undefined;
    return commit({ owner: "extension", mode, state, reason, at: Date.now() });
  }

  const controller: DisplayController = {
    get current(): CompressionDisplayEntryData | undefined {
      return current;
    },
    restore(entries): CompressionDisplayEntryData | undefined {

      let latest: CompressionDisplayEntryData | undefined;
      for (const entry of entries) {
        if (isDisplayEntry(entry) && entry.data) latest = entry.data;
      }
      current = latest;
      if (latest && (latest.state === "in-progress" || latest.state === "recovering")) {

        return commit({
          owner: latest.owner,
          mode: latest.mode,
          state: "expired",
          at: Date.now(),
        });
      }
      return undefined;
    },
    start(owner, mode): CompressionDisplayEntryData | undefined {

      if (owner === "native") return undefined;
      return commit({ owner, mode, state: "in-progress", at: Date.now() });
    },
    succeed(mode): CompressionDisplayEntryData | undefined {
      if (!fromCurrentMode(mode) || current?.state !== "in-progress") return undefined;
      return commit({ ...current, state: "succeeded", at: Date.now() });
    },
    fail(mode, reason): CompressionDisplayEntryData | undefined {
      return terminalEntry(mode, "failed", reason);
    },
    protect(mode, reason): CompressionDisplayEntryData | undefined {
      return terminalEntry(mode, "protected", reason);
    },
    conclude(mode): CompressionDisplayEntryData | undefined {
      if (!fromCurrentMode(mode) || current?.state !== "in-progress") return undefined;
      return commit({ ...current, state: "concluded", at: Date.now() });
    },
    beginRecovery(mode): CompressionDisplayEntryData | undefined {

      return commit({ owner: "extension", mode, state: "recovering", at: Date.now() });
    },
    recoverSucceed(mode): CompressionDisplayEntryData | undefined {
      if (!fromCurrentMode(mode) || current?.state !== "recovering") return undefined;
      return commit({ ...current, state: "recovery-succeeded", at: Date.now() });
    },
    recoverFail(mode, reason): CompressionDisplayEntryData | undefined {
      if (!fromCurrentMode(mode) || current?.state !== "recovering") return undefined;
      return commit({ ...current, state: "recovery-failed", reason, at: Date.now() });
    },
  };
  return controller;
}

export function displayEntryLabel(
  data: CompressionDisplayEntryData,
  t: Translator,
): string {
  const modeLabel = t(`module.compression.mode.${data.mode}`);
  switch (data.state) {
    case "in-progress":
      return t("module.compression.display.inProgress", { mode: modeLabel });
    case "succeeded":
      return t("module.compression.display.succeeded", { mode: modeLabel });
    case "failed":
      return t("module.compression.display.failed", { mode: modeLabel, reason: data.reason ?? "" });
    case "protected":
      return t("module.compression.display.protected", { mode: modeLabel, reason: data.reason ?? "" });
    case "expired":
      return t("module.compression.display.expired", { mode: modeLabel });
    case "concluded":
      return t("module.compression.display.concluded", { mode: modeLabel });
    case "recovering":
      return t("module.compression.display.recovering", { mode: modeLabel });
    case "recovery-succeeded":
      return t("module.compression.display.recoverySucceeded", { mode: modeLabel });
    case "recovery-failed":
      return t("module.compression.display.recoveryFailed", { mode: modeLabel, reason: data.reason ?? "" });
  }
}

export interface CompressionDisplayReporter {

  begin(mode: CompressionMode): void;

  succeed(mode: CompressionMode): void;

  fail(mode: CompressionMode, reason: string): void;

  protect(mode: CompressionMode, reason: string): void;

  conclude(mode: CompressionMode): void;

  recovering(mode: CompressionMode): void;

  recoverSucceed(mode: CompressionMode): void;

  recoverFail(mode: CompressionMode, reason: string): void;
}

export interface DisplayPresentation {
  readonly controller: DisplayController;

  markVisibleEntry(entryId: string): void;

  registerRenderer(
    pi: {
      registerEntryRenderer?: <T>(
        customType: string,
        renderer: (entry: { type: string; customType: string; data?: T; id?: string }, options: { expanded: boolean }, theme: unknown) => Component | undefined,
      ) => void;
    },
    t: Translator,
  ): void;
}

export function createDisplayPresentation(): DisplayPresentation {
  let visibleEntryId: string | undefined;
  const controller = createDisplayController();

  return {
    controller,
    markVisibleEntry(entryId): void {
      visibleEntryId = entryId;
    },
    registerRenderer(pi, t): void {
      pi.registerEntryRenderer?.<CompressionDisplayEntryData>(
        COMPRESSION_DISPLAY_ENTRY_TYPE,
        (entry) => {

          if (entry.id !== undefined && entry.id !== visibleEntryId) return undefined;
          const data = entry.data;
          if (!data || !data.owner || !data.mode || !data.state) return undefined;

          if (
            data.state === "in-progress" ||
            data.state === "succeeded" ||
            data.state === "expired" ||
            data.state === "concluded" ||
            data.state === "recovering" ||
            data.state === "recovery-succeeded"
          ) {
            return undefined;
          }
          const label = displayEntryLabel(data, t);
          if (!label) return undefined;
          return new Text(label, 1, 0);
        },
      );
    },
  };
}

export function createDisplayReporter(
  presentation: DisplayPresentation,
  appendEntry: (data: CompressionDisplayEntryData) => string | undefined,
): CompressionDisplayReporter {
  const controller = presentation.controller;
  function apply(data: CompressionDisplayEntryData | undefined): void {
    if (data === undefined) return;
    const id = appendEntry(data);
    if (id !== undefined) presentation.markVisibleEntry(id);
  }
  return {
    begin(mode): void {
      apply(controller.start("extension", mode));
    },
    succeed(mode): void {
      apply(controller.succeed(mode));
    },
    fail(mode, reason): void {
      apply(controller.fail(mode, reason));
    },
    protect(mode, reason): void {
      apply(controller.protect(mode, reason));
    },
    conclude(mode): void {
      apply(controller.conclude(mode));
    },
    recovering(mode): void {
      apply(controller.beginRecovery(mode));
    },
    recoverSucceed(mode): void {
      apply(controller.recoverSucceed(mode));
    },
    recoverFail(mode, reason): void {
      apply(controller.recoverFail(mode, reason));
    },
  };
}
