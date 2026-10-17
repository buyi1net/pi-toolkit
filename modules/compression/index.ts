// 压缩模块装配定义（工单 01 骨架 + 工单 02 策略与规则 + 工单 03 统一调度器 + 工单 10 ACP 高级配置）：独立配置节 + 菜单入口 + 三语文案 + 压缩 owner 调度的模块。
//
// 模块边界：
// - api.ts：对其它模块开放的静态导出面（类型 / 常量 / 纯函数）；
// - config.ts：配置节（modules.compression，带独立 schemaVersion）的解析校验；
//   含工单 10 的 ACP 高级配置（modules.compression.acp）逐字段校验与级联合并；
// - strategy.ts：策略解析器（纯函数：显式规则 → ACP 自动检测 → 默认策略）；
// - rules-editor.ts：模型规则编辑器（从模型目录选完整身份，kit 事务落盘）；
// - acp-editor.ts：ACP 高级设置编辑页（阈值/枚举/分组子页，kit 事务落盘）；
// - menu.ts：一级菜单的模型规则、ACP 高级设置与当前模型策略诊断行；
// - scheduler.ts：统一压缩调度器（session_before_compact 的唯一 owner 入口；
//   native 内建，codex/acp owner 经 owners 注入分发，含跨模式切换保护）；
// - acp/config.ts：ACP 高级配置的运行时消费接缝（级联合并 → 内核 Config/提示词/pack）；
// - acp/：ACP owner（engine/sidecar/owner/projection/compress-tool，工单 08/09）；
// - mod.ts：装配实现——配置问题呈现 + 注册调度器的压缩事件 handler；
// - messages/：本模块三语键表（自包含）；
// - UPSTREAM.md：上游来源与许可证登记（codex / acp 实现的引入依据）。
//
// 本单验收：统一调度器成为唯一压缩 owner、native 两种触发策略的事件矩阵符合
// Pi 1.3.0 契约、取消后不写错误 summary、native 模式零第三方上下文修改。

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
  COMPRESSION_MODES,
  COMPRESSION_MODULE_ID,
  DEFAULT_ACP_AUTO_DETECT_ENABLED,
  NATIVE_TRIGGER_POLICIES,
} from "./api.ts";
import { buildCompressionMenuItems } from "./menu.ts";
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
  NATIVE_TRIGGER_POLICIES,
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
  NativeTriggerPolicy,
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
  COMPRESSION_DIAGNOSIS_ROW_ID,
  COMPRESSION_ACP_ADVANCED_ROW_ID,
  buildCompressionMenuItems,
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
  acpAdvancedRowValue,
  acpModelCandidates,
  acpProviderCandidates,
  type AcpPanelApi,
  type AcpRowHandle,
  type AcpSettingsPanelOptions,
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
} from "./messages/index.ts";

/**
 * 配置 schema：菜单只放开关和有限枚举；schemaVersion、modelRules、acp（ACP
 * 高级配置树）与 acpAutoDetectThreshold 是模块私有结构化配置，由 config.ts 的
 * 解析器校验；阈值与 acp 覆盖的编辑入口在 ACP 高级设置页（acp-editor.ts）。
 */
const COMPRESSION_CONFIG_SCHEMA: ModuleConfigSchema = {
  enabled: enabledField("module.compression.enabled.label", "module.compression.enabled.description"),
  defaultMode: {
    default: "native",
    values: [...COMPRESSION_MODES],
    labelKey: "module.compression.defaultMode.label",
    descriptionKey: "module.compression.defaultMode.description",
    valueLabelKeys: {
      native: "module.compression.defaultMode.value.native",
      codex: "module.compression.defaultMode.value.codex",
      acp: "module.compression.defaultMode.value.acp",
    },
  },
  nativeTrigger: {
    default: "manual",
    values: [...NATIVE_TRIGGER_POLICIES],
    labelKey: "module.compression.nativeTrigger.label",
    descriptionKey: "module.compression.nativeTrigger.description",
    valueLabelKeys: {
      auto: "module.compression.nativeTrigger.value.auto",
      manual: "module.compression.nativeTrigger.value.manual",
    },
  },
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
  // 一级行：schema 自动行（启用状态 / 默认模式 / native 触发策略 / ACP 自动检测）
  // 之后追加模块专属行（模型规则编辑器入口 + 当前模型策略诊断）。
  menuItems: buildCompressionMenuItems,
  register(context: ModuleContext): void {
    registerCompression(context);
  },
};
