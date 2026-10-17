// 压缩策略解析器（工单 02 核心）：给定模型身份与配置，产出唯一的压缩策略结果。
//
// 纯行为接缝（规格「策略模型与匹配」）：不读网络、不发请求、不改 session 状态；
// 同输入同输出，结果可 JSON 序列化。调用方（工单 03 的调度器、配置向导的诊断行）
// 只消费 CompressionStrategyResolution，不感知匹配细节。
//
// 选择顺序固定：显式 provider/model 规则 → 可选的 ACP 自动检测 → 默认策略。
// - 显式规则按精度排序：provider+model+api+baseUrl > （provider+model+api 或
//   provider+model+baseUrl，约束数同为 1 的并列）> provider+model；
// - 同一最高精度多条命中且生效结果（mode/protocol/profile/onUnsupported）不一致时
//   报告配置冲突并回退默认策略，不按数组顺序猜测；生效结果完全一致视为重复条目，
//   任取一条；显式 native 规则同样阻止自动 ACP（有显式命中就不进自动检测）；
// - ACP 自动检测只在无任何显式规则命中时参与：contextWindow ≤ 阈值进 acp，
//   元数据缺失或无效时回默认策略不猜测；
// - model.api 只用于可选约束与诊断，绝不单独造成 Codex 接管。

import {
  DEFAULT_CODEX_PROTOCOL,
  type CodexProtocol,
  type CodexUnsupportedPolicy,
  type CompressionMode,
  type CompressionModelRule,
  type CompressionSettings,
  type ModelIdentity,
  type NativeTriggerPolicy,
} from "./api.ts";

/** 策略来源：显式规则命中 / ACP 自动检测 / 默认策略 */
export type CompressionSource = "explicit" | "acp-auto" | "default";

/**
 * 命中精度（规则携带的可选约束数）：
 * - provider-model-api-baseUrl：3 约束（api + baseUrl）
 * - provider-model-api / provider-model-baseUrl：1 约束，精度并列
 * - provider-model：无约束
 * 规格命名的三档顺序（pm+api+baseUrl > pm+api > pm）由 PRECISION_RANK 保持。
 */
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

/** 回退原因：命中了哪条通路之外的异常情况（正常默认策略不带原因） */
export type CompressionFallbackReason =
  | "conflict"
  | "context-window-missing"
  | "invalid-identity";

/** 冲突中第一个不一致的生效字段 */
export type CompressionConflictField = "mode" | "protocol" | "profile" | "onUnsupported";

/** 同精度多条命中的冲突报告：冲突规则在 settings.modelRules 里的下标（0 基） */
export interface CompressionRuleConflict {
  readonly indices: readonly number[];
  readonly field: CompressionConflictField;
}

/** 规范化后的模型身份（解析入口先规范化，之后全程比较规范化值） */
export interface NormalizedModelIdentity {
  readonly provider: string;
  readonly modelId: string;
  readonly api: string | undefined;
  readonly baseUrl: string | undefined;
  readonly contextWindow: number | undefined;
}

/** 命中规则的视图：下标 + 原规则 + 规范化身份 + 精度（诊断与调度器消费） */
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

/** 策略解析结果：稳定、可序列化、可诊断。不适用的字段缺席（不出现在对象上），
 *  保证 JSON 往返逐字段相等；消费方读 absent 字段得到 undefined。 */
export interface CompressionStrategyResolution {
  /** 实际模式 */
  readonly mode: CompressionMode;
  /** 来源：显式规则 / 自动 ACP / 默认策略 */
  readonly source: CompressionSource;
  /** 命中规则（含下标、规范化身份与精度）；未命中时缺席 */
  readonly matchedRule?: MatchedRuleView;
  /** 生效的 Codex 协议（mode=codex 时：规则值或产品默认；其余模式缺席） */
  readonly protocol?: CodexProtocol;
  /** 生效的 Codex profile（mode=codex 且规则声明时） */
  readonly profile?: string;
  /** 生效的 Codex 失败策略（mode=codex 时：规则值或 native） */
  readonly onUnsupported?: CodexUnsupportedPolicy;
  /** 触发策略：native 用配置的 nativeTrigger；codex/acp 接管自动与手动两种压缩事件，固定 auto */
  readonly triggerPolicy: NativeTriggerPolicy;
  /** 身份里可用的 contextWindow（已校验；缺失或无效时缺席） */
  readonly contextWindow?: number;
  /** 回退原因（conflict / context-window-missing / invalid-identity）；正常路径缺席 */
  readonly fallbackReason?: CompressionFallbackReason;
  /** 同精度冲突清单；仅在 fallbackReason=conflict 时非空 */
  readonly conflicts: readonly CompressionRuleConflict[];
}

// ─────────────────────────────────────────────────────────────
// 规范化（规格「策略模型与匹配」）
// ─────────────────────────────────────────────────────────────

