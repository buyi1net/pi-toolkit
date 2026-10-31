import {
  DEFAULT_CODEX_PROTOCOL,
  DEFAULT_SESSION_COMPRESSION_OVERRIDE,
  type CodexProtocol,
  type CodexUnsupportedPolicy,
  type CompressionMode,
  type CompressionModelRule,
  type CompressionSettings,
  type ModelIdentity,
  type SessionCompressionOverride,
} from "./api.ts";
import { detectCodexCapability } from "./codex/capability.ts";
import { deriveResponsesProfile } from "./codex/profiles.ts";

export type CompressionSource = "explicit" | "acp-auto" | "default" | "codex-auto" | "session-override";

export type CompressionMatchPrecision =
  | "provider-model"
  | "provider-model-api"
  | "provider-model-baseUrl"
  | "provider-model-api-baseUrl";

export const PRECISION_RANK: Readonly<Record<CompressionMatchPrecision, number>> = {
  "provider-model": 1,
  "provider-model-api": 2,
  "provider-model-baseUrl": 2,
  "provider-model-api-baseUrl": 3,
};

export type CompressionFallbackReason =
  | "conflict"
  | "context-window-missing"
  | "invalid-identity";

export type CompressionConflictField = "mode" | "protocol" | "profile" | "onUnsupported";

export interface CompressionRuleConflict {
  readonly indices: readonly number[];
  readonly field: CompressionConflictField;
}

export interface NormalizedModelIdentity {
  readonly provider: string;
  readonly modelId: string;
  readonly api: string | undefined;
  readonly baseUrl: string | undefined;
  readonly contextWindow: number | undefined;
}

export interface MatchedRuleView {
  readonly index: number;
  readonly rule: CompressionModelRule;
  readonly identity: {
    readonly provider: string;
    readonly model: string;
    readonly api?: string;
    readonly baseUrl?: string;
  };
  readonly precision: CompressionMatchPrecision;
}

export interface CompressionStrategyResolution {

  readonly mode: CompressionMode;

  readonly source: CompressionSource;

  readonly matchedRule?: MatchedRuleView;

  readonly protocol?: CodexProtocol;

  readonly profile?: string;

  readonly onUnsupported?: CodexUnsupportedPolicy;

  readonly triggerPolicy: "auto";

  readonly contextWindow?: number;

  readonly fallbackReason?: CompressionFallbackReason;

  readonly conflicts: readonly CompressionRuleConflict[];
}

export function normalizeCompressionToken(value: string): string {
  return value.trim();
}

