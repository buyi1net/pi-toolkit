// 压缩模块的配置节解析（工单 01 骨架 + 工单 02 规则扩展）。
//
// 配置落点：pi-toolkit.json 的 `modules.compression` 节，带独立 schemaVersion。
// 菜单 schema 只放开关和有限枚举（enabled / defaultMode / nativeTrigger /
// acpAutoDetect，经 kit 的 schema 规范化）；schemaVersion、modelRules、
// acpAutoDetectThreshold 等结构化字段由本解析器校验。
//
// 校验口径（规格「配置节与 Schema」）：非法值逐项报告并回退默认；schemaVersion 高于
// 当前支持或无法解释时整节回退默认策略（不得静默丢弃，也不得冒险解释未知版本的字段）；
// 单条模型规则写错只剔除该条，不阻断其余规则（配置错误逐项报告并回到安全的默认策略，
// 不能因为一个模型规则写错而阻断未涉及的模型）。
// 解析是纯行为：给定配置节结果稳定，不读网络、不碰会话状态。

import type { ModuleConfigRecord, ModuleConfigValue } from "../../kit/module.ts";
import {
  ACP_COMPRESS_FIELDS,
  ACP_PRESETS,
  ACP_PRESET_VERSION,
  ACP_PROMPT_OVERRIDE_KEYS,
  ACP_PROMPT_PACKS,
  ACP_RECOMMENDED_CONFIG,
  CODEX_PROTOCOLS,
  CODEX_UNSUPPORTED_POLICIES,
  COMPRESSION_MODES,
  COMPRESSION_SCHEMA_VERSION,
  DEFAULT_ACP_AUTO_DETECT_ENABLED,
  DEFAULT_ACP_CONTEXT_WINDOW_THRESHOLD,
  DEFAULT_CODEX_PROTOCOL,
  DEFAULT_COMPRESSION_MODES,
  DEFAULT_COMPRESSION_SETTINGS,
  EMPTY_ACP_ADVANCED_SETTINGS,
  NATIVE_TRIGGER_POLICIES,
  type AcpAdvancedSettings,
  type AcpCompressField,
  type AcpCompressOverrides,
  type AcpPreset,
  type AcpPromptOverrideKey,
  type AcpPromptPack,
  type AcpProviderOverrides,
  type CompressionConfigProblem,
  type CompressionMode,
  type CompressionModelRule,
  type CompressionSettings,
  type DefaultCompressionMode,
  type NativeTriggerPolicy,
} from "./api.ts";

