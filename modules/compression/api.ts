import type { CompressionSource } from "./strategy.ts";

export const COMPRESSION_MODULE_ID = "compression";

export const COMPRESSION_SCHEMA_VERSION = 1;

export const COMPRESSION_MODES = ["native", "codex", "acp"] as const;
export type CompressionMode = (typeof COMPRESSION_MODES)[number];

export const CODEX_PROTOCOLS = ["remote-v2", "responses-compact", "context-management"] as const;
export type CodexProtocol = (typeof CODEX_PROTOCOLS)[number];

export const DEFAULT_CODEX_PROTOCOL: CodexProtocol = "remote-v2";

export const CODEX_UNSUPPORTED_POLICIES = ["native", "error"] as const;
export type CodexUnsupportedPolicy = (typeof CODEX_UNSUPPORTED_POLICIES)[number];

export const CODEX_RULE_PROFILES = ["codex-responses-v1", "openai-responses-v1"] as const;
export type CodexRuleProfile = (typeof CODEX_RULE_PROFILES)[number];

export const DEFAULT_ACP_AUTO_DETECT_ENABLED = false;
export const DEFAULT_ACP_CONTEXT_WINDOW_THRESHOLD = 200000;

export const ACP_PRESETS = ["recommended", "custom"] as const;
export type AcpPreset = (typeof ACP_PRESETS)[number];

export const DEFAULT_ACP_PRESET: AcpPreset = "recommended";

export const ACP_PRESET_VERSION = 1;

export const ACP_PROMPT_PACKS = ["full", "lean"] as const;
export type AcpPromptPack = (typeof ACP_PROMPT_PACKS)[number];

export const ACP_PROMPT_OVERRIDE_KEYS = [
  "compressPhilosophy",
  "howToCompressRules",
  "tier2DistillRules",
  "tier3CondenseRules",
] as const;
export type AcpPromptOverrideKey = (typeof ACP_PROMPT_OVERRIDE_KEYS)[number];

export const ACP_COMPRESS_FIELDS = [
  "maxContextLimit",
  "emergencyThresholdPercent",
  "nudgeGrowthTokens",
  "preserveRecentMessages",
  "protectedTools",
  "promptPack",
  "prompts",
  "reasoning",
  "stripImages",
  "stripImagesKeepRecent",
] as const;
export type AcpCompressField = (typeof ACP_COMPRESS_FIELDS)[number];

export interface AcpCompressOverrides {

  readonly maxContextLimit?: number;

  readonly emergencyThresholdPercent?: number;

  readonly nudgeGrowthTokens?: number;

  readonly preserveRecentMessages?: number;

  readonly protectedTools?: readonly string[];

  readonly promptPack?: AcpPromptPack;

  readonly prompts?: Readonly<Partial<Record<AcpPromptOverrideKey, string>>>;

  readonly reasoning?: { readonly drop?: boolean; readonly threshold?: number };

  readonly stripImages?: boolean;
  readonly stripImagesKeepRecent?: number;
}

export interface AcpProviderOverrides extends AcpCompressOverrides {
  readonly models?: Readonly<Record<string, AcpCompressOverrides>>;
}

export interface AcpAdvancedSettings {
  readonly global: AcpCompressOverrides;
  readonly providers: Readonly<Record<string, AcpProviderOverrides>>;

  readonly preset?: AcpPreset;
}

export const EMPTY_ACP_ADVANCED_SETTINGS: AcpAdvancedSettings = { global: {}, providers: {} };

export interface CompressionModelRule {

  readonly provider: string;

  readonly model: string;

  readonly api?: string;

  readonly baseUrl?: string;

  readonly mode: CompressionMode;

  readonly protocol?: CodexProtocol;

  readonly profile?: string;

  readonly onUnsupported?: CodexUnsupportedPolicy;
}

export interface ModelIdentity {
  readonly provider: string;
  readonly modelId: string;

  readonly api?: string;

  readonly baseUrl?: string;

  readonly contextWindow?: number;
}

export interface CompressionSettings {

  readonly schemaVersion: number;

  readonly defaultMode: CompressionMode;

  readonly acpAutoDetect: boolean;

  readonly acpAutoDetectThreshold: number;

  readonly modelRules: readonly CompressionModelRule[];

  readonly acpPreset: AcpPreset;

  readonly acpPresetVersion: number;

