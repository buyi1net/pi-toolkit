// 压缩模块装配定义（工单 01 骨架 + 工单 02 策略与规则 + 工单 03 统一调度器 + 工单 10 ACP 高级配置）：独立配置节 + 菜单入口 + 三语文案 + 压缩 owner 调度的模块。
//
// 模块边界：
// - api.ts：对其它模块开放的静态导出面（类型 / 常量 / 纯函数）；
// - config.ts：配置节（modules.compression，带独立 schemaVersion）的解析校验；
//   含工单 10 的 ACP 高级配置（modules.compression.acp）逐字段校验与级联合并；
// - strategy.ts：策略解析器（纯函数：会话覆盖 → 显式规则 → Codex 自动检测 → ACP 自动检测 → 默认策略）；
// - rules-editor.ts：模型规则编辑器（从模型目录选完整身份，kit 事务落盘）；
// - acp-editor.ts：ACP 高级设置编辑页（阈值/枚举/分组子页，kit 事务落盘）；
// - codex-settings-panel.ts：Codex 模式管理页（官方订阅分组 + 手动添加分组 + 添加模型）；
// - settings-panel.ts：二级设置页（工单 01：总开关 + 动态重建行集；工单 05：当前
//   会话覆盖与全局默认两值枚举；一级菜单只保留一行入口）；
// - session-override.ts：当前会话覆盖的内存单例（工单 05：不写盘，会话边界复位）；
// - status.ts：压缩状态服务（工单 04：`compression.status` 只读句柄、状态快照与标签）；
// - menu.ts：一级唯一入口行与设置页里的模型规则、ACP 高级设置、当前模型策略诊断行；
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
  COMPRESSION_MODULE_ID,
  DEFAULT_ACP_AUTO_DETECT_ENABLED,
} from "./api.ts";

import { buildCompressionTopItems } from "./menu.ts";
import { registerCompression } from "./mod.ts";
import { COMPRESSION_NATIVE_TRIGGER_FIELD } from "./settings-panel.ts";

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
  // 工单 03：ACP 推荐预设
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
  NativeTriggerPolicy,
  // 工单 03：ACP 推荐预设
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
  // 工单 03：ACP 推荐预设
  acpPresetPatch,
  parseAcpPreset,
  parseAcpPresetVersion,
  // 工单 07：旧配置平滑迁移（defaultMode: codex → native + 专属提示）
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
  COMPRESSION_DIAGNOSIS_ROW_ID,
  buildCompressionMenuItems,
  buildCompressionTopItems,
  // 工单 03：ACP 管理入口行
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
  // 工单 03：ACP 管理入口值位
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
  // 工单 03：ACP 预设文案
  acpPresetLabel,
  acpToggleLabel,
} from "./messages/index.ts";
export {
  COMPRESSION_SETTINGS_ROW_ID,
  CompressionSettingsPanel,
  ROW_ENABLED,
  buildCompressionSettingsRows,
} from "./settings-panel.ts";
// ── 工单 02：Codex 官方能力检测与管理向导 ──
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
// ── 工单 05：当前会话压缩覆盖与全局默认两值枚举 ──
export {
  DEFAULT_COMPRESSION_MODES,
  DEFAULT_SESSION_COMPRESSION_OVERRIDE,
  SESSION_COMPRESSION_OVERRIDES,
} from "./api.ts";
export type { DefaultCompressionMode, SessionCompressionOverride } from "./api.ts";
export { isSessionCompressionOverride, sessionCompressionOverride } from "./session-override.ts";
export {
  ROW_DEFAULT_MODE,
  ROW_NATIVE_TRIGGER,
  ROW_SESSION_OVERRIDE,
} from "./settings-panel.ts";
// ── 工单 06：降级记账与 fallback 清除总线 ──
export { createCompressionFallbackLedger } from "./fallback.ts";
export type { CompressionFallbackLedger } from "./fallback.ts";

/**
 * 配置 schema：菜单只放开关和有限枚举；schemaVersion、modelRules、acp（ACP
 * 高级配置树）、acpPreset / acpPresetVersion（工单 03 预设与指纹）与
 * acpAutoDetectThreshold 是模块私有结构化配置，由 config.ts 的解析器校验；
 * 预设、阈值与 acp 覆盖的编辑入口在 ACP 管理页（acp-editor.ts）。
 */
const COMPRESSION_CONFIG_SCHEMA: ModuleConfigSchema = {
  enabled: enabledField("module.compression.enabled.label", "module.compression.enabled.description"),
  // 工单 05：全局默认只剩两个通用兜底模式；工单 07 起它不再声明在 schema 里。
  // 理由：kit 的 resolveModuleConfig 会把不在 schema values 里的值直接丢成默认值，
  // 旧配置的 defaultMode: "codex" 一到 getConfig 就变成 native，解析层再也看不到旧值，
  // 专属迁移提示就永远发不出去（实测过：盘上 codex，getConfig 已归 native）。
  // 不声明后该键原值透传给本模块的解析器（readDefaultCompressionMode：两值枚举 +
  // 旧值迁移提示），菜单/设置页仍由 settings-panel.ts 的 COMPRESSION_DEFAULT_MODE_FIELD
  // 给出两值与文案。
  // nativeTrigger 没有遗留取值问题，继续按 schema 规范化。
  nativeTrigger: COMPRESSION_NATIVE_TRIGGER_FIELD,
  acpAutoDetect: {
    default: DEFAULT_ACP_AUTO_DETECT_ENABLED,
    labelKey: "module.compression.acpAutoDetect.label",
    descriptionKey: "module.compression.acpAutoDetect.description",
  },
  // 工单 02 起 Codex 自动检测不再有独立开关：官方链路模型在模块启用时自动接管，
  // 中转站与自定义模型走显式规则（Codex 模式管理页添加）。
};

export const compressionModule: ModuleDefinition = {
  id: COMPRESSION_MODULE_ID,
  labelKey: "module.compression.label",
  descriptionKey: "module.compression.description",
  group: "general",
  configSchema: COMPRESSION_CONFIG_SCHEMA,
  // 常驻装配（工单 01）：磁盘 enabled=false 也纳入装配，一级菜单照常露出入口，
  // 用户才能从设置页把模块重新打开；关闭时的运行期旁路由 mod.ts 按实时配置自行处理
  alwaysAssemble: true,
  // 一级行（工单 01）：唯一入口行 compression.settings，值位只显示开 / 关；
  // 全部配置项与诊断行收进它打开的设置页（settings-panel.ts）
  topLevel: buildCompressionTopItems,
  register(context: ModuleContext): void {
    registerCompression(context);
  },
};