export interface LoadedCompressionSettings {
  readonly settings: CompressionSettings;
  readonly problems: readonly CompressionConfigProblem[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 问题里展示的原值：标量直接显示，对象/数组给 JSON 摘要，避免丢成 "[object Object]" */
function describeValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return String(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** 读一个有限枚举字段：缺省用默认值，非法逐项报告并回退默认 */
function readEnumField<T extends string>(
  field: keyof CompressionSettings & string,
  allowed: readonly T[],
  source: Record<string, unknown>,
  problems: CompressionConfigProblem[],
): T {
  const fallback = DEFAULT_COMPRESSION_SETTINGS[field] as T;
  const raw = source[field];
  if (raw === undefined) return fallback;
  if (typeof raw === "string" && (allowed as readonly string[]).includes(raw)) return raw as T;
  problems.push({
    kind: "badEnum",
    field: `modules.compression.${field}`,
    value: describeValue(raw),
    allowed: [...allowed],
    fallback,
  });
  return fallback;
}

/** 读布尔开关字段：缺省用默认值，非布尔逐项报告并回退默认 */
function readBooleanField(
  field: keyof CompressionSettings & string,
  source: Record<string, unknown>,
  problems: CompressionConfigProblem[],
): boolean {
  const fallback = DEFAULT_COMPRESSION_SETTINGS[field] as boolean;
  const raw = source[field];
  if (raw === undefined) return fallback;
  if (typeof raw === "boolean") return raw;
  problems.push({
    kind: "badBoolean",
    field: `modules.compression.${field}`,
    value: describeValue(raw),
    fallback,
  });
  return fallback;
}

/** 读正整数字段（ACP 自动检测阈值）：缺省用默认值，非法逐项报告并回退默认 */
function readPositiveIntField(
  field: keyof CompressionSettings & string,
  source: Record<string, unknown>,
  problems: CompressionConfigProblem[],
): number {
  const fallback = DEFAULT_COMPRESSION_SETTINGS[field] as number;
  const raw = source[field];
  if (raw === undefined) return fallback;
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) return raw;
  problems.push({
    kind: "badNumber",
    field: `modules.compression.${field}`,
    value: describeValue(raw),
    fallback,
  });
  return fallback;
}

/** 规则里的可选字符串字段：非字符串逐项报告并剔除该字段；trim 后为空视为未设置 */
function readOptionalString(
  key: string,
  entry: Record<string, unknown>,
  fieldPath: string,
  problems: CompressionConfigProblem[],
): string | undefined {
  const raw = entry[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    problems.push({ kind: "badString", field: `${fieldPath}.${key}`, value: describeValue(raw) });
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** 规则里的可选枚举字段：非法逐项报告并剔除该字段（规则保留，按缺省生效） */
function readOptionalEnum<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
  entry: Record<string, unknown>,
  fieldPath: string,
  problems: CompressionConfigProblem[],
): T | undefined {
  const raw = entry[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string" && (allowed as readonly string[]).includes(raw)) return raw as T;
  problems.push({
    kind: "badEnum",
    field: `${fieldPath}.${key}`,
    value: describeValue(raw),
    allowed: [...allowed],
    fallback,
  });
  return undefined;
}

/**
 * 解析单条模型规则。身份（provider/model）与结果（mode）是必要字段：
 * 身份缺失或 mode 非法时整条剔除并报告；api / baseUrl / protocol / profile /
 * onUnsupported 是可选字段，写错只剔除该字段并报告，规则本体保留。
 * 解析结果已做空白规范化（provider/model/api/baseUrl/profile 去空白）。
 */
function parseRuleEntry(
  entry: unknown,
  fieldPath: string,
  problems: CompressionConfigProblem[],
): CompressionModelRule | null {
  if (!isRecord(entry)) {
    problems.push({ kind: "ruleInvalid", field: fieldPath, value: describeValue(entry) });
    return null;
  }
  const providerRaw = entry.provider;
  const modelRaw = entry.model;
  const provider = typeof providerRaw === "string" ? providerRaw.trim() : "";
  const model = typeof modelRaw === "string" ? modelRaw.trim() : "";
  if (provider === "" || model === "") {
    // 指到先出问题的那个身份字段上；两个都坏时指 provider
    const badKey = provider === "" ? "provider" : "model";
    problems.push({
      kind: "ruleMissingIdentity",
      field: `${fieldPath}.${badKey}`,
      value: describeValue(badKey === "provider" ? providerRaw : modelRaw),
    });
    return null;
  }
  const modeRaw = entry.mode;
  if (typeof modeRaw !== "string" || !(COMPRESSION_MODES as readonly string[]).includes(modeRaw)) {
    // 没有可用的结果模式，整条规则无效
    problems.push({
      kind: "badEnum",
      field: `${fieldPath}.mode`,
      value: describeValue(modeRaw),
      allowed: [...COMPRESSION_MODES],
      fallback: "native",
    });
    return null;
  }
  const mode = modeRaw as CompressionMode;
  const api = readOptionalString("api", entry, fieldPath, problems);
  const baseUrl = readOptionalString("baseUrl", entry, fieldPath, problems);
  const protocol = readOptionalEnum(
    "protocol",
    CODEX_PROTOCOLS,
    DEFAULT_CODEX_PROTOCOL,
    entry,
    fieldPath,
    problems,
  );
  const profile = readOptionalString("profile", entry, fieldPath, problems);
  const onUnsupported = readOptionalEnum(
    "onUnsupported",
    CODEX_UNSUPPORTED_POLICIES,
    "native",
    entry,
    fieldPath,
    problems,
  );
  return {
    provider,
    model,
    mode,
    ...(api !== undefined ? { api } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(protocol !== undefined ? { protocol } : {}),
    ...(profile !== undefined ? { profile } : {}),
    ...(onUnsupported !== undefined ? { onUnsupported } : {}),
  };
}

/**
 * 解析 `modelRules` 数组：不是数组时整体剔除并报告（其余顶层字段不受影响）；
 * 数组内逐条解析，坏条目只剔除自己。
 */
function parseModelRules(
  raw: unknown,
  problems: CompressionConfigProblem[],
): CompressionModelRule[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    problems.push({
      kind: "rulesInvalid",
      field: "modules.compression.modelRules",
      value: describeValue(raw),
    });
    return [];
  }
  const rules: CompressionModelRule[] = [];
  raw.forEach((entry, index) => {
    const parsed = parseRuleEntry(entry, `modules.compression.modelRules[${index}]`, problems);
    if (parsed) rules.push(parsed);
  });
  return rules;
}

// ─────────────────────────────────────────────────────────────
// ACP 高级配置（工单 10）：modules.compression.acp 的逐字段校验与级联合并
//
// 形状（上游 billion-context-pi 的 CompressSettings 字段名 + providers/models 级联）：
//   acp: { maxContextLimit, emergencyThresholdPercent, nudgeGrowthTokens,
//          preserveRecentMessages, protectedTools, promptPack, prompts, reasoning,
//          stripImages, stripImagesKeepRecent,
//          providers: { <provider>: { …同字段…, models: { <model>: {…} } } } }
// 字段缺省（含 null 墨碑）= 本层不覆盖、继承上一级；逐字段最深者生效（见
// mergeAcpCompressOverrides）。非法字段逐项报告并剔除，不阻断同层其它字段，
// 也不阻断 modelRules（规格「配置节与 Schema」）。
// ─────────────────────────────────────────────────────────────

/** ACP 覆盖的层级定位：两字段都缺 = 全局；只 provider = 供应商级；都全 = 模型级 */
export interface AcpOverrideLevel {
  readonly provider?: string;
  readonly model?: string;
}

/**
 * percent 字段的文件写法（与上游一致）：比例数字 0.75 或百分串 "75%"；
 * 越界（≤0 / >1 / 非数）一律非法。返回解析后的比例 (0,1]。
 */
export function normalizeAcpPercentFileValue(raw: unknown): number | undefined {
  let value: number | undefined;
  if (typeof raw === "number") {
    value = raw;
  } else if (typeof raw === "string" && raw.trim().endsWith("%")) {
    const percent = Number(raw.trim().slice(0, -1));
    value = Number.isFinite(percent) ? percent / 100 : Number.NaN;
  }
  if (value === undefined || !Number.isFinite(value) || value <= 0 || value > 1) return undefined;
  return value;
}

/** 编辑器输入框的 percent 解析："75"/"75%" 按百分数，"0.75" 按比例（≤1 视为比例） */
export function parseAcpPercentUserInput(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === "" || !/^[+]?[\d.]+%?$/.test(trimmed)) return undefined;
  if (trimmed.endsWith("%")) return normalizeAcpPercentFileValue(trimmed);
  const numeric = Number(trimmed);
  if (!Number.isFinite(numeric)) return undefined;
  return normalizeAcpPercentFileValue(numeric > 1 ? `${numeric}%` : numeric);
}

/** percent → 文件写法（统一写百分串，自解释且与上游文档一致） */
export function formatAcpPercentFileValue(ratio: number): string {
  return `${Number((ratio * 100).toPrecision(6))}%`;
}

/** 编辑器输入的正整数解析（> 0） */
export function parseAcpPositiveIntUserInput(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^\+?\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** 编辑器输入的非负整数解析（≥ 0） */
export function parseAcpCountUserInput(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : undefined;
}

/** 某字段在本层未设置（含 null 墨碑）时返回 undefined，不产生问题 */
function rawOverride(entry: Record<string, unknown>, key: string): unknown | undefined {
  const raw = entry[key];
  return raw === undefined || raw === null ? undefined : raw;
}

function readPercentOverride(
  key: AcpCompressField,
  entry: Record<string, unknown>,
  fieldPath: string,
  problems: CompressionConfigProblem[],
): number | undefined {
  const raw = rawOverride(entry, key);
  if (raw === undefined) return undefined;
  const parsed = normalizeAcpPercentFileValue(raw);
  if (parsed !== undefined) return parsed;
  problems.push({ kind: "badPercent", field: `${fieldPath}.${key}`, value: describeValue(raw) });
  return undefined;
}

function readPositiveIntOverride(
  key: AcpCompressField,
  entry: Record<string, unknown>,
  fieldPath: string,
  problems: CompressionConfigProblem[],
): number | undefined {
  const raw = rawOverride(entry, key);
  if (raw === undefined) return undefined;
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0) return raw;
  problems.push({ kind: "badPositiveInt", field: `${fieldPath}.${key}`, value: describeValue(raw) });
  return undefined;
}

function readCountOverride(
  key: AcpCompressField,
  entry: Record<string, unknown>,
  fieldPath: string,
  problems: CompressionConfigProblem[],
): number | undefined {
  const raw = rawOverride(entry, key);
  if (raw === undefined) return undefined;
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) return raw;
  problems.push({ kind: "badCount", field: `${fieldPath}.${key}`, value: describeValue(raw) });
  return undefined;
}

function readBooleanOverride(
  key: AcpCompressField,
  entry: Record<string, unknown>,
  fieldPath: string,
  problems: CompressionConfigProblem[],
): boolean | undefined {
  const raw = rawOverride(entry, key);
  if (raw === undefined) return undefined;
  if (typeof raw === "boolean") return raw;
  problems.push({
    kind: "badBoolean",
    field: `${fieldPath}.${key}`,
    value: describeValue(raw),
    fallback: false,
  });
  return undefined;
}

function readEnumOverride<T extends string>(
  key: AcpCompressField,
  allowed: readonly T[],
  entry: Record<string, unknown>,
  fieldPath: string,
  problems: CompressionConfigProblem[],
): T | undefined {
  const raw = rawOverride(entry, key);
  if (raw === undefined) return undefined;
  if (typeof raw === "string" && (allowed as readonly string[]).includes(raw)) return raw as T;
  problems.push({
    kind: "badEnum",
    field: `${fieldPath}.${key}`,
    value: describeValue(raw),
    allowed: [...allowed],
    fallback: allowed[0]!,
  });
  return undefined;
}

/** protectedTools：非数组报告 badArray；数组内逐项校验（字符串、trim 非空），坏项只剔自己 */
function readProtectedToolsOverride(
  entry: Record<string, unknown>,
  fieldPath: string,
  problems: CompressionConfigProblem[],
): readonly string[] | undefined {
  const raw = rawOverride(entry, "protectedTools");
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    problems.push({ kind: "badArray", field: `${fieldPath}.protectedTools`, value: describeValue(raw) });
    return undefined;
  }
  const tools: string[] = [];
  raw.forEach((item, index) => {
    if (typeof item === "string" && item.trim() !== "") {
      tools.push(item.trim());
      return;
    }
    problems.push({
      kind: "badString",
      field: `${fieldPath}.protectedTools[${index}]`,
      value: describeValue(item),
    });
  });
  return tools;
}

/** 提示词覆写：按槽位校验（非字符串报告并剔除；trim 后为空视为未覆写） */
function readPromptsOverride(
  entry: Record<string, unknown>,
  fieldPath: string,
  problems: CompressionConfigProblem[],
): Readonly<Partial<Record<AcpPromptOverrideKey, string>>> | undefined {
  const raw = rawOverride(entry, "prompts");
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    problems.push({ kind: "badString", field: `${fieldPath}.prompts`, value: describeValue(raw) });
    return undefined;
  }
  const prompts: Partial<Record<AcpPromptOverrideKey, string>> = {};
  for (const key of ACP_PROMPT_OVERRIDE_KEYS) {
    const value = readOptionalString(key, raw, `${fieldPath}.prompts`, problems);
    if (value !== undefined) prompts[key] = value;
  }
  return Object.keys(prompts).length > 0 ? prompts : undefined;
}

