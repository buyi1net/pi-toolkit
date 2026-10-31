import {
  enabledField,
  type ModuleConfigSchema,
  type ModuleContext,
  type ModuleDefinition,
} from "../../kit/module.ts";
import {
  ACP_COMPRESS_FIELDS,
  ACP_PROMPT_OVERRIDE_KEYS,
  ACP_PROMPT_PACKS,
  COMPRESSION_MODULE_ID,
  DEFAULT_ACP_AUTO_DETECT_ENABLED,
} from "./api.ts";

import { buildCompressionTopItems } from "./menu.ts";
import { registerCompression } from "./mod.ts";

export {
  ACP_COMPRESS_FIELDS,
  ACP_PROMPT_OVERRIDE_KEYS,
  ACP_PROMPT_PACKS,
  CODEX_PROTOCOLS,
  CODEX_RULE_PROFILES,
  CODEX_UNSUPPORTED_POLICIES,
  COMPRESSION_MODES,
  COMPRESSION_MODULE_ID,
  COMPRESSION_SCHEMA_VERSION,
  DEFAULT_ACP_AUTO_DETECT_ENABLED,
  DEFAULT_ACP_CONTEXT_WINDOW_THRESHOLD,
  DEFAULT_CODEX_PROTOCOL,
  EMPTY_ACP_ADVANCED_SETTINGS,

  ACP_PRESETS,
  ACP_PRESET_VERSION,
  ACP_RECOMMENDED_CONFIG,
  DEFAULT_ACP_PRESET,
} from "./api.ts";
export type {
  AcpAdvancedSettings,
  AcpCompressField,
  AcpCompressOverrides,
  AcpPromptOverrideKey,
  AcpPromptPack,
  AcpProviderOverrides,
  CodexProtocol,
  CodexRuleProfile,
  CodexUnsupportedPolicy,
  CompressionConfigProblem,
  CompressionMode,
  CompressionModelRule,
  CompressionSettings,
  ModelIdentity,

  AcpPreset,
} from "./api.ts";
export {
  acpAutoDetectThresholdPatch,
  acpEscalationIssue,
  acpOverrideFieldPatch,
  countAcpOverrideFields,
  formatAcpPercentFileValue,
  mergeAcpCompressOverrides,
  modelRulesPatch,
  normalizeAcpPercentFileValue,
  parseAcpAdvanced,
  parseAcpCountUserInput,
  parseAcpPercentUserInput,
  parseAcpPositiveIntUserInput,
  readAcpOverridesAt,
  readCompressionSettings,
  serializeModelRule,
  type AcpEscalationIssue,
  type AcpOverrideLevel,
  type LoadedCompressionSettings,

  acpPresetPatch,
  parseAcpPreset,
  parseAcpPresetVersion,

  readDefaultCompressionMode,
} from "./config.ts";
export {
  ACP_FALLBACK_CONTEXT_LIMIT,
  acpKernelConfigFor,
  resolveAcpRuntimeConfig,
  type AcpResolvedRuntime,
  type AcpRuntimeIdentity,
} from "./acp/config.ts";
export {
  PRECISION_RANK,
  normalizeBaseUrlForCompare,
  normalizeCompressionToken,
  normalizeModelIdentity,
  readValidContextWindow,
  resolveCompressionStrategy,
  type CompressionConflictField,
  type CompressionFallbackReason,
  type CompressionMatchPrecision,
  type CompressionRuleConflict,
  type CompressionSource,
  type CompressionStrategyResolution,
  type MatchedRuleView,
  type NormalizedModelIdentity,
} from "./strategy.ts";
export { registerCompression } from "./mod.ts";
export {
  COMPRESSION_STATUS_KEY,
  createCompressionScheduler,
  decideCompactHandling,
  type CompactEventOutcome,
  type CompactEventReason,
  type CompactHandlerResult,
  type CompactOwnerModule,
  type CompactOwnerStatus,
  type CompactSchedulingDecision,
  type CompressionScheduler,
  type CompressionSchedulerOptions,
} from "./scheduler.ts";
export {
  COMPRESSION_RULES_ROW_ID,
  buildCompressionMenuItems,
  buildCompressionTopItems,

  ROW_ACP_MANAGEMENT,
} from "./menu.ts";
export {
  CompressionRulesPanel,
  buildRulesEditorRows,
  candidateIdentity,
  codexParamRowValue,
  discoverCompressionCandidates,
  modelIdentityFromModel,
  rulesCountValue,
  rulesEditorRowId,
  rulesEditorRowIds,
  ruleRowValue,
  sameRuleIdentity,
  saveModelRules,
  withRuleMode,
  withRuleOnUnsupported,
  withRuleProfile,
  type CodexRuleParam,
  type CompressionMenuRegistry,
  type CompressionModelCandidate,
  type CompressionRulesPanelOptions,
  type RulesEditorRow,
} from "./rules-editor.ts";
export {
  ACP_SETTINGS_ROW_IDS,
  AcpSettingsPanel,
  acpModelCandidates,
  acpProviderCandidates,
  type AcpPanelApi,
  type AcpRowHandle,
  type AcpSettingsPanelOptions,

  acpManagementRowValue,
} from "./acp-editor.ts";
export {
  COMPRESSION_MESSAGES,
  acpCountValue,
  acpFieldLabel,
  acpImagesValue,
  acpPercentValue,
  acpPromptPackLabel,
  acpPromptsValue,
  acpReasoningValue,
  acpToolsValue,
  codexProtocolLabel,
  compressionModeLabel,
  compressionRuleLabel,
  compressionSourceLabel,
  compressionFallbackLabel,
  compressionTableTranslator,
  displayBaseUrl,
  formatCompressionProblem,
  formatResolutionDiagnosis,
  resolutionDiagnosisLines,
  type CompressionMessageKey,
  type CompressionTranslate,

  acpPresetLabel,
  acpToggleLabel,
} from "./messages/index.ts";
export {
  COMPRESSION_SETTINGS_ROW_ID,
  CompressionSettingsPanel,
  ROW_ENABLED,
  buildCompressionSettingsRows,
} from "./settings-panel.ts";

