import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export const OFFICIAL_OPENAI_BASE_URL = "https://api.openai.com/v1";

const OFFICIAL_OPENAI_HOST = "api.openai.com";

const OFFICIAL_CODEX_HOST = "chatgpt.com";

export const OFFICIAL_CODEX_PATH_PREFIX = "/backend-api";

export type CodexCapabilityReason =
  | "official-openai-responses"
  | "official-codex-oauth"
  | "unsupported-api"
  | "missing-base-url"
  | "url-invalid"
  | "non-official-host"
  | "unexpected-path"
  | "auth-unavailable";

export type CodexBaseUrlSource = "auth" | "model" | "provider" | "official-default";

export interface CodexCapabilityInput {
  readonly provider: string;

  readonly api: string | undefined;

  readonly authBaseUrl?: string | undefined;

  readonly modelBaseUrl?: string | undefined;

  readonly providerBaseUrl?: string | undefined;
}

export interface CodexCapability {
  readonly capable: boolean;
  readonly reason: CodexCapabilityReason;

  readonly effectiveBaseUrl?: string;

  readonly baseUrlSource?: CodexBaseUrlSource;

  readonly detail?: string;
}

export interface CodexCapabilityRegistry {

  getProvider(provider: string): { readonly baseUrl?: string } | undefined;

  getApiKeyAndHeaders(model: CodexCapabilityModel): Promise<CodexCapabilityAuth>;
}

export type CodexCapabilityModel = Parameters<ModelRegistry["getApiKeyAndHeaders"]>[0];

export type CodexCapabilityAuth = Awaited<ReturnType<ModelRegistry["getApiKeyAndHeaders"]>>;

const CODEX_CAPABLE_APIS = new Set(["openai-responses", "openai-codex-responses"]);

function trimmedOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? undefined : trimmed;
}

function deny(
  reason: CodexCapabilityReason,
  picked: { readonly url: string; readonly source: CodexBaseUrlSource },
  detail?: string,
): CodexCapability {
  return {
    capable: false,
    reason,
    effectiveBaseUrl: picked.url,
    baseUrlSource: picked.source,
    ...(detail === undefined ? {} : { detail }),
  };
}

function pickEffectiveBaseUrl(
  input: CodexCapabilityInput,
): { readonly url: string; readonly source: CodexBaseUrlSource } | undefined {
  const auth = trimmedOrUndefined(input.authBaseUrl);
  if (auth !== undefined) return { url: auth, source: "auth" };
  const model = trimmedOrUndefined(input.modelBaseUrl);
  if (model !== undefined) return { url: model, source: "model" };
  const provider = trimmedOrUndefined(input.providerBaseUrl);
  if (provider !== undefined) return { url: provider, source: "provider" };
  if (input.provider.trim() !== "openai") return undefined;
  return { url: OFFICIAL_OPENAI_BASE_URL, source: "official-default" };
}

function isOfficialHost(url: URL, host: string): boolean {
  return url.host.toLowerCase() === host;
}

function isOpenAiResponsesBasePath(pathname: string): boolean {
  return pathname === "/" || pathname === "/v1";
}

function isCodexOAuthPath(pathname: string): boolean {
  return pathname === OFFICIAL_CODEX_PATH_PREFIX || pathname.startsWith(`${OFFICIAL_CODEX_PATH_PREFIX}/`);
}

export function detectCodexCapability(input: CodexCapabilityInput): CodexCapability {
  const api = input.api?.trim() ?? "";
  if (!CODEX_CAPABLE_APIS.has(api)) {
    return {
      capable: false,
      reason: "unsupported-api",
      ...(api === "" ? {} : { detail: api }),
    };
  }
  const picked = pickEffectiveBaseUrl(input);
  if (picked === undefined) return { capable: false, reason: "missing-base-url" };
  let url: URL;
  try {
    url = new URL(picked.url);
  } catch {
    return deny("url-invalid", picked, picked.url);
  }
  const host = url.host.toLowerCase();
  const pathname = url.pathname;
  if (api === "openai-responses") {
    if (!isOfficialHost(url, OFFICIAL_OPENAI_HOST)) return deny("non-official-host", picked, host);
    if (!isOpenAiResponsesBasePath(pathname)) return deny("unexpected-path", picked, pathname);
    return {
      capable: true,
      reason: "official-openai-responses",
      effectiveBaseUrl: picked.url,
      baseUrlSource: picked.source,
    };
  }
  if (!isOfficialHost(url, OFFICIAL_CODEX_HOST)) return deny("non-official-host", picked, host);
  if (!isCodexOAuthPath(pathname)) return deny("unexpected-path", picked, pathname);
  return {
    capable: true,
    reason: "official-codex-oauth",
    effectiveBaseUrl: picked.url,
    baseUrlSource: picked.source,
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function readModelCodexCapability(
  registry: CodexCapabilityRegistry,
  model: CodexCapabilityModel & {
    readonly provider: string;
    readonly api: string;
    readonly baseUrl: string;
  },
): Promise<CodexCapability> {
  const providerBaseUrl = registry.getProvider(model.provider)?.baseUrl;
  let authBaseUrl: string | undefined;
  try {
    const auth = await registry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      return { capable: false, reason: "auth-unavailable", detail: auth.error };
    }
    authBaseUrl = auth.baseUrl;
  } catch (error) {
    return { capable: false, reason: "auth-unavailable", detail: describeError(error) };
  }
  return detectCodexCapability({
    provider: model.provider,
    api: model.api,
    authBaseUrl,
    modelBaseUrl: model.baseUrl,
    providerBaseUrl,
  });
}