  readonly acp: AcpAdvancedSettings;
}

export const DEFAULT_COMPRESSION_SETTINGS: CompressionSettings = {
  schemaVersion: COMPRESSION_SCHEMA_VERSION,
  defaultMode: "native",
  acpAutoDetect: DEFAULT_ACP_AUTO_DETECT_ENABLED,
  acpAutoDetectThreshold: DEFAULT_ACP_CONTEXT_WINDOW_THRESHOLD,
  modelRules: [],
  acpPreset: DEFAULT_ACP_PRESET,
  acpPresetVersion: ACP_PRESET_VERSION,
  acp: { ...EMPTY_ACP_ADVANCED_SETTINGS, preset: DEFAULT_ACP_PRESET },
};

export type CompressionConfigProblem =
  | { readonly kind: "schemaVersionInvalid"; readonly field: string; readonly value: string }
  | {
      readonly kind: "schemaVersionTooNew";
      readonly field: string;
      readonly value: string;
      readonly supported: number;
    }
  | {
      readonly kind: "badEnum";
      readonly field: string;
      readonly value: string;
      readonly allowed: readonly string[];
      readonly fallback: string;
    }
  | { readonly kind: "badBoolean"; readonly field: string; readonly value: string; readonly fallback: boolean }
  | { readonly kind: "badNumber"; readonly field: string; readonly value: string; readonly fallback: number }
  | { readonly kind: "badString"; readonly field: string; readonly value: string }
  | { readonly kind: "rulesInvalid"; readonly field: string; readonly value: string }
  | { readonly kind: "ruleInvalid"; readonly field: string; readonly value: string }
  | { readonly kind: "ruleMissingIdentity"; readonly field: string; readonly value: string }

  | { readonly kind: "acpSectionInvalid"; readonly field: string; readonly value: string }
  | { readonly kind: "acpProvidersInvalid"; readonly field: string; readonly value: string }
  | { readonly kind: "acpProviderInvalid"; readonly field: string; readonly value: string }
  | { readonly kind: "acpModelsInvalid"; readonly field: string; readonly value: string }
  | { readonly kind: "acpModelInvalid"; readonly field: string; readonly value: string }
  | { readonly kind: "badPercent"; readonly field: string; readonly value: string }
  | { readonly kind: "badCount"; readonly field: string; readonly value: string }
  | { readonly kind: "badPositiveInt"; readonly field: string; readonly value: string }
  | { readonly kind: "badArray"; readonly field: string; readonly value: string }

  | {
      readonly kind: "legacyCodexDefaultMode";
      readonly field: string;
      readonly value: string;
      readonly fallback: "native";
    };

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value as Readonly<T>;
}

export const ACP_RECOMMENDED_CONFIG = deepFreeze({
  maxContextLimit: 0.75,
  emergencyThresholdPercent: 0.9,
  nudgeGrowthTokens: 2000,
  preserveRecentMessages: 5,
  protectedTools: ["bash", "edit", "write"],
  reasoning: { drop: true, threshold: 3000 },
  stripImages: true,
  stripImagesKeepRecent: 1,
} as const);

export const COMPRESSION_STATUS_SERVICE_NAME = "compression.status";

export type CompressionStatus = "active" | "fallback" | "unavailable" | "disabled";

export interface CompressionStatusSnapshot {
  readonly status: CompressionStatus;
  readonly effectiveMode: "native" | "acp" | "codex" | "none";

  readonly fallbackFrom?: "codex" | "acp";

  readonly fallbackReason?: string;

  readonly triggerPolicy?: "auto";

  readonly source?: CompressionSource;
  readonly revision: number;
}

export interface CompressionStatusService {
  readonly id: "compression";

  snapshot(): CompressionStatusSnapshot;

  label(compact?: boolean): string;

  clearFallback(): void;
}

export const DEFAULT_COMPRESSION_MODES = ["native", "acp"] as const;
export type DefaultCompressionMode = (typeof DEFAULT_COMPRESSION_MODES)[number];

export const SESSION_COMPRESSION_OVERRIDES = ["follow-global", "native", "acp", "codex"] as const;
export type SessionCompressionOverride = (typeof SESSION_COMPRESSION_OVERRIDES)[number];

export const DEFAULT_SESSION_COMPRESSION_OVERRIDE: SessionCompressionOverride = "follow-global";
