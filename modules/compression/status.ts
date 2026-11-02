import type {
  CompressionSettings,
  CompressionStatusService,
  CompressionStatusSnapshot,
  ModelIdentity,
  SessionCompressionOverride,
} from "./api.ts";
import { resolveCompressionStrategy } from "./strategy.ts";

export interface CompressionFallbackRecord {
  readonly from: "codex" | "acp";
  readonly reason: string;
}

export interface CompressionStatusServiceOptions {

  readonly isEnabled: () => boolean;

  readonly readSettings: () => CompressionSettings;

  readonly readModel: () => ModelIdentity | undefined;

  readonly readSessionOverride?: () => SessionCompressionOverride | undefined;

  readonly readFallback?: () => CompressionFallbackRecord | undefined;

  readonly clearFallback?: () => void;
}

export interface CompressionStatusRuntime extends CompressionStatusService {

  noteCompaction(event: { readonly fromExtension: boolean }): void;
}

type CompressionStatusContent = Omit<CompressionStatusSnapshot, "revision">;

export function formatCompressionStatusLabel(
  snapshot: CompressionStatusSnapshot,
  _compact = false,
): string {
  if (snapshot.status === "disabled" || snapshot.status === "unavailable") return "";
  switch (snapshot.effectiveMode) {
    case "native":
      return "Cmp:auto";
    case "acp":
      return "Cmp:ACP";
    case "codex":
      return "Cmp:Codex";
    case "none":

      return "";
  }
}

function deriveContent(options: CompressionStatusServiceOptions): CompressionStatusContent {
  if (!options.isEnabled()) return { status: "disabled", effectiveMode: "none" };
  const model = options.readModel();
  if (model === undefined) return { status: "unavailable", effectiveMode: "none" };
  const settings = options.readSettings();
  const resolution = resolveCompressionStrategy(model, settings, options.readSessionOverride?.());
  const fallback = options.readFallback?.();
  if (fallback !== undefined) {
    return {
      status: "fallback",

      effectiveMode: "native",
      fallbackFrom: fallback.from,
      fallbackReason: fallback.reason,
      triggerPolicy: "auto",
      source: resolution.source,
    };
  }
  return {
    status: "active",
    effectiveMode: resolution.mode,
    triggerPolicy: resolution.triggerPolicy,
    source: resolution.source,
  };
}

export function createCompressionStatusService(
  options: CompressionStatusServiceOptions,
): CompressionStatusRuntime {
  let revision = 0;
  let signature = JSON.stringify(deriveContent(options));

  const snapshot = (): CompressionStatusSnapshot => {
    const content = deriveContent(options);
    const nextSignature = JSON.stringify(content);
    if (nextSignature !== signature) {
      signature = nextSignature;
      revision += 1;
    }
    return { ...content, revision };
  };

  const service: CompressionStatusRuntime = {
    id: "compression",
    snapshot,
    label: (compact = false) => formatCompressionStatusLabel(snapshot(), compact),
    clearFallback: () => {

      if (options.readFallback?.() === undefined) return;
      options.clearFallback?.();
    },
    noteCompaction: (event) => {

      if (event.fromExtension) return;
      service.clearFallback();
    },
  };
  return service;
}
