import { defaultConfig, type Config } from "acp-kernel";

export interface AcpProtectionPolicy {

  readonly protectedTools?: readonly string[];

  readonly protectedLatestTools?: readonly string[];

  readonly neverPreserveRecentTools?: readonly string[];

  readonly preserveRecentTools?: readonly string[];

  readonly preserveRecentMessages?: number;

  readonly preserveRecentTokens?: number;
}

export const ACP_DEFAULT_PROTECTION: Readonly<AcpProtectionPolicy> = Object.freeze({
  protectedTools: [],
  protectedLatestTools: [],
  preserveRecentMessages: 5,
  preserveRecentTokens: 5000,
});

export function acpProtectionOverrides(
  policy: AcpProtectionPolicy | undefined,
): Partial<Config> {
  if (!policy) return {};
  const overrides: Partial<Config> = {};
  if (policy.protectedTools !== undefined) overrides.protectedTools = [...policy.protectedTools];
  if (policy.protectedLatestTools !== undefined) {
    overrides.protectedLatestTools = [...policy.protectedLatestTools];
  }
  if (policy.neverPreserveRecentTools !== undefined) {
    overrides.neverPreserveRecentTools = [...policy.neverPreserveRecentTools];
  }
  if (policy.preserveRecentTools !== undefined) {
    overrides.preserveRecentTools = [...policy.preserveRecentTools];
  }
  if (policy.preserveRecentMessages !== undefined) {
    overrides.preserveRecentMessages = policy.preserveRecentMessages;
  }
  if (policy.preserveRecentTokens !== undefined) {
    overrides.preserveRecentTokens = policy.preserveRecentTokens;
  }
  return overrides;
}

export function resolveAcpKernelConfig(
  modelContextLimit: number,
  policy?: AcpProtectionPolicy,
): Config {
  return defaultConfig(modelContextLimit, acpProtectionOverrides(policy ?? ACP_DEFAULT_PROTECTION));
}
