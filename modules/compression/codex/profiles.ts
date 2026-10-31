export const RESPONSES_COMPACTION_APIS = [
  "openai-codex-responses",
  "openai-responses",
  "azure-openai-responses",
] as const;

export type BuiltInResponsesCompactionApi = (typeof RESPONSES_COMPACTION_APIS)[number];

export type ResponsesCompactionProfile = "codex-responses-v1" | "openai-responses-v1";

export function isResponsesCompactionApi(api: string): api is BuiltInResponsesCompactionApi {
  return (RESPONSES_COMPACTION_APIS as readonly string[]).includes(api);
}

export function deriveResponsesProfile(api: string | undefined): ResponsesCompactionProfile | undefined {
  if (api === "openai-codex-responses") return "codex-responses-v1";
  if (api === "openai-responses" || api === "azure-openai-responses") return "openai-responses-v1";
  return undefined;
}

export function profileMatchesApi(api: string, profile: ResponsesCompactionProfile): boolean {
  const derived = deriveResponsesProfile(api);
  if (derived !== undefined) return derived === profile;
  return profile === "codex-responses-v1";
}