/** reasoning：{ drop?: boolean, threshold?: 非负整数 }，子字段逐项校验（字段级继承靠合并层） */
function readReasoningOverride(
  entry: Record<string, unknown>,
  fieldPath: string,
  problems: CompressionConfigProblem[],
): { drop?: boolean; threshold?: number } | undefined {
  const raw = rawOverride(entry, "reasoning");
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    problems.push({ kind: "badString", field: `${fieldPath}.reasoning`, value: describeValue(raw) });
    return undefined;
  }
  let dropValue: boolean | undefined;
  if (raw.drop !== undefined && raw.drop !== null) {
    if (typeof raw.drop === "boolean") dropValue = raw.drop;
    else {
      problems.push({ kind: "badBoolean", field: `${fieldPath}.reasoning.drop`, value: describeValue(raw.drop), fallback: false });
    }
  }
  let thresholdValue: number | undefined;
  if (raw.threshold !== undefined && raw.threshold !== null) {
    if (typeof raw.threshold === "number" && Number.isSafeInteger(raw.threshold) && raw.threshold >= 0) {
      thresholdValue = raw.threshold;
    } else {
      problems.push({ kind: "badCount", field: `${fieldPath}.reasoning.threshold`, value: describeValue(raw.threshold) });
    }
  }
  if (dropValue === undefined && thresholdValue === undefined) return undefined;
  return {
    ...(dropValue === undefined ? {} : { drop: dropValue }),
    ...(thresholdValue === undefined ? {} : { threshold: thresholdValue }),
  };
}

