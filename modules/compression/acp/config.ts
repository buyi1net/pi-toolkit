import { createHash } from "node:crypto";
import {
  defaultConfig,
  resolvePrompts,
  type Config,
  type Prompts,
} from "acp-kernel";
import {
  ACP_RECOMMENDED_CONFIG,
  EMPTY_ACP_ADVANCED_SETTINGS,
  type AcpAdvancedSettings,
  type AcpCompressOverrides,
  type AcpPromptPack,
} from "../api.ts";
import {
  acpEscalationIssue,
  mergeAcpCompressOverrides,
  type AcpEscalationIssue,
} from "../config.ts";
import { ACP_DEFAULT_PROTECTION, resolveAcpKernelConfig, type AcpProtectionPolicy } from "./protection.ts";

export const ACP_FALLBACK_CONTEXT_LIMIT = 150000;

export interface AcpRuntimeIdentity {
  readonly provider?: string;
  readonly modelId?: string;
  readonly contextWindow?: number;
}

export interface AcpResolvedRuntime {

  readonly kernel: Config;

  readonly prompts: Prompts;

  readonly promptPack: AcpPromptPack;

  readonly merged: AcpCompressOverrides;

  readonly escalation: AcpEscalationIssue | undefined;
}

function limitOf(identity: AcpRuntimeIdentity): number {
  const window = identity.contextWindow;
  return typeof window === "number" && Number.isFinite(window) && window > 0
    ? window
    : ACP_FALLBACK_CONTEXT_LIMIT;
}

export function acpKernelConfigFor(
  identity: AcpRuntimeIdentity,
  effective: AcpCompressOverrides,
  protection?: AcpProtectionPolicy,
): Config {

  const config = resolveAcpKernelConfig(limitOf(identity), protection ?? ACP_DEFAULT_PROTECTION);
  if (effective.preserveRecentMessages !== undefined) {
    config.preserveRecentMessages = effective.preserveRecentMessages;
  }
  if (effective.protectedTools !== undefined) {
    config.protectedTools = [...effective.protectedTools];
  }
  if (effective.maxContextLimit !== undefined) config.nudge.maxContextLimitPct = effective.maxContextLimit;
  if (effective.emergencyThresholdPercent !== undefined) {
    config.nudge.emergencyThresholdPct = effective.emergencyThresholdPercent;
    config.truncate.threshold = effective.emergencyThresholdPercent;
  }
  if (effective.nudgeGrowthTokens !== undefined) {
    config.nudge.growthFloor = effective.nudgeGrowthTokens;
    config.nudge.growthCap = effective.nudgeGrowthTokens;
  }
  return config;
}

function dropThresholds(merged: AcpCompressOverrides): AcpCompressOverrides {
  const { maxContextLimit: _max, emergencyThresholdPercent: _emergency, ...rest } = merged;
  void _max;
  void _emergency;
  return rest;
}

function presetGlobalLayer(acp: AcpAdvancedSettings): AcpCompressOverrides {
  const global = acp.global ?? {};
  if (acp.preset !== "recommended") return global;
  return { ...global, ...ACP_RECOMMENDED_CONFIG };
}

export function resolveAcpRuntimeConfig(
  identity: AcpRuntimeIdentity,
  acp: AcpAdvancedSettings,
  protection?: AcpProtectionPolicy,
): AcpResolvedRuntime {
  const settings = acp ?? EMPTY_ACP_ADVANCED_SETTINGS;
  const merged = mergeAcpCompressOverrides(
    { ...settings, global: presetGlobalLayer(settings) },
    identity.provider,
    identity.modelId,
  );
  const escalation = acpEscalationIssue(merged);
  const effective = escalation === undefined ? merged : dropThresholds(merged);
  return {
    kernel: acpKernelConfigFor(identity, effective, protection),
    prompts: resolvePrompts(effective.prompts, { acknowledgeRisk: true }),
    promptPack: effective.promptPack ?? "full",
    merged: effective,
    escalation,
  };
}

export function acpConfigFingerprint(resolved: AcpResolvedRuntime): string {
  const stable = JSON.stringify({
    kernel: resolved.kernel,
    prompts: resolved.prompts,
    promptPack: resolved.promptPack,
  });
  return createHash("sha256").update(stable).digest("hex").slice(0, 16);
}

export interface AcpConfigGenerationVerdict {
  readonly compatible: boolean;
  readonly reason?: "legacy-sidecar" | "config-changed" | "incompatible";
}

export function judgeAcpConfigGeneration(
  storedFingerprint: string | undefined,
  currentFingerprint: string,
): AcpConfigGenerationVerdict {
  if (storedFingerprint === undefined) return { compatible: true, reason: "legacy-sidecar" };
  if (storedFingerprint === currentFingerprint) return { compatible: true };
  return { compatible: true, reason: "config-changed" };
}
