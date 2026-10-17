// Codex Responses 的 API → profile 兼容形状映射（工单 04 从上游
// pi-codex-compact 的 model-api.ts 提取）。
//
// 上游对应：reference/Pi生态/pi-codex-compact/source/src/model-api.ts
// （MIT，来源登记见 ../UPSTREAM.md）。提取范围：RESPONSES_COMPACTION_APIS、
// ResponsesCompactionProfile、按 API 推导 profile 的纯函数。上游的
// CompactionRoute / apiProfiles 全局白名单不进入本仓——规格「Codex 契约」：
// Codex 资格由 provider/model 白名单（策略解析）先行筛选，`model.api` 只用于
// 请求形状推导、诊断与可选约束，绝不单独造成接管；规则里的 profile 字段是
// 具体规则的兼容声明（对应上游 apiProfiles 转成规则级信息），不是能力探测。

/** 已知具备 Responses 请求形状的内置 API（profile 可由 API 直接推导） */
export const RESPONSES_COMPACTION_APIS = [
  "openai-codex-responses",
  "openai-responses",
  "azure-openai-responses",
] as const;

export type BuiltInResponsesCompactionApi = (typeof RESPONSES_COMPACTION_APIS)[number];

/**
 * Responses 字段兼容声明：codex-responses-v1 = Codex Responses 字段形状；
 * openai-responses-v1 = 普通 OpenAI Responses 字段形状。白名单模型命中后由
 * API 推导或由规则显式声明（自定义 API 只能声明 codex-responses-v1）。
 */
export type ResponsesCompactionProfile = "codex-responses-v1" | "openai-responses-v1";

/** API 是否是已知 Responses 形状 */
export function isResponsesCompactionApi(api: string): api is BuiltInResponsesCompactionApi {
  return (RESPONSES_COMPACTION_APIS as readonly string[]).includes(api);
}

/** 按 API 推导 profile：已知 Responses API 有固定推导，其它 API 无推导 */
export function deriveResponsesProfile(api: string | undefined): ResponsesCompactionProfile | undefined {
  if (api === "openai-codex-responses") return "codex-responses-v1";
  if (api === "openai-responses" || api === "azure-openai-responses") return "openai-responses-v1";
  return undefined;
}

/**
 * profile 与 API 的一致性（checkpoint 身份校验与 preflight 共用）：
 * 已知 Responses API 必须使用其推导 profile；自定义 API 只能声明
 * codex-responses-v1（上游 v3 checkpoint 契约同款口径）。
 */
export function profileMatchesApi(api: string, profile: ResponsesCompactionProfile): boolean {
  const derived = deriveResponsesProfile(api);
  if (derived !== undefined) return derived === profile;
  return profile === "codex-responses-v1";
}
