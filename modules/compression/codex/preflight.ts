import type { CodexProtocol } from "../api.ts";
import { deriveResponsesProfile, isResponsesCompactionApi, type ResponsesCompactionProfile } from "./profiles.ts";
import type { CodexProtocolAdapterMap, CodexRemoteCompactionAdapter } from "./remote.ts";

export type CodexPreflightReason = "api-not-responses" | "profile-conflict" | "protocol-unavailable";

export type CodexPreflightResult =
  | {
      readonly status: "pass";
      readonly profile: ResponsesCompactionProfile;
      readonly protocol: CodexProtocol;
      readonly adapter: CodexRemoteCompactionAdapter;

      readonly profileSource: "api" | "rule";
    }
  | {
      readonly status: "unsupported";
      readonly reason: CodexPreflightReason;

      readonly api?: string;

      readonly declaredProfile?: ResponsesCompactionProfile;

      readonly protocol?: CodexProtocol;
    };

export function resolveExpectedProfile(
  api: string | undefined,
  ruleProfile: string | undefined,
): ResponsesCompactionProfile | undefined {
  const derived = api === undefined ? undefined : deriveResponsesProfile(api);
  if (derived !== undefined) return derived;
  return ruleProfile === "codex-responses-v1" ? "codex-responses-v1" : undefined;
}

export function preflightCodexCompaction(input: {
  readonly api: string | undefined;
  readonly ruleProfile: string | undefined;
  readonly protocol: CodexProtocol;
  readonly adapters: CodexProtocolAdapterMap;
}): CodexPreflightResult {
  const derived = input.api === undefined ? undefined : deriveResponsesProfile(input.api);
  let profile: ResponsesCompactionProfile | undefined;
  let profileSource: "api" | "rule" | undefined;
  if (derived !== undefined) {
    profile = derived;
    profileSource = "api";
    if (
      input.ruleProfile !== undefined &&
      input.ruleProfile !== "" &&
      input.ruleProfile !== derived &&
      isResponsesCompactionApi(input.api ?? "")
    ) {

      return { status: "unsupported", reason: "profile-conflict", api: input.api, declaredProfile: input.ruleProfile as ResponsesCompactionProfile };
    }
  } else if (input.ruleProfile === "codex-responses-v1") {
    profile = "codex-responses-v1";
    profileSource = "rule";
  }
  if (profile === undefined || profileSource === undefined) {
    return { status: "unsupported", reason: "api-not-responses", api: input.api };
  }
  const adapter = input.adapters[input.protocol];
  if (adapter === undefined) {
    return { status: "unsupported", reason: "protocol-unavailable", protocol: input.protocol, api: input.api };
  }
  return { status: "pass", profile, protocol: input.protocol, adapter, profileSource };
}