/**
 * 解析一级 ACP 覆盖（global / provider / model 共用同一形状）：逐字段校验，
 * 非法字段报告并剔除（undefined = 不覆盖），不阻断同层其它字段。
 */
function parseAcpOverrides(
  entry: unknown,
  fieldPath: string,
  problems: CompressionConfigProblem[],
): AcpCompressOverrides {
  if (entry === undefined || entry === null || !isRecord(entry)) return {};
  const source = entry as Record<string, unknown>;
  const maxContextLimit = readPercentOverride("maxContextLimit", source, fieldPath, problems);
  const emergencyThresholdPercent = readPercentOverride("emergencyThresholdPercent", source, fieldPath, problems);
  const nudgeGrowthTokens = readPositiveIntOverride("nudgeGrowthTokens", source, fieldPath, problems);
  const preserveRecentMessages = readCountOverride("preserveRecentMessages", source, fieldPath, problems);
  const protectedTools = readProtectedToolsOverride(source, fieldPath, problems);
  const promptPack = readEnumOverride<AcpPromptPack>("promptPack", ACP_PROMPT_PACKS, source, fieldPath, problems);
  const prompts = readPromptsOverride(source, fieldPath, problems);
  const reasoning = readReasoningOverride(source, fieldPath, problems);
  const stripImages = readBooleanOverride("stripImages", source, fieldPath, problems);
  const stripImagesKeepRecent = readCountOverride("stripImagesKeepRecent", source, fieldPath, problems);
  return {
    ...(maxContextLimit === undefined ? {} : { maxContextLimit }),
    ...(emergencyThresholdPercent === undefined ? {} : { emergencyThresholdPercent }),
    ...(nudgeGrowthTokens === undefined ? {} : { nudgeGrowthTokens }),
    ...(preserveRecentMessages === undefined ? {} : { preserveRecentMessages }),
    ...(protectedTools === undefined ? {} : { protectedTools }),
    ...(promptPack === undefined ? {} : { promptPack }),
    ...(prompts === undefined ? {} : { prompts }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(stripImages === undefined ? {} : { stripImages }),
    ...(stripImagesKeepRecent === undefined ? {} : { stripImagesKeepRecent }),
  };
}

/**
 * 解析 `modules.compression.acp`：全局覆盖 + providers（每家可带 models）。
 * 结构坏（节/字典非对象）只报结构问题并丢弃该块；键名 trim 后为空跳过；
 * 条目逐字段校验（见 parseAcpOverrides）。
 */
export function parseAcpAdvanced(
  raw: unknown,
  problems: CompressionConfigProblem[],
): AcpAdvancedSettings {
  if (raw === undefined || raw === null) return EMPTY_ACP_ADVANCED_SETTINGS;
  if (!isRecord(raw)) {
    problems.push({ kind: "acpSectionInvalid", field: "modules.compression.acp", value: describeValue(raw) });
    return EMPTY_ACP_ADVANCED_SETTINGS;
  }
  const global = parseAcpOverrides(raw, "modules.compression.acp", problems);
  const providersRaw = raw.providers;
  if (providersRaw === undefined || providersRaw === null) return { global, providers: {} };
  if (!isRecord(providersRaw)) {
    problems.push({
      kind: "acpProvidersInvalid",
      field: "modules.compression.acp.providers",
      value: describeValue(providersRaw),
    });
    return { global, providers: {} };
  }
  const providers: Record<string, AcpProviderOverrides> = {};
  for (const [providerKey, providerRaw] of Object.entries(providersRaw)) {
    const provider = providerKey.trim();
    if (provider === "" || providerRaw === undefined || providerRaw === null) continue;
    const providerPath = `modules.compression.acp.providers.${provider}`;
    if (!isRecord(providerRaw)) {
      problems.push({ kind: "acpProviderInvalid", field: providerPath, value: describeValue(providerRaw) });
      continue;
    }
    const overrides = parseAcpOverrides(providerRaw, providerPath, problems);
    let models: Record<string, AcpCompressOverrides> | undefined;
    if (providerRaw.models !== undefined && providerRaw.models !== null) {
      if (!isRecord(providerRaw.models)) {
        problems.push({
          kind: "acpModelsInvalid",
          field: `${providerPath}.models`,
          value: describeValue(providerRaw.models),
        });
      } else {
        const parsedModels: Record<string, AcpCompressOverrides> = {};
        for (const [modelKey, modelRaw] of Object.entries(providerRaw.models)) {
          const model = modelKey.trim();
          if (model === "" || modelRaw === undefined || modelRaw === null) continue;
          if (!isRecord(modelRaw)) {
            problems.push({
              kind: "acpModelInvalid",
              field: `${providerPath}.models.${model}`,
              value: describeValue(modelRaw),
            });
            continue;
          }
          parsedModels[model] = parseAcpOverrides(modelRaw, `${providerPath}.models.${model}`, problems);
        }
        if (Object.keys(parsedModels).length > 0) models = parsedModels;
      }
    }
    providers[provider] = { ...overrides, ...(models === undefined ? {} : { models }) };
  }
  return { global, providers };
}

/**
 * 三级级联合并（规格「ACP 契约」）：global → provider → model 逐字段最深者生效。
 * 深层字段的 undefined 不清除浅层已设值（只有显式定义才覆盖）；reasoning / prompts
 * 按子字段分别继承。上游同款语义（mergeCompress 的 ?? 链）。provider / modelId
 * 未命中（或未提供）时退化为浅层。
 */
export function mergeAcpCompressOverrides(
  acp: AcpAdvancedSettings,
  provider?: string,
  modelId?: string,
): AcpCompressOverrides {
  const providerOverrides = provider === undefined ? undefined : acp.providers[provider];
  const modelOverrides =
    providerOverrides === undefined || modelId === undefined ? undefined : providerOverrides.models?.[modelId];
  const pick = <K extends keyof AcpCompressOverrides>(key: K): AcpCompressOverrides[K] =>
    modelOverrides?.[key] ?? providerOverrides?.[key] ?? acp.global[key];

  const maxContextLimit = pick("maxContextLimit");
  const emergencyThresholdPercent = pick("emergencyThresholdPercent");
  const nudgeGrowthTokens = pick("nudgeGrowthTokens");
  const preserveRecentMessages = pick("preserveRecentMessages");
  const protectedTools = pick("protectedTools");
  const promptPack = pick("promptPack");
  const stripImages = pick("stripImages");
  const stripImagesKeepRecent = pick("stripImagesKeepRecent");

  // reasoning / prompts 是分组字段：按子字段分别走三级 ?? 链（深层子字段不清除浅层）
  const reasoningDrop = modelOverrides?.reasoning?.drop ?? providerOverrides?.reasoning?.drop ?? acp.global.reasoning?.drop;
  const reasoningThreshold =
    modelOverrides?.reasoning?.threshold ?? providerOverrides?.reasoning?.threshold ?? acp.global.reasoning?.threshold;
  const prompts: Partial<Record<AcpPromptOverrideKey, string>> = {};
  for (const key of ACP_PROMPT_OVERRIDE_KEYS) {
    const merged = modelOverrides?.prompts?.[key] ?? providerOverrides?.prompts?.[key] ?? acp.global.prompts?.[key];
    if (merged !== undefined) prompts[key] = merged;
  }

  return {
    ...(maxContextLimit === undefined ? {} : { maxContextLimit }),
    ...(emergencyThresholdPercent === undefined ? {} : { emergencyThresholdPercent }),
    ...(nudgeGrowthTokens === undefined ? {} : { nudgeGrowthTokens }),
    ...(preserveRecentMessages === undefined ? {} : { preserveRecentMessages }),
    ...(protectedTools === undefined ? {} : { protectedTools }),
    ...(promptPack === undefined ? {} : { promptPack }),
    ...(stripImages === undefined ? {} : { stripImages }),
    ...(stripImagesKeepRecent === undefined ? {} : { stripImagesKeepRecent }),
    ...(reasoningDrop === undefined && reasoningThreshold === undefined
      ? {}
      : {
          reasoning: {
            ...(reasoningDrop === undefined ? {} : { drop: reasoningDrop }),
            ...(reasoningThreshold === undefined ? {} : { threshold: reasoningThreshold }),
          },
        }),
    ...(Object.keys(prompts).length === 0 ? {} : { prompts }),
  };
}

/** 合并后的紧急阈值低于最大上下文阈值时的问题描述（引擎侧诊断消费） */
export interface AcpEscalationIssue {
  readonly max: number;
  readonly emergency: number;
}

/**
 * 合并结果的升档校验（上游约束：emergency 必须 ≥ max，否则三级升档秩序被破坏：
 * 软 nudge → 强制 nudge → 紧急截断）。只在合并层检查（同层写反与跨层组合都归到
 * 这里；解析层不做静态检查，避免被更深层覆盖后产生误报）。违反时消费侧把两项
 * 都回退内核默认（0.75 / 0.95），见 acp/config.ts。
 */
export function acpEscalationIssue(merged: AcpCompressOverrides): AcpEscalationIssue | undefined {
  if (merged.maxContextLimit === undefined || merged.emergencyThresholdPercent === undefined) return undefined;
  if (merged.emergencyThresholdPercent >= merged.maxContextLimit) return undefined;
  return { max: merged.maxContextLimit, emergency: merged.emergencyThresholdPercent };
}

/** 读某一级「自身」的覆盖（编辑器展示用；结构坏时返回空，问题另走完整解析） */
export function readAcpOverridesAt(section: unknown, level: AcpOverrideLevel): AcpCompressOverrides {
  const problems: CompressionConfigProblem[] = [];
  const advanced = parseAcpAdvanced(isRecord(section) ? section.acp : undefined, problems);
  if (level.provider === undefined) return advanced.global;
  const provider = advanced.providers[level.provider];
  if (!provider) return {};
  if (level.model === undefined) {
    const { models: _models, ...own } = provider;
    return own;
  }
  return provider.models?.[level.model] ?? {};
}

/** 一级覆盖里已设置的字段数（根行值位「N 项已覆盖」；分组字段算一项） */
export function countAcpOverrideFields(overrides: AcpCompressOverrides): number {
  let count = 0;
  for (const field of ACP_COMPRESS_FIELDS) {
    if (overrides[field] !== undefined) count += 1;
  }
  return count;
}

/**
 * 编辑器写盘补丁：把一组字段写入定位到层级路径。字段值为 null 表示显式清除
 * （kit 落盘是深合并、不删旧键，靠 null 墨碑让解析侧视为未设置；数组整体替换）。
 */
export function acpOverrideFieldPatch(
  level: AcpOverrideLevel,
  patch: Record<string, ModuleConfigValue>,
): ModuleConfigRecord {
  if (level.provider === undefined) return { acp: { ...patch } };
  if (level.model === undefined) {
    return { acp: { providers: { [level.provider]: { ...patch } } } };
  }
  return {
    acp: { providers: { [level.provider]: { models: { [level.model]: { ...patch } } } } },
  };
}

/** 自动分流阈值的写盘补丁（根级数值字段） */
export function acpAutoDetectThresholdPatch(value: number): ModuleConfigRecord {
  return { acpAutoDetectThreshold: value };
}

// ─────────────────────────────────────────────────────────────
// 工单 03：ACP 推荐预设（acpPreset / acpPresetVersion）
//
// 语义（规格「ACP 预设」）：
// - recommended：运行时那 8 个压缩参数强制取 ACP_RECOMMENDED_CONFIG（落点在
//   acp/config.ts 的级联）；promptPack / prompts 不在推荐范围内，保持用户配置；
// - custom：使用用户草稿（acp.global），草稿为空时保持内核默认；
// - recommended → custom：草稿完全为空时把推荐值填成草稿落盘；
// - custom → recommended：草稿原样保留在磁盘，但不参与当前运行时生效；
// - acpPresetVersion 是草稿播种时的推荐版本指纹：只落盘记录，不参与运行时判定
//   （recommended 始终按本构建常量解释）；版本变化绝不覆写已有草稿（草稿是
//   用户自己调过的值）。
// provider / model 级显式覆盖仍按既有三级级联优先于 preset 的 global 层（见
// acp/config.ts 的 presetGlobalLayer）。
// ─────────────────────────────────────────────────────────────

/**
 * 读 acpPreset（独立解析函数，追加导出）：缺省 recommended；非法值逐项报告并回退。
 * 该字段是顶层字段，写错只回退它自己，不触发整节回退（与 schemaVersion 闸不同）。
 */
export function parseAcpPreset(
  section: Record<string, unknown>,
  problems: CompressionConfigProblem[],
): AcpPreset {
  return readEnumField<AcpPreset>("acpPreset", ACP_PRESETS, section, problems);
}

/**
 * 读 acpPresetVersion（独立解析函数，追加导出）：缺省当前推荐版本；非正整数报告
 * 并回退当前版本。高于当前版本不报错也不回退——旧构建仍可解释这份配置，
 * 推荐值按本构建的常量解释，草稿不被覆写（向前兼容）。
 */
export function parseAcpPresetVersion(
  section: Record<string, unknown>,
  problems: CompressionConfigProblem[],
): number {
  return readPositiveIntField("acpPresetVersion", section, problems);
}

/** 推荐配置的磁盘草稿形状（percent 写百分串，与编辑器的落盘格式一致；数组/子对象复制一份，不与冻结常量共享引用） */
function recommendedDraftRecord(): ModuleConfigRecord {
  const recommended = ACP_RECOMMENDED_CONFIG;
  return {
    maxContextLimit: formatAcpPercentFileValue(recommended.maxContextLimit),
    emergencyThresholdPercent: formatAcpPercentFileValue(recommended.emergencyThresholdPercent),
    nudgeGrowthTokens: recommended.nudgeGrowthTokens,
    preserveRecentMessages: recommended.preserveRecentMessages,
    protectedTools: [...recommended.protectedTools],
    reasoning: { ...recommended.reasoning },
    stripImages: recommended.stripImages,
    stripImagesKeepRecent: recommended.stripImagesKeepRecent,
  };
}

/**
 * 预设切换的写盘补丁：两档都带上 acpPreset 与当前推荐指纹。
 * recommended → custom 且草稿完全为空时，把推荐配置填成草稿（草稿已有任何覆盖则
 * 原样保留，切回去再切回来不会丢用户调过的值）。
 */
export function acpPresetPatch(target: AcpPreset, draft: AcpCompressOverrides): ModuleConfigRecord {
  const stamp: ModuleConfigRecord = { acpPreset: target, acpPresetVersion: ACP_PRESET_VERSION };
  if (target === "recommended") return stamp;
  if (countAcpOverrideFields(draft) > 0) return stamp;
  return { ...stamp, acp: recommendedDraftRecord() };
}

// ── 工单 07：旧配置平滑迁移 ──

/**
 * 全局默认压缩模式的两值枚举读取（工单 05 收窄 + 工单 07 迁移提示）。
 * `defaultMode: "codex"` 在上一版里是合法取值，现在只能经模型规则或当前会话覆盖进入；
 * 遇到旧值时映射为 native 并报**专属迁移问题**（不是普通非法枚举）：用户需要知道
 * 策略被改了、以及怎么把 Codex 找回来（为 GPT 模型加显式规则）。
 */
export function readDefaultCompressionMode(
  section: Record<string, unknown>,
  problems: CompressionConfigProblem[],
): DefaultCompressionMode {
  if (section.defaultMode === "codex") {
    problems.push({
      kind: "legacyCodexDefaultMode",
      field: "modules.compression.defaultMode",
      value: "codex",
      fallback: "native",
    });
    return "native";
  }
  return readEnumField<DefaultCompressionMode>(
    "defaultMode",
    DEFAULT_COMPRESSION_MODES,
    section,
    problems,
  );
}

/**
 * 把 `modules.compression` 节规范化成 CompressionSettings。
 *
 * 版本闸在前：schemaVersion 缺省按当前版本解释；不是正整数、或高于当前支持的版本时，
 * 整节视为无法安全解释，报告问题并全量回退默认（用户写入的规则不会被半解释）。
 * 版本可解释时逐字段校验：defaultMode / nativeTrigger / acpAutoDetect /
 * codexAutoDetect / acpAutoDetectThreshold / acpPreset / acpPresetVersion 非法各自
 * 报告并回退默认（旧版合法的 `defaultMode: "codex"` 走专属迁移提示，见
 * readDefaultCompressionMode），modelRules 逐条校验剔除坏条目，acp 高级配置逐字段校验（非法字段
 * 剔除，不阻断模型规则），
 * 单个字段写错不拖垮其余字段。
 */
export function readCompressionSettings(
  section: unknown,
): LoadedCompressionSettings {
  const problems: CompressionConfigProblem[] = [];
  if (section === undefined || section === null) {
    return { settings: { ...DEFAULT_COMPRESSION_SETTINGS, modelRules: [] }, problems };
  }
  if (!isRecord(section)) {
    // kit 的配置解析保证模块节是对象；这里兜住直接调用的非法形状
    return {
      settings: { ...DEFAULT_COMPRESSION_SETTINGS, modelRules: [] },
      problems: [
        { kind: "schemaVersionInvalid", field: "modules.compression", value: describeValue(section) },
      ],
    };
  }

  const rawVersion = section.schemaVersion;
  if (rawVersion !== undefined) {
    const versionExplainable =
      typeof rawVersion === "number" && Number.isInteger(rawVersion) && rawVersion >= 1;
    if (!versionExplainable) {
      problems.push({
        kind: "schemaVersionInvalid",
        field: "modules.compression.schemaVersion",
        value: describeValue(rawVersion),
      });
      return { settings: { ...DEFAULT_COMPRESSION_SETTINGS, modelRules: [] }, problems };
    }
    if (rawVersion > COMPRESSION_SCHEMA_VERSION) {
      problems.push({
        kind: "schemaVersionTooNew",
        field: "modules.compression.schemaVersion",
        value: describeValue(rawVersion),
        supported: COMPRESSION_SCHEMA_VERSION,
      });
      return { settings: { ...DEFAULT_COMPRESSION_SETTINGS, modelRules: [] }, problems };
    }
  }

  const defaultMode = readDefaultCompressionMode(section, problems);
  const nativeTrigger = readEnumField<NativeTriggerPolicy>(
    "nativeTrigger",
    NATIVE_TRIGGER_POLICIES,
    section,
    problems,
  );
  const acpAutoDetect = readBooleanField("acpAutoDetect", section, problems);
  const codexAutoDetect = readBooleanField("codexAutoDetect", section, problems);
  const acpAutoDetectThreshold = readPositiveIntField("acpAutoDetectThreshold", section, problems);
  const acpPreset = parseAcpPreset(section, problems);
  const acpPresetVersion = parseAcpPresetVersion(section, problems);
  const modelRules = parseModelRules(section.modelRules, problems);
  // 预设随解析结果带入运行时段（acp/config.ts 把推荐值作用在级联的 global 层）
  const acp: AcpAdvancedSettings = { ...parseAcpAdvanced(section.acp, problems), preset: acpPreset };

  return {
    settings: {
      schemaVersion: COMPRESSION_SCHEMA_VERSION,
      defaultMode,
      nativeTrigger,
      acpAutoDetect,
      codexAutoDetect,
      acpAutoDetectThreshold,
      modelRules,
      acpPreset,
      acpPresetVersion,
      acp,
    },
    problems,
  };
}

/** 规则 → 可落盘的 JSON 对象（undefined 的可选字段不写入，避免半空键） */
export function serializeModelRule(rule: CompressionModelRule): ModuleConfigRecord {
  const record: ModuleConfigRecord = { provider: rule.provider, model: rule.model, mode: rule.mode };
  if (rule.api !== undefined) record.api = rule.api;
  if (rule.baseUrl !== undefined) record.baseUrl = rule.baseUrl;
  if (rule.protocol !== undefined) record.protocol = rule.protocol;
  if (rule.profile !== undefined) record.profile = rule.profile;
  if (rule.onUnsupported !== undefined) record.onUnsupported = rule.onUnsupported;
  return record;
}

/**
 * 写盘补丁语义（工单 02 规则编辑器）：整组模型规则替换。写前用读取侧同一套
 * 校验过一遍（parseModelRules），有问题直接抛错不产生写盘——编辑器产出的规则
 * 来自已解析的配置与模型目录，这里是防御性闸门，保证写出去的补丁回读等价。
 */
export function modelRulesPatch(rules: readonly CompressionModelRule[]): ModuleConfigRecord {
  const serialized = rules.map(serializeModelRule);
  const problems: CompressionConfigProblem[] = [];
  const parsed = parseModelRules(serialized, problems);
  if (problems.length > 0) {
    const first = problems[0];
    throw new Error(`invalid compression model rule at ${first.field}: ${first.value}`);
  }
  return { modelRules: parsed.map(serializeModelRule) };
}
