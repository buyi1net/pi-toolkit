// Codex 官方能力探测器（工单 02）：判断模型身份是否走官方 OpenAI / Codex OAuth 链路。
//
// 口径（规格「Codex 资格探测器与 URL 精确口径」）：
// - 有效地址优先级：auth.baseUrl（getApiKeyAndHeaders 返回值）> model.baseUrl >
//   对应 provider 配置里的 baseUrl；三者皆空时，只有 provider === "openai" 才按
//   规格的官方默认 https://api.openai.com/v1 规范化后再判定，其它 provider 直接
//   判无资格（不猜官方地址）；
// - openai-responses：host 严格等于 api.openai.com，pathname 为 /v1 或空根路径
//   （adapter 拼上 /responses 后形成官方链路）；
// - openai-codex-responses：host 严格等于 chatgpt.com，pathname 匹配官方
//   /backend-api OAuth 前缀；
// - 第三方中转域名、非官方 host、路径不匹配（含 /v1/、/v1beta、带额外前缀）一律
//   无资格，绝不自动接管；
// - 判定不抛异常：URL 解析失败、地址缺失、取 auth 抛错都折成机读原因返回，供菜单
//   提示原因与下一步（调用方不做异常兜底）。
//
// 判定是纯的（不发请求、不读凭据内容）：auth 只以解析好的 baseUrl 传入。带 auth 的
// 完整探测走 readModelCodexCapability，纯判定走 detectCodexCapability。
//
// 优先级链的消费面（改动前先看这里）：
// - 策略解析（strategy.ts 的 codex-auto 判定）是纯函数，只能拿到模型目录地址，
//   所以那条路径实际只用 model.baseUrl（生产环境里 provider 级 baseUrl 已被 pi
//   写进每个 model.baseUrl）；
// - 菜单侧（管理页的候选文案与添加前校验）补上 provider 配置地址与 auth 返回的
//   baseUrl，是完整的三级口径。
// 两条路径共用同一个判定函数，官方 / 非官方的口径不会分叉。

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

/** 官方 OpenAI Responses 基准地址（三者皆空且 provider=openai 时的规范化回退） */
export const OFFICIAL_OPENAI_BASE_URL = "https://api.openai.com/v1";
/** 官方 OpenAI host（openai-responses 的唯一合法 host） */
const OFFICIAL_OPENAI_HOST = "api.openai.com";
/** 官方 Codex OAuth host（openai-codex-responses 的唯一合法 host） */
const OFFICIAL_CODEX_HOST = "chatgpt.com";
/** 官方 Codex OAuth 路径前缀（请求在它之后拼 /codex/responses 等） */
export const OFFICIAL_CODEX_PATH_PREFIX = "/backend-api";

/**
 * 判定结果原因（机读值，菜单按 `module.compression.codex.capability.<reason>` 取文案）：
 * 前两条是「有资格」的具体链路，其余是「无资格」的具体原因。
 */
export type CodexCapabilityReason =
  | "official-openai-responses"
  | "official-codex-oauth"
  | "unsupported-api"
  | "missing-base-url"
  | "url-invalid"
  | "non-official-host"
  | "unexpected-path"
  | "auth-unavailable";

/** 有效地址取自哪一级（诊断与菜单提示：用户据此判断该改 auth / 模型 / provider 配置） */
export type CodexBaseUrlSource = "auth" | "model" | "provider" | "official-default";

/** 纯判定的输入：三个候选地址与模型声明的 API */
export interface CodexCapabilityInput {
  readonly provider: string;
  /** 模型声明的 API（openai-responses / openai-codex-responses 之外一律无资格） */
  readonly api: string | undefined;
  /** 第一优先级：鉴权解析返回的 baseUrl */
  readonly authBaseUrl?: string | undefined;
  /** 第二优先级：模型目录里的 baseUrl */
  readonly modelBaseUrl?: string | undefined;
  /** 第三优先级：provider 配置里的 baseUrl */
  readonly providerBaseUrl?: string | undefined;
}

/** 判定结果：capable 为结论，其余字段只用于说明结论 */
export interface CodexCapability {
  readonly capable: boolean;
  readonly reason: CodexCapabilityReason;
  /** 参与判定的有效地址（原始写法，未规范化）；地址缺失时缺省 */
  readonly effectiveBaseUrl?: string;
  /** 有效地址的来源层级；地址缺失时缺省 */
  readonly baseUrlSource?: CodexBaseUrlSource;
  /** 判定细节（实际 host / path，或不可用原因原文），填进菜单文案的 {detail} */
  readonly detail?: string;
}

/** 探测器需要的注册表能力（取子集：provider 配置地址 + 鉴权解析） */
export interface CodexCapabilityRegistry {
  /** provider 配置里的 baseUrl（第三优先级）；未知 provider 返回 undefined */
  getProvider(provider: string): { readonly baseUrl?: string } | undefined;
  /** 鉴权解析：返回值的 baseUrl 覆盖模型地址；!ok 视为认证不可用 */
  getApiKeyAndHeaders(model: CodexCapabilityModel): Promise<CodexCapabilityAuth>;
}

/** getApiKeyAndHeaders 的入参形状（不从 pi-ai 直接导入类型） */
export type CodexCapabilityModel = Parameters<ModelRegistry["getApiKeyAndHeaders"]>[0];
/** getApiKeyAndHeaders 的返回形状 */
export type CodexCapabilityAuth = Awaited<ReturnType<ModelRegistry["getApiKeyAndHeaders"]>>;

/** 有资格的两个 API 分支（其余 API 声明的模型不参与 Codex）。
 * 比 codex/profiles.ts 的 RESPONSES_COMPACTION_APIS 少 azure-openai-responses：
 * azure 的地址永远落在 azure host 上，不是官方 OpenAI / Codex 链路。 */
const CODEX_CAPABLE_APIS = new Set(["openai-responses", "openai-codex-responses"]);

function trimmedOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? undefined : trimmed;
}

/** 无资格结果：判定链路里所有拒绝分支共用一份形状 */
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

/**
 * 有效地址选取（规格的三级优先级 + openai 官方默认）：
 * 只认非空字符串；全空时 openai 回退官方默认地址，其它 provider 返回 undefined。
 */
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

/** host 是否严格等于官方 host（url.host 含端口：非缺省端口的官方域名同样不算官方） */
function isOfficialHost(url: URL, host: string): boolean {
  return url.host.toLowerCase() === host;
}

/** openai-responses 的基准路径：/v1 或空根路径（/v1/ 等尾斜杠变体不算） */
function isOpenAiResponsesBasePath(pathname: string): boolean {
  return pathname === "/" || pathname === "/v1";
}

/** openai-codex-responses 的 OAuth 前缀：/backend-api 本身或其下的子路径 */
function isCodexOAuthPath(pathname: string): boolean {
  return pathname === OFFICIAL_CODEX_PATH_PREFIX || pathname.startsWith(`${OFFICIAL_CODEX_PATH_PREFIX}/`);
}

/**
 * 纯判定：给定三个候选地址与 API 声明，产出 Codex 自动接管资格与原因。
 * 不抛异常——所有失败都折成 capable=false + 机读原因。
 */
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

/**
 * 带鉴权的完整探测（菜单侧用）：先解析 auth（解析失败即认证不可用，不退回模型地址），
 * 再补上 provider 配置地址，交给纯判定。
 */
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