export {
  OFFICIAL_CODEX_PATH_PREFIX,
  OFFICIAL_OPENAI_BASE_URL,
  detectCodexCapability,
  readModelCodexCapability,
  type CodexBaseUrlSource,
  type CodexCapability,
  type CodexCapabilityInput,
  type CodexCapabilityReason,
  type CodexCapabilityRegistry,
} from "./codex/capability.ts";
export {
  ROW_CODEX_ADD,
  ROW_CODEX_EMPTY,
  ROW_CODEX_MANAGEMENT,
  ROW_CODEX_OFFICIAL_HEADER,
  ROW_CODEX_MANUAL_HEADER,
  codexOfficialRowId,
  CodexManagementPanel,
  buildCodexManagementRow,
  buildCodexManagementRows,
  codexRuleFromCandidate,
  codexRuleRowId,
  codexRules,
  codexManagementValue,
  officialCodexModels,
  type CodexManagementPanelOptions,
  type CodexManagementRowsOptions,
} from "./codex-settings-panel.ts";

export { COMPRESSION_STATUS_SERVICE_NAME } from "./api.ts";
export type { CompressionStatus, CompressionStatusService, CompressionStatusSnapshot } from "./api.ts";
export { createCompressionStatusService, formatCompressionStatusLabel } from "./status.ts";
export type {
  CompressionFallbackRecord,
  CompressionStatusRuntime,
  CompressionStatusServiceOptions,
} from "./status.ts";

export {
  DEFAULT_COMPRESSION_MODES,
  DEFAULT_SESSION_COMPRESSION_OVERRIDE,
  SESSION_COMPRESSION_OVERRIDES,
} from "./api.ts";
export type { DefaultCompressionMode, SessionCompressionOverride } from "./api.ts";
export { isSessionCompressionOverride, sessionCompressionOverride } from "./session-override.ts";
export { ROW_DEFAULT_MODE, ROW_SESSION_OVERRIDE } from "./settings-panel.ts";

export { createCompressionFallbackLedger } from "./fallback.ts";
export type { CompressionFallbackLedger } from "./fallback.ts";

const COMPRESSION_CONFIG_SCHEMA: ModuleConfigSchema = {
  enabled: enabledField("module.compression.enabled.label", "module.compression.enabled.description"),

  acpAutoDetect: {
    default: DEFAULT_ACP_AUTO_DETECT_ENABLED,
    labelKey: "module.compression.acpAutoDetect.label",
    descriptionKey: "module.compression.acpAutoDetect.description",
  },

};

export const compressionModule: ModuleDefinition = {
  id: COMPRESSION_MODULE_ID,
  labelKey: "module.compression.label",
  descriptionKey: "module.compression.description",
  group: "general",
  configSchema: COMPRESSION_CONFIG_SCHEMA,

  alwaysAssemble: true,

  topLevel: buildCompressionTopItems,
  register(context: ModuleContext): void {
    registerCompression(context);
  },
};
