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
} from "./api.ts";

export interface LoadedCompressionSettings {
  readonly settings: CompressionSettings;
  readonly problems: readonly CompressionConfigProblem[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return String(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

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

export interface AcpOverrideLevel {
  readonly provider?: string;
  readonly model?: string;
}

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

export function parseAcpPercentUserInput(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === "" || !/^[+]?[\d.]+%?$/.test(trimmed)) return undefined;
  if (trimmed.endsWith("%")) return normalizeAcpPercentFileValue(trimmed);
  const numeric = Number(trimmed);
  if (!Number.isFinite(numeric)) return undefined;
  return normalizeAcpPercentFileValue(numeric > 1 ? `${numeric}%` : numeric);
}

export function formatAcpPercentFileValue(ratio: number): string {
  return `${Number((ratio * 100).toPrecision(6))}%`;
}

export function parseAcpPositiveIntUserInput(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^\+?\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function parseAcpCountUserInput(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : undefined;
}

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

export interface AcpEscalationIssue {
  readonly max: number;
  readonly emergency: number;
}

export function acpEscalationIssue(merged: AcpCompressOverrides): AcpEscalationIssue | undefined {
  if (merged.maxContextLimit === undefined || merged.emergencyThresholdPercent === undefined) return undefined;
  if (merged.emergencyThresholdPercent >= merged.maxContextLimit) return undefined;
  return { max: merged.maxContextLimit, emergency: merged.emergencyThresholdPercent };
}

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

export function countAcpOverrideFields(overrides: AcpCompressOverrides): number {
  let count = 0;
  for (const field of ACP_COMPRESS_FIELDS) {
    if (overrides[field] !== undefined) count += 1;
  }
  return count;
}

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

export function acpAutoDetectThresholdPatch(value: number): ModuleConfigRecord {
  return { acpAutoDetectThreshold: value };
}

export function parseAcpPreset(
  section: Record<string, unknown>,
  problems: CompressionConfigProblem[],
): AcpPreset {
  return readEnumField<AcpPreset>("acpPreset", ACP_PRESETS, section, problems);
}

export function parseAcpPresetVersion(
  section: Record<string, unknown>,
  problems: CompressionConfigProblem[],
): number {
  return readPositiveIntField("acpPresetVersion", section, problems);
}

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

export function acpPresetPatch(target: AcpPreset, draft: AcpCompressOverrides): ModuleConfigRecord {
  const stamp: ModuleConfigRecord = { acpPreset: target, acpPresetVersion: ACP_PRESET_VERSION };
  if (target === "recommended") return stamp;
  if (countAcpOverrideFields(draft) > 0) return stamp;
  return { ...stamp, acp: recommendedDraftRecord() };
}

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

export function readCompressionSettings(
  section: unknown,
): LoadedCompressionSettings {
  const problems: CompressionConfigProblem[] = [];
  if (section === undefined || section === null) {
    return { settings: { ...DEFAULT_COMPRESSION_SETTINGS, modelRules: [] }, problems };
  }
  if (!isRecord(section)) {

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
  const acpAutoDetect = readBooleanField("acpAutoDetect", section, problems);
  const acpAutoDetectThreshold = readPositiveIntField("acpAutoDetectThreshold", section, problems);
  const acpPreset = parseAcpPreset(section, problems);
  const acpPresetVersion = parseAcpPresetVersion(section, problems);
  const modelRules = parseModelRules(section.modelRules, problems);

  const acp: AcpAdvancedSettings = { ...parseAcpAdvanced(section.acp, problems), preset: acpPreset };

  return {
    settings: {
      schemaVersion: COMPRESSION_SCHEMA_VERSION,
      defaultMode,
      acpAutoDetect,
      acpAutoDetectThreshold,
      modelRules,
      acpPreset,
      acpPresetVersion,
      acp,
    },
    problems,
  };
}

export function serializeModelRule(rule: CompressionModelRule): ModuleConfigRecord {
  const record: ModuleConfigRecord = { provider: rule.provider, model: rule.model, mode: rule.mode };
  if (rule.api !== undefined) record.api = rule.api;
  if (rule.baseUrl !== undefined) record.baseUrl = rule.baseUrl;
  if (rule.protocol !== undefined) record.protocol = rule.protocol;
  if (rule.profile !== undefined) record.profile = rule.profile;
  if (rule.onUnsupported !== undefined) record.onUnsupported = rule.onUnsupported;
  return record;
}

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