/** provider / model id / api / profile 等词面值：去首尾空白 */
export function normalizeCompressionToken(value: string): string {
  return value.trim();
}

/**
 * baseUrl 规范化比较键：去尾部斜杠，按协议 / 主机（大小写不敏感）/ 端口（缺省
 * 端口归一）/ 路径（大小写敏感，尾斜杠不敏感）比较；query 保留。无法按 URL 解析
 * 的值退化为 trim + 去尾斜杠的字符串比较，不猜不抛。
 */
export function normalizeBaseUrlForCompare(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  try {
    const url = new URL(trimmed);
    // url.host 已含显式非默认端口、已去默认端口；协议与主机小写归一
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.protocol}//${url.host.toLowerCase()}${path}${url.search}`;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

/**
 * contextWindow 元数据校验：有限正数才算可用；缺失、非数字、NaN、Infinity、
 * 0 或负数一律视为不可用（自动 ACP 不猜测）。
 */
export function readValidContextWindow(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** 规范化模型身份：token 去空白、baseUrl 去 trim、contextWindow 校验 */
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

// ─────────────────────────────────────────────────────────────
// 匹配与冲突
// ─────────────────────────────────────────────────────────────

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

/** 规则是否命中（已规范化的）模型身份：身份字段全等；baseUrl 按规范化键比较 */
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

/** 规则的生效 Codex 参数（profile/protocol/onUnsupported 只在 codex 模式下生效） */
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

/** 生效结果是否完全一致（同精度多条命中时判定重复条目还是冲突） */
function sameOutcome(left: CompressionModelRule, right: CompressionModelRule): boolean {
  if (left.mode !== right.mode) return false;
  const a = effectiveCodexParams(left);
  const b = effectiveCodexParams(right);
  return (
    a.protocol === b.protocol && a.profile === b.profile && a.onUnsupported === b.onUnsupported
  );
}

/** 同精度多条命中时第一个不一致的生效字段（mode → protocol → profile → onUnsupported） */
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

// ─────────────────────────────────────────────────────────────
// 解析主流程
// ─────────────────────────────────────────────────────────────

function defaultResolution(
  settings: CompressionSettings,
  contextWindow: number | undefined,
  fallbackReason: CompressionFallbackReason | undefined,
  conflicts: readonly CompressionRuleConflict[] = [],
): CompressionStrategyResolution {
  const mode = settings.defaultMode;
  // codex 相关字段仅在 codex 模式下携带：结果对象不出现 undefined 值的键，
  // 保证 JSON 往返逐字段相等（稳定可序列化契约，工单 03 调度器可安全传递）
  const codex = mode === "codex";
  return {
    mode,
    source: "default",
    ...(codex ? { protocol: DEFAULT_CODEX_PROTOCOL, onUnsupported: "native" as const } : {}),
    triggerPolicy: mode === "native" ? settings.nativeTrigger : "auto",
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(fallbackReason === undefined ? {} : { fallbackReason }),
    conflicts: [...conflicts],
  };
}

/**
 * 策略解析（工单 02 对外主出口，工单 03 调度器消费同一签名）：
 * 输入当前模型身份与已解析配置，输出唯一的压缩策略结果。纯函数。
 */
export function resolveCompressionStrategy(
  identity: ModelIdentity,
  settings: CompressionSettings,
): CompressionStrategyResolution {
  const normalized = normalizeModelIdentity(identity);

  // 身份本身不可用（provider/model 空）：回默认策略并说明原因，不做任何猜测
  if (normalized.provider === "" || normalized.modelId === "") {
    return defaultResolution(settings, normalized.contextWindow, "invalid-identity");
  }

  // 1. 显式规则：收集全部命中，取最高精度组
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
        // 同精度多条命中且生效结果不一致：配置冲突。显式命中已经存在，
        // 自动 ACP 不参与（它只在无任何显式规则命中时参与），回默认策略。
        return defaultResolution(settings, normalized.contextWindow, "conflict", [
          { indices: top.map((entry) => entry.view.index), field },
        ]);
      }
      // 生效结果完全一致的重复条目：不是冲突，取第一条
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
      triggerPolicy: winner.rule.mode === "native" ? settings.nativeTrigger : "auto",
      ...(normalized.contextWindow === undefined ? {} : { contextWindow: normalized.contextWindow }),
      conflicts: [],
    };
  }

  // 2. ACP 自动检测：只在无任何显式规则命中时参与（含显式 native 规则的阻止）
  if (settings.acpAutoDetect) {
    if (normalized.contextWindow === undefined) {
      // 元数据缺失或无效：不猜测，回默认策略并说明原因
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
    // 窗口高于阈值：正常走默认策略，不算回退
  }

  // 3. 默认策略
  return defaultResolution(settings, normalized.contextWindow, undefined);
}