export function normalizeBaseUrlForCompare(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  try {
    const url = new URL(trimmed);

    const path = url.pathname.replace(/\/+$/, "");
    return `${url.protocol}//${url.host.toLowerCase()}${path}${url.search}`;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

export function readValidContextWindow(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function normalizeModelIdentity(identity: ModelIdentity): NormalizedModelIdentity {
  return {
    provider: normalizeCompressionToken(identity.provider ?? ""),
    modelId: normalizeCompressionToken(identity.modelId ?? ""),
    api: identity.api === undefined ? undefined : normalizeCompressionToken(identity.api),
    baseUrl:
      identity.baseUrl === undefined || identity.baseUrl.trim() === ""
        ? undefined
        : identity.baseUrl.trim(),
    contextWindow: readValidContextWindow(identity.contextWindow),
  };
}

function rulePrecision(rule: CompressionModelRule): CompressionMatchPrecision {
  if (rule.api !== undefined && rule.baseUrl !== undefined) return "provider-model-api-baseUrl";
  if (rule.api !== undefined) return "provider-model-api";
  if (rule.baseUrl !== undefined) return "provider-model-baseUrl";
  return "provider-model";
}

function matchedRuleView(index: number, rule: CompressionModelRule): MatchedRuleView {
  const identity = {
    provider: normalizeCompressionToken(rule.provider),
    model: normalizeCompressionToken(rule.model),
  };
  return {
    index,
    rule,
    identity: {
      ...identity,
      ...(rule.api === undefined ? {} : { api: normalizeCompressionToken(rule.api) }),
      ...(rule.baseUrl === undefined ? {} : { baseUrl: rule.baseUrl.trim() }),
    },
    precision: rulePrecision(rule),
  };
}

function ruleMatches(rule: CompressionModelRule, identity: NormalizedModelIdentity): boolean {
  if (normalizeCompressionToken(rule.provider) !== identity.provider) return false;
  if (normalizeCompressionToken(rule.model) !== identity.modelId) return false;
  if (rule.api !== undefined) {
    if (identity.api === undefined) return false;
    if (normalizeCompressionToken(rule.api) !== identity.api) return false;
  }
  if (rule.baseUrl !== undefined) {
    if (identity.baseUrl === undefined) return false;
    if (normalizeBaseUrlForCompare(rule.baseUrl) !== normalizeBaseUrlForCompare(identity.baseUrl)) {
      return false;
    }
  }
  return true;
}

function effectiveCodexParams(rule: CompressionModelRule): {
  readonly protocol: CodexProtocol | undefined;
  readonly profile: string | undefined;
  readonly onUnsupported: CodexUnsupportedPolicy | undefined;
} {
  if (rule.mode !== "codex") {
    return { protocol: undefined, profile: undefined, onUnsupported: undefined };
  }
  return {
    protocol: rule.protocol ?? DEFAULT_CODEX_PROTOCOL,
    profile: rule.profile,
    onUnsupported: rule.onUnsupported ?? "native",
  };
}

function sameOutcome(left: CompressionModelRule, right: CompressionModelRule): boolean {
  if (left.mode !== right.mode) return false;
  const a = effectiveCodexParams(left);
  const b = effectiveCodexParams(right);
  return (
    a.protocol === b.protocol && a.profile === b.profile && a.onUnsupported === b.onUnsupported
  );
}

function firstConflictField(rules: readonly CompressionModelRule[]): CompressionConflictField | undefined {
  const [first] = rules;
  if (!first) return undefined;
  const firstParams = effectiveCodexParams(first);
  for (const rule of rules) {
    if (rule.mode !== first.mode) return "mode";
  }
  for (const rule of rules) {
    const params = effectiveCodexParams(rule);
    if (params.protocol !== firstParams.protocol) return "protocol";
  }
  for (const rule of rules) {
    const params = effectiveCodexParams(rule);
    if (params.profile !== firstParams.profile) return "profile";
  }
  for (const rule of rules) {
    const params = effectiveCodexParams(rule);
    if (params.onUnsupported !== firstParams.onUnsupported) return "onUnsupported";
  }
  return undefined;
}

function defaultResolution(
  settings: CompressionSettings,
  contextWindow: number | undefined,
  fallbackReason: CompressionFallbackReason | undefined,
  conflicts: readonly CompressionRuleConflict[] = [],
): CompressionStrategyResolution {
  const mode = settings.defaultMode;

  const codex = mode === "codex";
  return {
    mode,
    source: "default",
    ...(codex ? { protocol: DEFAULT_CODEX_PROTOCOL, onUnsupported: "native" as const } : {}),
    triggerPolicy: "auto",
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(fallbackReason === undefined ? {} : { fallbackReason }),
    conflicts: [...conflicts],
  };
}

function sessionOverrideResolution(
  identity: NormalizedModelIdentity,
  settings: CompressionSettings,
  sessionOverride: SessionCompressionOverride,
): CompressionStrategyResolution | undefined {
  if (sessionOverride === "follow-global") return undefined;
  const contextWindow =
    identity.contextWindow === undefined ? {} : { contextWindow: identity.contextWindow };
  if (sessionOverride === "codex") {
    const profile = deriveResponsesProfile(identity.api);
    return {
      mode: "codex",
      source: "session-override",
      protocol: DEFAULT_CODEX_PROTOCOL,
      ...(profile === undefined ? {} : { profile }),
      onUnsupported: "native",
      triggerPolicy: "auto",
      ...contextWindow,
      conflicts: [],
    };
  }
  return {
    mode: sessionOverride,
    source: "session-override",
    triggerPolicy: "auto",
    ...contextWindow,
    conflicts: [],
  };
}

export function resolveCompressionStrategy(
  identity: ModelIdentity,
  settings: CompressionSettings,
  sessionOverride: SessionCompressionOverride = DEFAULT_SESSION_COMPRESSION_OVERRIDE,
): CompressionStrategyResolution {
  const normalized = normalizeModelIdentity(identity);

  const overridden = sessionOverrideResolution(normalized, settings, sessionOverride);
  if (overridden !== undefined) return overridden;

  if (normalized.provider === "" || normalized.modelId === "") {
    return defaultResolution(settings, normalized.contextWindow, "invalid-identity");
  }

  const matched = settings.modelRules
    .map((rule, index) => ({ view: matchedRuleView(index, rule), rule }))
    .filter(({ rule }) => ruleMatches(rule, normalized));
  if (matched.length > 0) {
    const topRank = Math.max(
      ...matched.map(({ view }) => PRECISION_RANK[view.precision]),
    );
    const top = matched.filter(({ view }) => PRECISION_RANK[view.precision] === topRank);
    if (top.length > 1) {
      const field = firstConflictField(top.map((entry) => entry.rule));
      if (field !== undefined) {

        return defaultResolution(settings, normalized.contextWindow, "conflict", [
          { indices: top.map((entry) => entry.view.index), field },
        ]);
      }

    }
    const winner = top[0];
    const codex = winner.rule.mode === "codex";
    const params = effectiveCodexParams(winner.rule);
    return {
      mode: winner.rule.mode,
      source: "explicit",
      matchedRule: winner.view,
      ...(codex
        ? {
            protocol: params.protocol,
            profile: params.profile,
            onUnsupported: params.onUnsupported,
          }
        : {}),
      triggerPolicy: "auto",
      ...(normalized.contextWindow === undefined ? {} : { contextWindow: normalized.contextWindow }),
      conflicts: [],
    };
  }

  {
    const capability = detectCodexCapability({
      provider: normalized.provider,
      api: normalized.api,
      modelBaseUrl: normalized.baseUrl,
    });
    if (capability.capable) {
      return {
        mode: "codex",
        source: "codex-auto",
        protocol: DEFAULT_CODEX_PROTOCOL,
        onUnsupported: "native",
        triggerPolicy: "auto",
        ...(normalized.contextWindow === undefined ? {} : { contextWindow: normalized.contextWindow }),
        conflicts: [],
      };
    }
  }

  if (settings.acpAutoDetect) {
    if (normalized.contextWindow === undefined) {

      return defaultResolution(settings, undefined, "context-window-missing");
    }
    if (normalized.contextWindow <= settings.acpAutoDetectThreshold) {
      return {
        mode: "acp",
        source: "acp-auto",
        triggerPolicy: "auto",
        ...(normalized.contextWindow === undefined ? {} : { contextWindow: normalized.contextWindow }),
        conflicts: [],
      };
    }

  }

  return defaultResolution(settings, normalized.contextWindow, undefined);
}
