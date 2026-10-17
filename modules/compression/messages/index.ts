// 压缩模块三语键表（自包含：本模块的文案只在这里；模块目录拿走则这些文案一起消失）。
// 框架级键（command/menu/group/problem/language/common/hint/notify）在 i18n/messages.ts。
// 三语（en / zh-CN / zh-TW）必须同时补齐：ZH_CN / ZH_TW 以 typeof EN 断言，缺键/多键 typecheck 报错；
// 三语键集合相等与无未翻译值由 tests/pi-toolkit/i18n-messages.test.ts 兜底。

import { formatMessage } from "../../../i18n/index.ts";
import type { MessageTables, MessageVars, ResolvedLanguage, Translator } from "../../../i18n/index.ts";
import type {
  AcpCompressField,
  AcpPromptOverrideKey,
  AcpPromptPack,
  CodexProtocol,
  CompressionConfigProblem,
  CompressionMode,
  CompressionModelRule,
} from "../api.ts";
import type {
  CompressionFallbackReason,
  CompressionSource,
  CompressionStrategyResolution,
} from "../strategy.ts";

const EN = {
  "module.compression.label": "Context compression",
  "module.compression.description":
    "Own context compression policy for pi-toolkit: default mode, native trigger policy and Codex/ACP model rules",
  "module.compression.enabled.label": "Enable compression module",
  "module.compression.enabled.description":
    "When off, the module registers nothing and sessions keep Pi-native compaction (reload to apply)",

  "module.compression.defaultMode.label": "Default compression mode",
  "module.compression.defaultMode.description":
    "Mode used when no explicit model rule matches: as the default, acp takes over every unmatched model (auto-detected small-window models included), while codex is guarded by the whitelist — without an explicit rule it behaves like native with a notice",
  "module.compression.defaultMode.value.native": "Pi native",
  "module.compression.defaultMode.value.codex": "Codex",
  "module.compression.defaultMode.value.acp": "ACP",

  "module.compression.nativeTrigger.label": "Native trigger policy",
  "module.compression.nativeTrigger.description":
    "Applies to native mode: auto keeps Pi threshold compaction and overflow recovery, manual only reacts to /compact",
  "module.compression.nativeTrigger.value.auto": "Auto",
  "module.compression.nativeTrigger.value.manual": "Manual only",

  "module.compression.mode.native": "Pi native",
  "module.compression.mode.codex": "Codex",
  "module.compression.mode.acp": "ACP",

  "module.compression.acpAutoDetect.label": "ACP auto detection",
  "module.compression.acpAutoDetect.description":
    "When no explicit rule matches, models whose declared context window is at or below the threshold enter ACP automatically; missing metadata keeps the default policy",

  "module.compression.rules.label": "Model rules",
  "module.compression.rules.description":
    "Explicit provider/model rules picked from the model catalog; the most precise match wins",
  "module.compression.rules.value.none": "No rules",
  "module.compression.rules.value.configured": "{count} rule(s)",
  "module.compression.rules.add": "+ Add rule",
  "module.compression.rules.hint": "Enter edit · Ctrl+D delete · Esc back",
  "module.compression.rules.deleteArmed": "Enter again to delete",
  "module.compression.rules.duplicate": "Rule already exists: {rule}",
  "module.compression.rules.modeTitle": "Compression mode for {rule}",
  "module.compression.rules.protocolTitle": "Codex protocol for {rule}",
  "module.compression.rules.modelTitle": "Add rule: pick a model from the catalog",
  "module.compression.rules.profile.label": "Codex profile",
  "module.compression.rules.profile.unset": "Unset (derived from the model API)",
  "module.compression.rules.profile.codex-responses-v1": "codex-responses-v1 (Codex Responses shape)",
  "module.compression.rules.profile.openai-responses-v1": "openai-responses-v1 (plain OpenAI Responses shape)",
  "module.compression.rules.profileTitle": "Responses profile for {rule}",
  "module.compression.rules.onUnsupported.label": "Codex unsupported policy",
  "module.compression.rules.onUnsupported.unset": "Unset (defaults to native)",
  "module.compression.rules.onUnsupported.native": "native (fall back to Pi native)",
  "module.compression.rules.onUnsupported.error": "error (cancel and report)",
  "module.compression.rules.onUnsupportedTitle": "Unsupported policy for {rule}",
  "module.compression.rules.codexRemoteNote":
    "Codex remote compaction: preflight is a local capability check and sends no probe requests; request timeout and retries use module defaults (no config surface)",

  "module.compression.protocol.default": "Default (Remote V2)",
  "module.compression.protocol.remote-v2": "Remote V2",
  "module.compression.protocol.responses-compact": "responses/compact",
  "module.compression.protocol.context-management": "Context Management",

  "module.compression.diagnosis.label": "Current model policy",
  "module.compression.diagnosis.description": "Resolved compression strategy for the current session model",
  "module.compression.diagnosis.noModel": "No session model",
  "module.compression.diagnosis.title": "Compression policy diagnosis",

  "module.compression.diag.mode": "Mode: {value}",
  "module.compression.diag.source": "Source: {value}",
  "module.compression.diag.rule": "Matched rule: {value}",
  "module.compression.diag.contextWindow": "Context window: {value}",
  "module.compression.diag.contextWindowMissing": "Context window: unavailable",
  "module.compression.diag.protocol": "Protocol: {value}",
  "module.compression.diag.profile": "Profile: {value}",
  "module.compression.diag.fallback": "Fallback reason: {value}",
  "module.compression.diag.conflict":
    "Config conflict: rules {rules} matched at the same precision with different outcomes; fell back to the default policy",

  "module.compression.source.explicit": "explicit rule",
  "module.compression.source.acp-auto": "ACP auto detection",
  "module.compression.source.default": "default policy",

  "module.compression.fallback.conflict": "rule conflict",
  "module.compression.fallback.context-window-missing": "context window metadata missing or invalid",
  "module.compression.fallback.invalid-identity": "model identity invalid",

  "module.compression.reason.manual": "manual /compact",
  "module.compression.reason.threshold": "context threshold",
  "module.compression.reason.overflow": "context overflow recovery",

  "module.compression.schedule.cancelled":
    "Automatic compaction cancelled ({reason} trigger) by the manual-only policy: run /compact yourself or start a new session when needed — the policy is working, not a failure. Current policy: {diagnosis}",
  "module.compression.schedule.status": "Auto compaction off (manual-only): /compact or new session when needed",
  "module.compression.schedule.ownerUnimplemented":
    "Current model resolved to {mode} ({source}), but that compression owner is not implemented yet; this compaction continues with Pi native. See the compression diagnosis in the /pi-toolkit menu.",
  "module.compression.schedule.handlerError":
    "Compression scheduler error ({error}); this compaction falls back to Pi native",

  "module.compression.acp.takeover":
    "ACP owns this session's compression ({reason} trigger cancelled): context is projected by ACP and compression runs via the compress tool — Pi native summary is not used",
  "module.compression.acp.status": "ACP compression active: context projected by ACP (compress tool)",
  "module.compression.acp.hostUnsupported":
    "ACP cannot project context on this host (missing session entry seam, {reason} trigger); no ACP state exists yet, so this compaction falls back to Pi native",
  "module.compression.acp.hostUnsupportedWithState":
    "ACP cannot project context on this host but this session still has ACP state ({reason} trigger); compaction cancelled and the state is kept — resume on a supported host or start a new session",
  "module.compression.acp.compactUnavailable":
    "ACP state is unavailable (sidecar version incompatible or rebuild failed, {reason} trigger); compaction cancelled and nothing was faked — check the compression diagnosis or fix/remove the sidecar",
  "module.compression.acp.sidecarNewer":
    "ACP sidecar schema version {version} is newer than supported; the file is left untouched and ACP state is unavailable — upgrade pi-toolkit or remove the sidecar",
  "module.compression.acp.sidecarCorrupt":
    "ACP sidecar is corrupt ({error}); state will be rebuilt from the session log when possible",
  "module.compression.acp.sidecarMismatch":
    "ACP sidecar does not match this session's log ({missing} block message id(s) unknown here — copied or rewound sidecar); state was rebuilt from the session log",
  "module.compression.acp.sidecarRebuilt":
    "ACP sidecar was missing or corrupt; {blocks} block(s) rebuilt from the session log",
  "module.compression.acp.sidecarRebuildFailed":
    "ACP sidecar rebuild failed: the session log has compress history but nothing could be replayed; ACP state is unavailable",
  "module.compression.acp.sidecarRebuildFailedWith":
    "ACP sidecar rebuild failed ({error}); ACP state is unavailable",
  "module.compression.acp.saveFailed":
    "ACP sidecar write failed ({error}); in-memory state is kept and retried on the next save — no other compaction was started",
  "module.compression.acp.projectionUnavailable":
    "ACP context projection is unavailable (state failed to load); this request is sent unprojected — fix the sidecar issue before compressing",
  "module.compression.acp.projectionFailed":
    "ACP context projection failed ({error}); ACP state is kept and this request is sent unprojected — retry the request or check the diagnosis",
  "module.compression.acp.stateUnavailable":
    "ACP state could not be loaded for this session, so compress/decompress are unavailable (see the compression diagnosis)",
  "module.compression.acp.toolNotActive":
    "compress skipped: the current model is not under the ACP compression policy (no rule matched and auto detection is off)",
  "module.compression.codex.notWhitelisted":
    "Current model resolved to codex mode without an explicit whitelist rule; codex compaction only applies to explicit provider/model rules, so this session keeps the existing policy (Pi native)",
  "module.compression.codex.resolve.noModel": "Codex compaction needs an active session model",
  "module.compression.codex.status.running": "Codex remote compaction ({protocol})…",

  "module.compression.codex.unsupported.apiNotResponses":
    "Codex compaction unavailable before any request: model API {api} is not a Responses shape (known non-Responses API)",
  "module.compression.codex.unsupported.profileConflict":
    "Codex compaction unavailable: the rule profile conflicts with the profile derived from API {api}; remove the rule profile or fix the API",
  "module.compression.codex.unsupported.protocolUnavailable":
    "Codex compaction unavailable in this build: the {protocol} protocol adapter is not registered",

  "module.compression.codex.outcome.fellBackNative":
    "— this compaction falls back to Pi native (onUnsupported=native)",
  "module.compression.codex.outcome.cancelledError":
    "— compaction cancelled (onUnsupported=error); fix the configuration or switch the rule policy to native",

  "module.compression.codex.checkpoint.claimProtected":
    "History preserved: an opaque checkpoint is already committed on this branch, so this compaction is cancelled instead of double-compacting. Use /tree to branch before the checkpoint, switch back to the original model, or start a new session.",
  "module.compression.codex.checkpoint.invalid":
    "The active opaque checkpoint cannot be parsed (invalid or newer format); history preserved",
  "module.compression.codex.checkpoint.incompatible":
    "The active opaque checkpoint belongs to a different identity (mismatched: {fields}); it cannot replay on the current model",
  "module.compression.codex.checkpoint.unverifiable":
    "The saved transcript cannot verify the previous opaque checkpoint projection; history preserved",
  "module.compression.codex.checkpoint.projectionFailed":
    "Checkpoint projection failed for this request: the opaque history is not injected and the fallback summary text is used instead; the checkpoint is preserved. Use /tree to branch before the checkpoint or switch back to the original model.",

  "module.compression.codex.prepare.providerUnavailable": "The active Responses provider is unavailable",
  "module.compression.codex.prepare.emptyReplacement": "The remote response produced an empty replacement history",
  "module.compression.codex.prepare.failed": "Codex remote compaction failed ({error})",
  "module.compression.codex.contextManagement.invalid":
    "Context Management returned an incomplete or invalid checkpoint history ({error}); history is preserved and compaction is cancelled",
  "module.compression.codex.contextManagement.cancelled":
    "Context Management compaction was cancelled before publication; existing history is preserved",
  "module.compression.codex.commit.failed":
    "Codex checkpoint commit failed ({error}); no compaction result was returned, the session log is preserved and this compaction is cancelled",
  "module.compression.codex.rewrite.failed":
    "Checkpoint marker rewrite failed ({error}); the request continues with the fallback marker text and the checkpoint is preserved",
  "module.compression.codex.routePaused":
    "Codex remote compaction did not dispatch: this route is paused for the session after an earlier OAuth operation rejection; reload pi or fix the OAuth authorization, then compact again",
  "module.compression.codex.oauthRejected":
    "Codex remote compaction was rejected by the provider OAuth boundary ({error}); the route is paused for this session and compatible checkpoint replay stays available",

  "module.compression.config.schemaVersionInvalid":
    "Compression config problem: {field} is not an explainable version ({value}); the whole section fell back to defaults",
  "module.compression.config.schemaVersionTooNew":
    "Compression config problem: {field} is {value}, newer than supported {supported}; the whole section fell back to defaults",
  "module.compression.config.badEnum":
    "Compression config problem: {field} value {value} is not one of {allowed}; fell back to {fallback}",
  "module.compression.config.badBoolean":
    "Compression config problem: {field} value {value} is not a boolean; fell back to {fallback}",
  "module.compression.config.badNumber":
    "Compression config problem: {field} value {value} is not a positive integer; fell back to {fallback}",
  "module.compression.config.badString":
    "Compression config problem: {field} value {value} is not a string; the field was dropped",
  "module.compression.config.rulesInvalid":
    "Compression config problem: {field} is not an array of rules ({value}); model rules were ignored",
  "module.compression.config.ruleInvalid":
    "Compression config problem: {field} is not a rule object ({value}); the entry was skipped",
  "module.compression.config.ruleMissingIdentity":
    "Compression config problem: {field} has no usable provider/model identity ({value}); the rule was skipped",

  // ── ACP 高级设置（工单 10）：入口行、设置页、字段与诊断 ──
  "module.compression.acpAdvanced.label": "ACP advanced settings",
  "module.compression.acpAdvanced.description":
    "ACP compression parameters merged per field across global → provider → model, plus the auto-detection threshold",
  "module.compression.acpAdvanced.value.defaults": "Defaults",
  "module.compression.acpAdvanced.value.custom": "global {global} · {providers} provider(s)",

  "module.compression.acpSettings.title": "ACP advanced settings",
  "module.compression.acpSettings.hint": "Enter edit · Ctrl+D clear · Esc back",
  "module.compression.acpSettings.threshold.label": "Auto-detection threshold (tokens)",
  "module.compression.acpSettings.global.label": "Global compression parameters",
  "module.compression.acpSettings.global.value.none": "No overrides",
  "module.compression.acpSettings.global.value.set": "{count} field(s) set",
  "module.compression.acpSettings.providers.label": "Provider & model overrides",
  "module.compression.acpSettings.providers.value.none": "None",
  "module.compression.acpSettings.providers.value.set": "{count} provider(s)",
  "module.compression.acpSettings.providerTitle": "Pick a provider to override",
  "module.compression.acpSettings.modelTitle": "Pick a model ({provider})",
  "module.compression.acpSettings.levelHint": "Unset fields inherit the upper level · Enter edit · Ctrl+D clear · Esc back",
  "module.compression.acpSettings.inherit": "inherit",
  "module.compression.acpSettings.on": "on",
  "module.compression.acpSettings.off": "off",

  "module.compression.acpSettings.field.maxContextLimit.label": "Max context threshold",
  "module.compression.acpSettings.field.emergencyThresholdPercent.label": "Emergency truncation threshold",
  "module.compression.acpSettings.field.nudgeGrowthTokens.label": "Nudge growth step (tokens)",
  "module.compression.acpSettings.field.preserveRecentMessages.label": "Recent messages kept (count)",
  "module.compression.acpSettings.field.protectedTools.label": "Protected tools",
  "module.compression.acpSettings.field.promptPack.label": "Prompt pack",
  "module.compression.acpSettings.field.prompts.label": "Prompt overrides",
  "module.compression.acpSettings.field.reasoning.label": "Reasoning handling",
  "module.compression.acpSettings.field.stripImages.label": "Image handling",
  "module.compression.acpSettings.field.models.label": "Model overrides",
  "module.compression.acpSettings.field.models.value": "{count} model(s)",

  "module.compression.acpSettings.promptPack.full": "Full (default)",
  "module.compression.acpSettings.promptPack.lean": "Lean",

  "module.compression.acpSettings.prompts.title": "Prompt overrides",
  "module.compression.acpSettings.prompts.compressPhilosophy": "Compression philosophy (compressPhilosophy)",
  "module.compression.acpSettings.prompts.howToCompressRules": "How-to-compress rules (howToCompressRules)",
  "module.compression.acpSettings.prompts.tier2DistillRules": "Tier-2 distill rules (tier2DistillRules)",
  "module.compression.acpSettings.prompts.tier3CondenseRules": "Tier-3 condense rules (tier3CondenseRules)",
  "module.compression.acpSettings.prompts.set": "{count} overridden",

  "module.compression.acpSettings.reasoning.title": "Reasoning handling",
  "module.compression.acpSettings.reasoning.drop": "Drop oversized thinking",
  "module.compression.acpSettings.reasoning.threshold": "Threshold (chars)",

  "module.compression.acpSettings.images.title": "Image handling",
  "module.compression.acpSettings.images.strip": "Strip historical images",

  "module.compression.acpSettings.tools.title": "Protected tools",
  "module.compression.acpSettings.tools.add": "+ Add tool",
  "module.compression.acpSettings.tools.hint": "Enter add/edit · Ctrl+D remove · Esc back",

  "module.compression.acpSettings.input.title": "Edit {field}",
  "module.compression.acpSettings.input.hint": "Enter save · Esc cancel",
  "module.compression.acpSettings.input.invalid": "Invalid value: {reason}",
  "module.compression.acpSettings.input.invalidPercent": "expected a ratio like 0.75 or a percent like 75%",
  "module.compression.acpSettings.input.invalidPositiveInt": "expected a positive integer",
  "module.compression.acpSettings.input.invalidCount": "expected a non-negative integer",
  "module.compression.acpSettings.input.invalidTool": "expected a non-empty tool name",
  "module.compression.acpSettings.pickTitle": "Pick {field}",

  "module.compression.acpSettings.escalation":
    "ACP config problem: emergency threshold {emergency} is below max context threshold {max}; both fell back to kernel defaults (75% / 95%)",

  "module.compression.config.acpSectionInvalid":
    "Compression config problem: {field} is not an object ({value}); ACP advanced settings were ignored",
  "module.compression.config.acpProvidersInvalid":
    "Compression config problem: {field} is not a provider map ({value}); provider overrides were ignored",
  "module.compression.config.acpProviderInvalid":
    "Compression config problem: {field} is not an override object ({value}); the provider's overrides were skipped",
  "module.compression.config.acpModelsInvalid":
    "Compression config problem: {field} is not a model map ({value}); model overrides were ignored",
  "module.compression.config.acpModelInvalid":
    "Compression config problem: {field} is not an override object ({value}); the model's overrides were skipped",
  "module.compression.config.badPercent":
    "Compression config problem: {field} value {value} is not a ratio in (0,1] or a percent string like 75%; the field was dropped",
  "module.compression.config.badCount":
    "Compression config problem: {field} value {value} is not a non-negative integer; the field was dropped",
  "module.compression.config.badPositiveInt":
    "Compression config problem: {field} value {value} is not a positive integer; the field was dropped",
  "module.compression.config.badArray":
    "Compression config problem: {field} value {value} is not an array of strings; the field was dropped",

  // ── 跨模式生命周期与切换保护（工单 11）：独立分组的运行期诊断键 ──
  "module.compression.lifecycle.sessionStart":
    "Context compression is active for this session: {diagnosis}",
  "module.compression.lifecycle.reparsed":
    "The session model changed; the compression strategy was re-resolved: {previous} → {diagnosis}",
  "module.compression.lifecycle.protected":
    "Cancelled this {reason} compaction to protect session history: {states} cannot be safely replayed under the current {mode} strategy. Switch back to the original model to keep using it, or start a new session",
  "module.compression.lifecycle.protectedStatus":
    "Compaction cancelled: private state protected (switch back to the original model or start a new session)",
  "module.compression.lifecycle.state.codexClaim": "a Codex checkpoint from {identity}",
  "module.compression.lifecycle.state.codexClaimUnparsed": "an unparseable Codex checkpoint claim",
  "module.compression.lifecycle.state.acpSidecar": "an ACP sidecar holding {blocks} compression block(s)",
  "module.compression.lifecycle.state.foreignClaim": "an external compression extension checkpoint from {identity}",
  "module.compression.lifecycle.foreignProtected":
    "Cancelled this {reason} compaction: the newest compaction state ({identity}) was written by an external compression extension. The built-in module neither replays nor overwrites that opaque history; disable or migrate that extension first, or start a new session",

  "module.compression.codex.recovery.status": "Recovering the Codex checkpoint into a plaintext summary…",
  "module.compression.codex.recovery.succeeded":
    "Codex remote compaction failed; the active checkpoint was recovered into a lossy plaintext continuation summary. The opaque history is superseded — retry /compact to create a fresh checkpoint",
  "module.compression.codex.recovery.failed":
    "Checkpoint recovery could not complete ({error}); history preserved and this compaction is cancelled — retry /compact or start a new session",

  "module.compression.acp.sidecarConfigGeneration":
    "ACP settings changed after this sidecar was written: existing blocks and references stay valid; new thresholds and prompts apply from now on (no rebuild)",
  "module.compression.acp.foreignClaim":
    "This session carries a Codex checkpoint from {identity}: under ACP it only appears as its plaintext fallback text and the opaque history will not be replayed. Switch back to that model for full replay, or start a new session",
  "module.compression.acp.foreignClaimUnparsed": "an unparseable source",
  "module.compression.acp.foreignExtensionClaim":
    "This session carries a checkpoint written by an external compression extension: under ACP its opaque history will not be replayed. Disable or migrate that extension first, or start a new session",
} satisfies Record<string, string>;

const ZH_CN: typeof EN = {
  "module.compression.label": "上下文压缩",
  "module.compression.description":
    "pi-toolkit 自己的上下文压缩策略：默认模式、native 触发策略与 Codex/ACP 模型规则",
  "module.compression.enabled.label": "启用上下文压缩模块",
  "module.compression.enabled.description":
    "关闭后模块不注册任何内容，会话继续使用 Pi 原生压缩（重载 pi 后生效）",

  "module.compression.defaultMode.label": "默认压缩模式",
  "module.compression.defaultMode.description":
    "未命中显式模型规则时使用的模式：acp 作为默认模式会接管全部未命中模型（含 200k 自动检测语义）；codex 作为默认模式受白名单防线约束，无显式规则时等价 native 仅提示",
  "module.compression.defaultMode.value.native": "Pi 原生",
  "module.compression.defaultMode.value.codex": "Codex",
  "module.compression.defaultMode.value.acp": "ACP",

  "module.compression.nativeTrigger.label": "native 触发策略",
  "module.compression.nativeTrigger.description":
    "作用于 native 模式：auto 保留 Pi 的阈值压缩与溢出恢复，manual 只响应手动 /compact",
  "module.compression.nativeTrigger.value.auto": "自动",
  "module.compression.nativeTrigger.value.manual": "仅手动",

  "module.compression.mode.native": "Pi 原生",
  "module.compression.mode.codex": "Codex",
  "module.compression.mode.acp": "ACP",

  "module.compression.acpAutoDetect.label": "ACP 自动检测",
  "module.compression.acpAutoDetect.description":
    "未命中显式规则时，模型目录声明的上下文窗口不大于阈值的模型自动进入 ACP；元数据缺失时保持默认策略",

  "module.compression.rules.label": "模型规则",
  "module.compression.rules.description":
    "从模型目录挑选完整 provider/model 身份的显式规则；多条命中时精度最高者生效",
  "module.compression.rules.value.none": "无规则",
  "module.compression.rules.value.configured": "{count} 条规则",
  "module.compression.rules.add": "＋ 添加规则",
  "module.compression.rules.hint": "回车 编辑 · Ctrl+D 删除 · Esc 返回",
  "module.compression.rules.deleteArmed": "再按回车确认删除",
  "module.compression.rules.duplicate": "规则已存在：{rule}",
  "module.compression.rules.modeTitle": "选择 {rule} 的压缩模式",
  "module.compression.rules.protocolTitle": "选择 {rule} 的 Codex 协议",
  "module.compression.rules.modelTitle": "添加规则：从模型目录选择模型",
  "module.compression.rules.profile.label": "Codex profile",
  "module.compression.rules.profile.unset": "未指定（按模型 API 推导）",
  "module.compression.rules.profile.codex-responses-v1": "codex-responses-v1（Codex Responses 字段形状）",
  "module.compression.rules.profile.openai-responses-v1": "openai-responses-v1（普通 OpenAI Responses 字段形状）",
  "module.compression.rules.profileTitle": "选择 {rule} 的 Responses profile",
  "module.compression.rules.onUnsupported.label": "Codex 不支持时策略",
  "module.compression.rules.onUnsupported.unset": "未指定（默认 native）",
  "module.compression.rules.onUnsupported.native": "native（回退 Pi 原生）",
  "module.compression.rules.onUnsupported.error": "error（取消并报错）",
  "module.compression.rules.onUnsupportedTitle": "选择 {rule} 的不支持时策略",
  "module.compression.rules.codexRemoteNote":
    "Codex 远程压缩：preflight 只做本地能力判定、不发探测请求；请求超时与重试为模块默认（无配置面）",

  "module.compression.protocol.default": "默认（Remote V2）",
  "module.compression.protocol.remote-v2": "Remote V2",
  "module.compression.protocol.responses-compact": "responses/compact",
  "module.compression.protocol.context-management": "Context Management",

  "module.compression.diagnosis.label": "当前模型压缩策略",
  "module.compression.diagnosis.description": "当前会话模型解析出的压缩策略与诊断",
  "module.compression.diagnosis.noModel": "暂无会话模型",
  "module.compression.diagnosis.title": "压缩策略诊断",

  "module.compression.diag.mode": "模式：{value}",
  "module.compression.diag.source": "来源：{value}",
  "module.compression.diag.rule": "命中规则：{value}",
  "module.compression.diag.contextWindow": "上下文窗口：{value}",
  "module.compression.diag.contextWindowMissing": "上下文窗口：不可用",
  "module.compression.diag.protocol": "协议：{value}",
  "module.compression.diag.profile": "Profile：{value}",
  "module.compression.diag.fallback": "回退原因：{value}",
  "module.compression.diag.conflict": "配置冲突：规则 {rules} 在同一精度命中且结果不一致，已回退默认策略",

  "module.compression.source.explicit": "显式规则",
  "module.compression.source.acp-auto": "ACP 自动检测",
  "module.compression.source.default": "默认策略",

  "module.compression.fallback.conflict": "规则冲突",
  "module.compression.fallback.context-window-missing": "上下文窗口元数据缺失或无效",
  "module.compression.fallback.invalid-identity": "模型身份无效",

  "module.compression.reason.manual": "手动 /compact",
  "module.compression.reason.threshold": "上下文阈值",
  "module.compression.reason.overflow": "上下文溢出恢复",

  "module.compression.schedule.cancelled":
    "已按「仅手动」策略取消本次自动压缩（{reason} 触发）：需要时请手动执行 /compact 或新建会话——这是策略生效，不是故障。当前策略：{diagnosis}",
  "module.compression.schedule.status": "自动压缩已按「仅手动」取消：需要时手动 /compact 或新建会话",
  "module.compression.schedule.ownerUnimplemented":
    "当前模型解析为 {mode} 模式（{source}），但该压缩 owner 尚未实现：本次压缩继续使用 Pi 原生实现。策略诊断见 /pi-toolkit 菜单。",
  "module.compression.schedule.handlerError":
    "压缩调度器处理事件出错（{error}）：本次已交回 Pi 原生压缩",

  "module.compression.acp.takeover":
    "ACP 已接管本会话压缩（{reason} 触发已取消）：上下文由 ACP 投影，压缩经 compress 工具执行，不使用 Pi 原生摘要",
  "module.compression.acp.status": "ACP 压缩已接管：上下文由 ACP 投影（compress 工具）",
  "module.compression.acp.hostUnsupported":
    "宿主缺少会话 entry 接缝，ACP 无法投影上下文（{reason} 触发）；本会话尚无 ACP 状态，本次压缩交回 Pi 原生",
  "module.compression.acp.hostUnsupportedWithState":
    "宿主缺少会话 entry 接缝但本会话仍有 ACP 状态（{reason} 触发）：已取消压缩并保留状态——请回到受支持的宿主或新建会话",
  "module.compression.acp.compactUnavailable":
    "ACP 状态不可用（sidecar 版本不兼容或重建失败，{reason} 触发）：已取消压缩且不伪装成功——请查看压缩诊断或修复/删除 sidecar",
  "module.compression.acp.sidecarNewer":
    "ACP sidecar 的结构版本 {version} 高于当前支持：文件未被改动，ACP 状态不可用——请升级 pi-toolkit 或删除该 sidecar",
  "module.compression.acp.sidecarCorrupt":
    "ACP sidecar 已损坏（{error}）：将尝试从会话日志重建状态",
  "module.compression.acp.sidecarMismatch":
    "ACP sidecar 与本会话日志不一致（{missing} 个块内消息 id 在日志中不存在，疑似拷贝或回退的 sidecar）：已按会话日志重建状态",
  "module.compression.acp.sidecarRebuilt":
    "ACP sidecar 缺失或损坏：已从会话日志重建 {blocks} 个压缩块",
  "module.compression.acp.sidecarRebuildFailed":
    "ACP sidecar 重建失败：会话日志里有压缩历史但无法重放任何块，ACP 状态不可用",
  "module.compression.acp.sidecarRebuildFailedWith":
    "ACP sidecar 重建失败（{error}）：ACP 状态不可用",
  "module.compression.acp.saveFailed":
    "ACP sidecar 写入失败（{error}）：内存状态保留并在下次保存重试，未启动其它压缩",
  "module.compression.acp.projectionUnavailable":
    "ACP 上下文投影不可用（状态装载失败）：本次请求按原样发送——请先修复 sidecar 问题再压缩",
  "module.compression.acp.projectionFailed":
    "ACP 上下文投影失败（{error}）：已保留 ACP 状态，本次请求按原样发送——可重试请求或查看诊断",
  "module.compression.acp.stateUnavailable":
    "compress/decompress 不可用：本会话的 ACP 状态装载失败（见压缩诊断）",
  "module.compression.acp.toolNotActive":
    "compress 已跳过：当前模型不在 ACP 压缩策略下（未命中规则且自动检测关闭）",
  "module.compression.codex.notWhitelisted":
    "当前模型解析为 codex 模式但没有命中显式白名单规则：codex 压缩只对显式 provider/model 规则生效，本会话继续沿用既有策略（Pi 原生）",
  "module.compression.codex.resolve.noModel": "Codex 压缩需要会话中存在活动模型",
  "module.compression.codex.status.running": "Codex 远程压缩中（{protocol}）…",

  "module.compression.codex.unsupported.apiNotResponses":
    "Codex 压缩不可用（发请求前已判定）：模型 API {api} 不是 Responses 形状（已知非 Responses API）",
  "module.compression.codex.unsupported.profileConflict":
    "Codex 压缩不可用：规则声明的 profile 与 API {api} 推导的 profile 冲突；请删除规则里的 profile 声明或修正 API",
  "module.compression.codex.unsupported.protocolUnavailable":
    "Codex 压缩在本构建中不可用：{protocol} 协议适配器未接入",

  "module.compression.codex.outcome.fellBackNative":
    "——本次压缩回退 Pi 原生（onUnsupported=native）",
  "module.compression.codex.outcome.cancelledError":
    "——本次压缩已取消（onUnsupported=error）；请修复配置或将规则策略改为 native",

  "module.compression.codex.checkpoint.claimProtected":
    "历史已保留：当前分支上已提交 opaque checkpoint，本次压缩取消而不是二次压缩。可用 /tree 在压缩点前分支、换回原模型或新建会话。",
  "module.compression.codex.checkpoint.invalid":
    "活动 opaque checkpoint 无法解析（非法或更新格式）；历史已保留",
  "module.compression.codex.checkpoint.incompatible":
    "活动 opaque checkpoint 属于另一身份（不一致字段：{fields}）；无法在当前模型上回放",
  "module.compression.codex.checkpoint.unverifiable":
    "保存的会话日志无法验证上一个 opaque checkpoint 的投影；历史已保留",
  "module.compression.codex.checkpoint.projectionFailed":
    "本次请求的 checkpoint 投影失败：未注入 opaque 历史，改用 fallback 摘要文案继续，checkpoint 保留。可用 /tree 在压缩点前分支或换回原模型。",

  "module.compression.codex.prepare.providerUnavailable": "活动的 Responses provider 不可用",
  "module.compression.codex.prepare.emptyReplacement": "远端响应产出了空的 replacement history",
  "module.compression.codex.prepare.failed": "Codex 远程压缩失败（{error}）",
  "module.compression.codex.contextManagement.invalid":
    "Context Management 返回的 checkpoint 历史不完整或非法（{error}）；历史已保留，本次压缩取消",
  "module.compression.codex.contextManagement.cancelled":
    "Context Management 压缩在发布前取消；现有历史已保留",
  "module.compression.codex.commit.failed":
    "Codex checkpoint 提交失败（{error}）：未返回压缩结果，会话日志完整保留，本次压缩取消",
  "module.compression.codex.rewrite.failed":
    "checkpoint marker 改写失败（{error}）：请求继续使用 fallback marker 文本，checkpoint 保留",
  "module.compression.codex.routePaused":
    "Codex 远程压缩未发起请求：该路由在本会话中因更早的 OAuth 操作拒绝被暂停；重载 pi 或修复 OAuth 授权后再压缩即可重试",
  "module.compression.codex.oauthRejected":
    "Codex 远程压缩被 provider 的 OAuth 边界拒绝（{error}）；该路由本会话内已暂停，兼容的 checkpoint 回放仍然可用",

  "module.compression.config.schemaVersionInvalid":
    "压缩配置问题：{field} 不是可解释的版本号（{value}），本节已整体回退默认配置",
  "module.compression.config.schemaVersionTooNew":
    "压缩配置问题：{field} 为 {value}，高于当前支持的 {supported}，本节已整体回退默认配置",
  "module.compression.config.badEnum":
    "压缩配置问题：{field} 的取值 {value} 不在 {allowed} 内，已回退为 {fallback}",
  "module.compression.config.badBoolean":
    "压缩配置问题：{field} 的取值 {value} 不是布尔值，已回退为 {fallback}",
  "module.compression.config.badNumber":
    "压缩配置问题：{field} 的取值 {value} 不是正整数，已回退为 {fallback}",
  "module.compression.config.badString":
    "压缩配置问题：{field} 的取值 {value} 不是字符串，该字段已剔除",
  "module.compression.config.rulesInvalid":
    "压缩配置问题：{field} 不是规则数组（{value}），模型规则已忽略",
  "module.compression.config.ruleInvalid":
    "压缩配置问题：{field} 不是规则对象（{value}），该条已跳过",
  "module.compression.config.ruleMissingIdentity":
    "压缩配置问题：{field} 没有可用的 provider/model 身份（{value}），该规则已跳过",

  // ── ACP 高级设置（工单 10）：入口行、设置页、字段与诊断 ──
  "module.compression.acpAdvanced.label": "ACP 高级设置",
  "module.compression.acpAdvanced.description":
    "按 global → provider → model 逐字段合并的 ACP 压缩参数，含自动分流阈值",
  "module.compression.acpAdvanced.value.defaults": "默认参数",
  "module.compression.acpAdvanced.value.custom": "全局 {global} 项 · {providers} 家供应商",

  "module.compression.acpSettings.title": "ACP 高级设置",
  "module.compression.acpSettings.hint": "回车 编辑 · Ctrl+D 清除 · Esc 返回",
  "module.compression.acpSettings.threshold.label": "自动分流阈值（tokens）",
  "module.compression.acpSettings.global.label": "全局压缩参数",
  "module.compression.acpSettings.global.value.none": "未覆盖",
  "module.compression.acpSettings.global.value.set": "已设置 {count} 项",
  "module.compression.acpSettings.providers.label": "供应商与模型覆盖",
  "module.compression.acpSettings.providers.value.none": "无",
  "module.compression.acpSettings.providers.value.set": "{count} 家供应商",
  "module.compression.acpSettings.providerTitle": "选择要覆盖的供应商",
  "module.compression.acpSettings.modelTitle": "选择模型（{provider}）",
  "module.compression.acpSettings.levelHint": "未设置的字段继承上一级 · 回车 编辑 · Ctrl+D 清除 · Esc 返回",
  "module.compression.acpSettings.inherit": "继承",
  "module.compression.acpSettings.on": "开",
  "module.compression.acpSettings.off": "关",

  "module.compression.acpSettings.field.maxContextLimit.label": "最大上下文阈值",
  "module.compression.acpSettings.field.emergencyThresholdPercent.label": "紧急截断阈值",
  "module.compression.acpSettings.field.nudgeGrowthTokens.label": "nudge 增长步长（tokens）",
  "module.compression.acpSettings.field.preserveRecentMessages.label": "近期消息保留（条）",
  "module.compression.acpSettings.field.protectedTools.label": "工具保护名单",
  "module.compression.acpSettings.field.promptPack.label": "Prompt pack",
  "module.compression.acpSettings.field.prompts.label": "提示词覆写",
  "module.compression.acpSettings.field.reasoning.label": "Reasoning 处理",
  "module.compression.acpSettings.field.stripImages.label": "图片处理",
  "module.compression.acpSettings.field.models.label": "模型覆盖",
  "module.compression.acpSettings.field.models.value": "{count} 个模型",

  "module.compression.acpSettings.promptPack.full": "完整（默认）",
  "module.compression.acpSettings.promptPack.lean": "精简",

  "module.compression.acpSettings.prompts.title": "提示词覆写",
  "module.compression.acpSettings.prompts.compressPhilosophy": "压缩哲学（compressPhilosophy）",
  "module.compression.acpSettings.prompts.howToCompressRules": "压缩规则（howToCompressRules）",
  "module.compression.acpSettings.prompts.tier2DistillRules": "T2 蒸馏规则（tier2DistillRules）",
  "module.compression.acpSettings.prompts.tier3CondenseRules": "T3 浓缩规则（tier3CondenseRules）",
  "module.compression.acpSettings.prompts.set": "已覆写 {count} 项",

  "module.compression.acpSettings.reasoning.title": "Reasoning 处理",
  "module.compression.acpSettings.reasoning.drop": "丢弃超限 thinking",
  "module.compression.acpSettings.reasoning.threshold": "阈值（字符）",

  "module.compression.acpSettings.images.title": "图片处理",
  "module.compression.acpSettings.images.strip": "剥离历史图片",

  "module.compression.acpSettings.tools.title": "工具保护名单",
  "module.compression.acpSettings.tools.add": "＋ 添加工具",
  "module.compression.acpSettings.tools.hint": "回车 添加/改名 · Ctrl+D 删除 · Esc 返回",

  "module.compression.acpSettings.input.title": "编辑 {field}",
  "module.compression.acpSettings.input.hint": "Enter 保存 · Esc 取消",
  "module.compression.acpSettings.input.invalid": "取值无效：{reason}",
  "module.compression.acpSettings.input.invalidPercent": "需要 0.75 这样的比例或 75% 这样的百分数",
  "module.compression.acpSettings.input.invalidPositiveInt": "需要正整数",
  "module.compression.acpSettings.input.invalidCount": "需要非负整数",
  "module.compression.acpSettings.input.invalidTool": "需要非空工具名",
  "module.compression.acpSettings.pickTitle": "选择 {field}",

  "module.compression.acpSettings.escalation":
    "ACP 配置问题：紧急阈值 {emergency} 低于最大上下文阈值 {max}，两项已回退内核默认（75% / 95%）",

  "module.compression.config.acpSectionInvalid":
    "压缩配置问题：{field} 不是对象（{value}），ACP 高级配置已忽略",
  "module.compression.config.acpProvidersInvalid":
    "压缩配置问题：{field} 不是供应商映射（{value}），供应商覆盖已忽略",
  "module.compression.config.acpProviderInvalid":
    "压缩配置问题：{field} 不是覆盖对象（{value}），该供应商的覆盖已跳过",
  "module.compression.config.acpModelsInvalid":
    "压缩配置问题：{field} 不是模型映射（{value}），模型覆盖已忽略",
  "module.compression.config.acpModelInvalid":
    "压缩配置问题：{field} 不是覆盖对象（{value}），该模型的覆盖已跳过",
  "module.compression.config.badPercent":
    "压缩配置问题：{field} 的取值 {value} 不是 (0,1] 内的比例或 75% 这样的百分串，该字段已剔除",
  "module.compression.config.badCount":
    "压缩配置问题：{field} 的取值 {value} 不是非负整数，该字段已剔除",
  "module.compression.config.badPositiveInt":
    "压缩配置问题：{field} 的取值 {value} 不是正整数，该字段已剔除",
  "module.compression.config.badArray":
    "压缩配置问题：{field} 的取值 {value} 不是字符串数组，该字段已剔除",

  // ── 跨模式生命周期与切换保护（工单 11）：独立分组的运行期诊断键 ──
  "module.compression.lifecycle.sessionStart":
    "上下文压缩已启用（本会话）：{diagnosis}",
  "module.compression.lifecycle.reparsed":
    "会话模型已变化，压缩策略已重新解析：{previous} → {diagnosis}",
  "module.compression.lifecycle.protected":
    "已取消本次{reason}压缩以保护会话历史：{states}无法在当前 {mode} 策略下安全回放。切回原模型可继续使用，或新建会话",
  "module.compression.lifecycle.protectedStatus":
    "压缩已取消：私有状态受保护（切回原模型或新建会话）",
  "module.compression.lifecycle.state.codexClaim": "来自 {identity} 的 Codex checkpoint",
  "module.compression.lifecycle.state.codexClaimUnparsed": "不可解析的 Codex checkpoint 声明",
  "module.compression.lifecycle.state.acpSidecar": "含 {blocks} 个压缩块的 ACP sidecar",
  "module.compression.lifecycle.state.foreignClaim": "来自 {identity} 的外部压缩扩展 checkpoint",
  "module.compression.lifecycle.foreignProtected":
    "已取消本次{reason}压缩：最新压缩状态（{identity}）由外部压缩扩展写入，内置模块不回放也不覆盖它的 opaque 历史；请先停用/迁移该外部扩展，或新建会话",

  "module.compression.codex.recovery.status": "正在把 Codex checkpoint 恢复为明文续接摘要…",
  "module.compression.codex.recovery.succeeded":
    "Codex 远程压缩失败，已按摘要恢复把 checkpoint 转为有损的明文续接摘要：opaque 历史已被新摘要取代；需要新的 checkpoint 可再次 /compact",
  "module.compression.codex.recovery.failed":
    "checkpoint 摘要恢复未完成（{error}）：历史已保留，本次压缩取消；可重试 /compact 或新建会话",

  "module.compression.acp.sidecarConfigGeneration":
    "ACP 配置在 sidecar 写入后已变更：已落盘的压缩块与引用保持有效，新阈值与提示词即刻生效（无需重建）",
  "module.compression.acp.foreignClaim":
    "本会话携带来自 {identity} 的 Codex checkpoint：ACP 模式下它只以明文 fallback 文本出现，opaque 历史不会回放；需要完整回放请切回原模型，或新建会话",
  "module.compression.acp.foreignClaimUnparsed": "不可解析的来源",
  "module.compression.acp.foreignExtensionClaim":
    "本会话携带外部压缩扩展写入的 checkpoint：ACP 模式下不回放其 opaque 历史；请先停用/迁移该外部扩展，或新建会话",
};

const ZH_TW: typeof EN = {
  "module.compression.label": "上下文壓縮",
  "module.compression.description":
    "pi-toolkit 自己的上下文壓縮策略：預設模式、native 觸發策略與 Codex/ACP 模型規則",
  "module.compression.enabled.label": "啟用上下文壓縮模組",
  "module.compression.enabled.description":
    "關閉後模組不註冊任何內容，會話繼續使用 Pi 原生壓縮（重新載入 pi 後生效）",

  "module.compression.defaultMode.label": "預設壓縮模式",
  "module.compression.defaultMode.description":
    "未命中明確模型規則時使用的模式：acp 作為預設模式會接管全部未命中模型（含 200k 自動偵測語意）；codex 作為預設模式受白名單防線約束，無明確規則時等價 native 僅提示",
  "module.compression.defaultMode.value.native": "Pi 原生",
  "module.compression.defaultMode.value.codex": "Codex",
  "module.compression.defaultMode.value.acp": "ACP",

  "module.compression.nativeTrigger.label": "native 觸發策略",
  "module.compression.nativeTrigger.description":
    "作用於 native 模式：auto 保留 Pi 的閾值壓縮與溢出恢復，manual 只回應手動 /compact",
  "module.compression.nativeTrigger.value.auto": "自動",
  "module.compression.nativeTrigger.value.manual": "僅手動",

  "module.compression.mode.native": "Pi 原生",
  "module.compression.mode.codex": "Codex",
  "module.compression.mode.acp": "ACP",

  "module.compression.acpAutoDetect.label": "ACP 自動偵測",
  "module.compression.acpAutoDetect.description":
    "未命中明確規則時，模型目錄宣告的上下文視窗不大於閾值的模型自動進入 ACP；元資料缺失時保持預設策略",

  "module.compression.rules.label": "模型規則",
  "module.compression.rules.description":
    "從模型目錄挑選完整 provider/model 身份的明確規則；多條命中時精度最高者生效",
  "module.compression.rules.value.none": "無規則",
  "module.compression.rules.value.configured": "{count} 條規則",
  "module.compression.rules.add": "＋ 新增規則",
  "module.compression.rules.hint": "Enter 編輯 · Ctrl+D 刪除 · Esc 返回",
  "module.compression.rules.deleteArmed": "再按 Enter 確認刪除",
  "module.compression.rules.duplicate": "規則已存在：{rule}",
  "module.compression.rules.modeTitle": "選擇 {rule} 的壓縮模式",
  "module.compression.rules.protocolTitle": "選擇 {rule} 的 Codex 協定",
  "module.compression.rules.modelTitle": "新增規則：從模型目錄選擇模型",
  "module.compression.rules.profile.label": "Codex profile",
  "module.compression.rules.profile.unset": "未指定（按模型 API 推導）",
  "module.compression.rules.profile.codex-responses-v1": "codex-responses-v1（Codex Responses 欄位形狀）",
  "module.compression.rules.profile.openai-responses-v1": "openai-responses-v1（普通 OpenAI Responses 欄位形狀）",
  "module.compression.rules.profileTitle": "選擇 {rule} 的 Responses profile",
  "module.compression.rules.onUnsupported.label": "Codex 不支援時策略",
  "module.compression.rules.onUnsupported.unset": "未指定（預設 native）",
  "module.compression.rules.onUnsupported.native": "native（回退 Pi 原生）",
  "module.compression.rules.onUnsupported.error": "error（取消並報錯）",
  "module.compression.rules.onUnsupportedTitle": "選擇 {rule} 的不支援時策略",
  "module.compression.rules.codexRemoteNote":
    "Codex 遠端壓縮：preflight 只做本地能力判定、不發探測請求；請求逾時與重試為模組預設（無設定面）",

  "module.compression.protocol.default": "預設（Remote V2）",
  "module.compression.protocol.remote-v2": "Remote V2",
  "module.compression.protocol.responses-compact": "responses/compact",
  "module.compression.protocol.context-management": "Context Management",

  "module.compression.diagnosis.label": "目前模型壓縮策略",
  "module.compression.diagnosis.description": "目前會話模型解析出的壓縮策略與診斷",
  "module.compression.diagnosis.noModel": "暫無會話模型",
  "module.compression.diagnosis.title": "壓縮策略診斷",

  "module.compression.diag.mode": "模式：{value}",
  "module.compression.diag.source": "來源：{value}",
  "module.compression.diag.rule": "命中規則：{value}",
  "module.compression.diag.contextWindow": "上下文視窗：{value}",
  "module.compression.diag.contextWindowMissing": "上下文視窗：不可用",
  "module.compression.diag.protocol": "協定：{value}",
  "module.compression.diag.profile": "Profile：{value}",
  "module.compression.diag.fallback": "回退原因：{value}",
  "module.compression.diag.conflict": "設定衝突：規則 {rules} 在同一精度命中且結果不一致，已回退預設策略",

  "module.compression.source.explicit": "明確規則",
  "module.compression.source.acp-auto": "ACP 自動偵測",
  "module.compression.source.default": "預設策略",

  "module.compression.fallback.conflict": "規則衝突",
  "module.compression.fallback.context-window-missing": "上下文視窗元資料缺失或無效",
  "module.compression.fallback.invalid-identity": "模型身份無效",

  "module.compression.reason.manual": "手動 /compact",
  "module.compression.reason.threshold": "上下文閾值",
  "module.compression.reason.overflow": "上下文溢出恢復",

  "module.compression.schedule.cancelled":
    "已按「僅手動」策略取消本次自動壓縮（{reason} 觸發）：需要時請手動執行 /compact 或新建會話——這是策略生效，不是故障。目前策略：{diagnosis}",
  "module.compression.schedule.status": "自動壓縮已按「僅手動」取消：需要時手動 /compact 或新建會話",
  "module.compression.schedule.ownerUnimplemented":
    "目前模型解析為 {mode} 模式（{source}），但該壓縮 owner 尚未實作：本次壓縮繼續使用 Pi 原生實作。策略診斷見 /pi-toolkit 選單。",
  "module.compression.schedule.handlerError":
    "壓縮排程器處理事件出錯（{error}）：本次已交回 Pi 原生壓縮",

  "module.compression.acp.takeover":
    "ACP 已接管本會話壓縮（{reason} 觸發已取消）：上下文由 ACP 投影，壓縮經 compress 工具執行，不使用 Pi 原生摘要",
  "module.compression.acp.status": "ACP 壓縮已接管：上下文由 ACP 投影（compress 工具）",
  "module.compression.acp.hostUnsupported":
    "宿主缺少會話 entry 接縫，ACP 無法投影上下文（{reason} 觸發）；本會話尚無 ACP 狀態，本次壓縮交回 Pi 原生",
  "module.compression.acp.hostUnsupportedWithState":
    "宿主缺少會話 entry 接縫但本會話仍有 ACP 狀態（{reason} 觸發）：已取消壓縮並保留狀態——請回到受支援的宿主或新建會話",
  "module.compression.acp.compactUnavailable":
    "ACP 狀態不可用（sidecar 版本不相容或重建失敗，{reason} 觸發）：已取消壓縮且不偽裝成功——請查看壓縮診斷或修復/刪除 sidecar",
  "module.compression.acp.sidecarNewer":
    "ACP sidecar 的結構版本 {version} 高於目前支援：檔案未被改動，ACP 狀態不可用——請升級 pi-toolkit 或刪除該 sidecar",
  "module.compression.acp.sidecarCorrupt":
    "ACP sidecar 已損壞（{error}）：將嘗試從會話日誌重建狀態",
  "module.compression.acp.sidecarMismatch":
    "ACP sidecar 與本會話日誌不一致（{missing} 個塊內訊息 id 在日誌中不存在，疑似拷貝或回退的 sidecar）：已按會話日誌重建狀態",
  "module.compression.acp.sidecarRebuilt":
    "ACP sidecar 缺失或損壞：已從會話日誌重建 {blocks} 個壓縮塊",
  "module.compression.acp.sidecarRebuildFailed":
    "ACP sidecar 重建失敗：會話日誌裡有壓縮歷史但無法重放任何塊，ACP 狀態不可用",
  "module.compression.acp.sidecarRebuildFailedWith":
    "ACP sidecar 重建失敗（{error}）：ACP 狀態不可用",
  "module.compression.acp.saveFailed":
    "ACP sidecar 寫入失敗（{error}）：記憶體狀態保留並在下次儲存重試，未啟動其它壓縮",
  "module.compression.acp.projectionUnavailable":
    "ACP 上下文投影不可用（狀態裝載失敗）：本次請求按原樣傳送——請先修復 sidecar 問題再壓縮",
  "module.compression.acp.projectionFailed":
    "ACP 上下文投影失敗（{error}）：已保留 ACP 狀態，本次請求按原樣傳送——可重試請求或查看診斷",
  "module.compression.acp.stateUnavailable":
    "compress/decompress 不可用：本會話的 ACP 狀態裝載失敗（見壓縮診斷）",
  "module.compression.acp.toolNotActive":
    "compress 已跳過：目前模型不在 ACP 壓縮策略下（未命中規則且自動檢測關閉）",
  "module.compression.codex.notWhitelisted":
    "目前模型解析為 codex 模式但沒有命中明確白名單規則：codex 壓縮只對明確 provider/model 規則生效，本會話繼續沿用既有策略（Pi 原生）",
  "module.compression.codex.resolve.noModel": "Codex 壓縮需要會話中存在活動模型",
  "module.compression.codex.status.running": "Codex 遠端壓縮中（{protocol}）…",

  "module.compression.codex.unsupported.apiNotResponses":
    "Codex 壓縮不可用（發請求前已判定）：模型 API {api} 不是 Responses 形狀（已知非 Responses API）",
  "module.compression.codex.unsupported.profileConflict":
    "Codex 壓縮不可用：規則宣告的 profile 與 API {api} 推導的 profile 衝突；請刪除規則裡的 profile 宣告或修正 API",
  "module.compression.codex.unsupported.protocolUnavailable":
    "Codex 壓縮在本建置中不可用：{protocol} 協定介面卡未接入",

  "module.compression.codex.outcome.fellBackNative":
    "——本次壓縮回退 Pi 原生（onUnsupported=native）",
  "module.compression.codex.outcome.cancelledError":
    "——本次壓縮已取消（onUnsupported=error）；請修復設定或將規則策略改為 native",

  "module.compression.codex.checkpoint.claimProtected":
    "歷史已保留：目前分支上已提交 opaque checkpoint，本次壓縮取消而不是二次壓縮。可用 /tree 在壓縮點前分支、換回原模型或新建會話。",
  "module.compression.codex.checkpoint.invalid":
    "活動 opaque checkpoint 無法解析（非法或更新格式）；歷史已保留",
  "module.compression.codex.checkpoint.incompatible":
    "活動 opaque checkpoint 屬於另一身份（不一致欄位：{fields}）；無法在目前模型上回放",
  "module.compression.codex.checkpoint.unverifiable":
    "儲存的會話日誌無法驗證上一個 opaque checkpoint 的投影；歷史已保留",
  "module.compression.codex.checkpoint.projectionFailed":
    "本次請求的 checkpoint 投影失敗：未注入 opaque 歷史，改用 fallback 摘要文案繼續，checkpoint 保留。可用 /tree 在壓縮點前分支或換回原模型。",

  "module.compression.codex.prepare.providerUnavailable": "活動的 Responses provider 不可用",
  "module.compression.codex.prepare.emptyReplacement": "遠端回應產出了空的 replacement history",
  "module.compression.codex.prepare.failed": "Codex 遠端壓縮失敗（{error}）",
  "module.compression.codex.contextManagement.invalid":
    "Context Management 回傳的 checkpoint 歷史不完整或非法（{error}）；歷史已保留，本次壓縮取消",
  "module.compression.codex.contextManagement.cancelled":
    "Context Management 壓縮在發佈前取消；現有歷史已保留",
  "module.compression.codex.commit.failed":
    "Codex checkpoint 提交失敗（{error}）：未回傳壓縮結果，會話日誌完整保留，本次壓縮取消",
  "module.compression.codex.rewrite.failed":
    "checkpoint marker 改寫失敗（{error}）：請求繼續使用 fallback marker 文本，checkpoint 保留",
  "module.compression.codex.routePaused":
    "Codex 遠端壓縮未發起請求：該路由在本會話中因更早的 OAuth 操作拒絕被暫停；重新載入 pi 或修復 OAuth 授權後再壓縮即可重試",
  "module.compression.codex.oauthRejected":
    "Codex 遠端壓縮被 provider 的 OAuth 邊界拒絕（{error}）；該路由本會話內已暫停，相容的 checkpoint 回放仍然可用",

  "module.compression.config.schemaVersionInvalid":
    "壓縮設定問題：{field} 不是可解釋的版本號（{value}），本節已整體回退預設設定",
  "module.compression.config.schemaVersionTooNew":
    "壓縮設定問題：{field} 為 {value}，高於目前支援的 {supported}，本節已整體回退預設設定",
  "module.compression.config.badEnum":
    "壓縮設定問題：{field} 的取值 {value} 不在 {allowed} 內，已回退為 {fallback}",
  "module.compression.config.badBoolean":
    "壓縮設定問題：{field} 的取值 {value} 不是布林值，已回退為 {fallback}",
  "module.compression.config.badNumber":
    "壓縮設定問題：{field} 的取值 {value} 不是正整數，已回退為 {fallback}",
  "module.compression.config.badString":
    "壓縮設定問題：{field} 的取值 {value} 不是字串，該欄位已剔除",
  "module.compression.config.rulesInvalid":
    "壓縮設定問題：{field} 不是規則陣列（{value}），模型規則已忽略",
  "module.compression.config.ruleInvalid":
    "壓縮設定問題：{field} 不是規則物件（{value}），該條已跳過",
  "module.compression.config.ruleMissingIdentity":
    "壓縮設定問題：{field} 沒有可用的 provider/model 身份（{value}），該規則已跳過",

  // ── ACP 高級設定（工單 10）：入口行、設定頁、欄位與診斷 ──
  "module.compression.acpAdvanced.label": "ACP 進階設定",
  "module.compression.acpAdvanced.description":
    "按 global → provider → model 逐欄位合併的 ACP 壓縮參數，含自動分流閾值",
  "module.compression.acpAdvanced.value.defaults": "預設參數",
  "module.compression.acpAdvanced.value.custom": "全域 {global} 項 · {providers} 家供應商",

  "module.compression.acpSettings.title": "ACP 進階設定",
  "module.compression.acpSettings.hint": "Enter 編輯 · Ctrl+D 清除 · Esc 返回",
  "module.compression.acpSettings.threshold.label": "自動分流閾值（tokens）",
  "module.compression.acpSettings.global.label": "全域壓縮參數",
  "module.compression.acpSettings.global.value.none": "未覆寫",
  "module.compression.acpSettings.global.value.set": "已設定 {count} 項",
  "module.compression.acpSettings.providers.label": "供應商與模型覆寫",
  "module.compression.acpSettings.providers.value.none": "無",
  "module.compression.acpSettings.providers.value.set": "{count} 家供應商",
  "module.compression.acpSettings.providerTitle": "選擇要覆寫的供應商",
  "module.compression.acpSettings.modelTitle": "選擇模型（{provider}）",
  "module.compression.acpSettings.levelHint": "未設定的欄位繼承上一層 · Enter 編輯 · Ctrl+D 清除 · Esc 返回",
  "module.compression.acpSettings.inherit": "繼承",
  "module.compression.acpSettings.on": "開",
  "module.compression.acpSettings.off": "關",

  "module.compression.acpSettings.field.maxContextLimit.label": "最大上下文閾值",
  "module.compression.acpSettings.field.emergencyThresholdPercent.label": "緊急截斷閾值",
  "module.compression.acpSettings.field.nudgeGrowthTokens.label": "nudge 增長步長（tokens）",
  "module.compression.acpSettings.field.preserveRecentMessages.label": "近期訊息保留（條）",
  "module.compression.acpSettings.field.protectedTools.label": "工具保護名單",
  "module.compression.acpSettings.field.promptPack.label": "Prompt pack",
  "module.compression.acpSettings.field.prompts.label": "提示詞覆寫",
  "module.compression.acpSettings.field.reasoning.label": "Reasoning 處理",
  "module.compression.acpSettings.field.stripImages.label": "圖片處理",
  "module.compression.acpSettings.field.models.label": "模型覆寫",
  "module.compression.acpSettings.field.models.value": "{count} 個模型",

  "module.compression.acpSettings.promptPack.full": "完整（預設）",
  "module.compression.acpSettings.promptPack.lean": "精簡",

  "module.compression.acpSettings.prompts.title": "提示詞覆寫",
  "module.compression.acpSettings.prompts.compressPhilosophy": "壓縮哲學（compressPhilosophy）",
  "module.compression.acpSettings.prompts.howToCompressRules": "壓縮規則（howToCompressRules）",
  "module.compression.acpSettings.prompts.tier2DistillRules": "T2 蒸餾規則（tier2DistillRules）",
  "module.compression.acpSettings.prompts.tier3CondenseRules": "T3 濃縮規則（tier3CondenseRules）",
  "module.compression.acpSettings.prompts.set": "已覆寫 {count} 項",

  "module.compression.acpSettings.reasoning.title": "Reasoning 處理",
  "module.compression.acpSettings.reasoning.drop": "丟棄超限 thinking",
  "module.compression.acpSettings.reasoning.threshold": "閾值（字元）",

  "module.compression.acpSettings.images.title": "圖片處理",
  "module.compression.acpSettings.images.strip": "剝離歷史圖片",

  "module.compression.acpSettings.tools.title": "工具保護名單",
  "module.compression.acpSettings.tools.add": "＋ 新增工具",
  "module.compression.acpSettings.tools.hint": "Enter 新增/改名 · Ctrl+D 刪除 · Esc 返回",

  "module.compression.acpSettings.input.title": "編輯 {field}",
  "module.compression.acpSettings.input.hint": "Enter 儲存 · Esc 取消",
  "module.compression.acpSettings.input.invalid": "取值無效：{reason}",
  "module.compression.acpSettings.input.invalidPercent": "需要 0.75 這樣的比例或 75% 這樣的百分數",
  "module.compression.acpSettings.input.invalidPositiveInt": "需要正整數",
  "module.compression.acpSettings.input.invalidCount": "需要非負整數",
  "module.compression.acpSettings.input.invalidTool": "需要非空工具名",
  "module.compression.acpSettings.pickTitle": "選擇 {field}",

  "module.compression.acpSettings.escalation":
    "ACP 設定問題：緊急閾值 {emergency} 低於最大上下文閾值 {max}，兩項已回退核心預設（75% / 95%）",

  "module.compression.config.acpSectionInvalid":
    "壓縮設定問題：{field} 不是物件（{value}），ACP 進階設定已忽略",
  "module.compression.config.acpProvidersInvalid":
    "壓縮設定問題：{field} 不是供應商映射（{value}），供應商覆寫已忽略",
  "module.compression.config.acpProviderInvalid":
    "壓縮設定問題：{field} 不是覆寫物件（{value}），該供應商的覆寫已跳過",
  "module.compression.config.acpModelsInvalid":
    "壓縮設定問題：{field} 不是模型映射（{value}），模型覆寫已忽略",
  "module.compression.config.acpModelInvalid":
    "壓縮設定問題：{field} 不是覆寫物件（{value}），該模型的覆寫已跳過",
  "module.compression.config.badPercent":
    "壓縮設定問題：{field} 的取值 {value} 不是 (0,1] 內的比例或 75% 這樣的百分字串，該欄位已剔除",
  "module.compression.config.badCount":
    "壓縮設定問題：{field} 的取值 {value} 不是非負整數，該欄位已剔除",
  "module.compression.config.badPositiveInt":
    "壓縮設定問題：{field} 的取值 {value} 不是正整數，該欄位已剔除",
  "module.compression.config.badArray":
    "壓縮設定問題：{field} 的取值 {value} 不是字串陣列，該欄位已剔除",

  // ── 跨模式生命周期與切換保護（工單 11）：獨立分組的運行期診斷鍵 ──
  "module.compression.lifecycle.sessionStart":
    "上下文壓縮已啟用（本會話）：{diagnosis}",
  "module.compression.lifecycle.reparsed":
    "會話模型已變化，壓縮策略已重新解析：{previous} → {diagnosis}",
  "module.compression.lifecycle.protected":
    "已取消本次{reason}壓縮以保護會話歷史：{states}無法在目前 {mode} 策略下安全回放。切回原模型可繼續使用，或新建會話",
  "module.compression.lifecycle.protectedStatus":
    "壓縮已取消：私有狀態受保護（切回原模型或新建會話）",
  "module.compression.lifecycle.state.codexClaim": "來自 {identity} 的 Codex checkpoint",
  "module.compression.lifecycle.state.codexClaimUnparsed": "無法解析的 Codex checkpoint 宣告",
  "module.compression.lifecycle.state.acpSidecar": "含 {blocks} 個壓縮塊的 ACP sidecar",
  "module.compression.lifecycle.state.foreignClaim": "來自 {identity} 的外部壓縮擴充 checkpoint",
  "module.compression.lifecycle.foreignProtected":
    "已取消本次{reason}壓縮：最新壓縮狀態（{identity}）由外部壓縮擴充寫入，內建模組不回放也不覆蓋它的 opaque 歷史；請先停用/遷移該外部擴充，或新建會話",

  "module.compression.codex.recovery.status": "正在把 Codex checkpoint 復原為明文續接摘要…",
  "module.compression.codex.recovery.succeeded":
    "Codex 遠端壓縮失敗，已按摘要復原把 checkpoint 轉為有損的明文續接摘要：opaque 歷史已被新摘要取代；需要新的 checkpoint 可再次 /compact",
  "module.compression.codex.recovery.failed":
    "checkpoint 摘要復原未完成（{error}）：歷史已保留，本次壓縮取消；可重試 /compact 或新建會話",

  "module.compression.acp.sidecarConfigGeneration":
    "ACP 設定在 sidecar 寫入後已變更：已落盤的壓縮塊與引用保持有效，新閾值與提示詞即刻生效（無需重建）",
  "module.compression.acp.foreignClaim":
    "本會話攜帶來自 {identity} 的 Codex checkpoint：ACP 模式下它只以明文 fallback 文本出現，opaque 歷史不會回放；需要完整回放請切回原模型，或新建會話",
  "module.compression.acp.foreignClaimUnparsed": "無法解析的來源",
  "module.compression.acp.foreignExtensionClaim":
    "本會話攜帶外部壓縮擴充寫入的 checkpoint：ACP 模式下不回放其 opaque 歷史；請先停用/遷移該外部擴充，或新建會話",
};

/** 本键表：全部模块键表在 modules/index.ts 聚合登记 */
export const COMPRESSION_MESSAGES = { en: EN, "zh-CN": ZH_CN, "zh-TW": ZH_TW } satisfies MessageTables;

/** 模块内使用的键类型 */
export type CompressionMessageKey = keyof typeof EN;

const PROBLEM_KEYS: Record<CompressionConfigProblem["kind"], CompressionMessageKey> = {
  schemaVersionInvalid: "module.compression.config.schemaVersionInvalid",
  schemaVersionTooNew: "module.compression.config.schemaVersionTooNew",
  badEnum: "module.compression.config.badEnum",
  badBoolean: "module.compression.config.badBoolean",
  badNumber: "module.compression.config.badNumber",
  badString: "module.compression.config.badString",
  rulesInvalid: "module.compression.config.rulesInvalid",
  ruleInvalid: "module.compression.config.ruleInvalid",
  ruleMissingIdentity: "module.compression.config.ruleMissingIdentity",
  acpSectionInvalid: "module.compression.config.acpSectionInvalid",
  acpProvidersInvalid: "module.compression.config.acpProvidersInvalid",
  acpProviderInvalid: "module.compression.config.acpProviderInvalid",
  acpModelsInvalid: "module.compression.config.acpModelsInvalid",
  acpModelInvalid: "module.compression.config.acpModelInvalid",
  badPercent: "module.compression.config.badPercent",
  badCount: "module.compression.config.badCount",
  badPositiveInt: "module.compression.config.badPositiveInt",
  badArray: "module.compression.config.badArray",
};

/** 配置问题 → 三语文案（模块解析器只产出结构化问题，翻译在这里做） */
export function formatCompressionProblem(problem: CompressionConfigProblem, t: Translator): string {
  const vars: MessageVars = { field: problem.field, value: problem.value };
  if (problem.kind === "schemaVersionTooNew") vars.supported = problem.supported;
  if (problem.kind === "badEnum") {
    vars.allowed = problem.allowed.join(" / ");
    vars.fallback = problem.fallback;
  }
  if (problem.kind === "badBoolean" || problem.kind === "badNumber") {
    vars.fallback = String(problem.fallback);
  }
  return t(PROBLEM_KEYS[problem.kind], vars);
}

/** 模块内取词函数（键收窄到本模块键表）：mod.ts 装配时注入宿主实时译者 */
export type CompressionTranslate = (key: CompressionMessageKey, vars?: MessageVars) => string;

/**
 * 只读本模块键表的译者：不依赖 modules/index.ts 的全局登记，
 * 供测试与独立装载直接取三语文案。
 */
export function compressionTableTranslator(language: ResolvedLanguage): Translator {
  const table: Record<string, string> = COMPRESSION_MESSAGES[language];
  return (key, vars) => formatMessage(table[key], key, vars);
}

// ─────────────────────────────────────────────────────────────
// 策略与规则的显示文案（工单 02）
// ─────────────────────────────────────────────────────────────

/** 模式显示名（诊断与规则行使用；schema 行的取值文案另有 defaultMode.value.* 键） */
export function compressionModeLabel(mode: CompressionMode, t: Translator): string {
  return t(`module.compression.mode.${mode}`);
}

/** 策略来源显示名 */
export function compressionSourceLabel(source: CompressionSource, t: Translator): string {
  return t(`module.compression.source.${source}`);
}

/** 回退原因显示名 */
export function compressionFallbackLabel(reason: CompressionFallbackReason, t: Translator): string {
  return t(`module.compression.fallback.${reason}`);
}

/** Codex 协议显示名（undefined 显示产品默认条目） */
export function codexProtocolLabel(protocol: CodexProtocol | undefined, t: Translator): string {
  return t(`module.compression.protocol.${protocol ?? "default"}`);
}

// ─────────────────────────────────────────────────────────────
// ACP 高级设置的显示文案（工单 10）：字段名、枚举值与值位格式化
// ─────────────────────────────────────────────────────────────

/** ACP 覆盖字段显示名（编辑器行标签） */
export function acpFieldLabel(field: AcpCompressField, t: Translator): string {
  return t(`module.compression.acpSettings.field.${field}.label`);
}

/** prompt pack 显示名 */
export function acpPromptPackLabel(pack: AcpPromptPack | undefined, t: Translator): string {
  if (pack === undefined) return t("module.compression.acpSettings.inherit");
  return t(`module.compression.acpSettings.promptPack.${pack}`);
}

/** percent 值位显示（75%）；未设显示继承 */
export function acpPercentValue(ratio: number | undefined, t: Translator): string {
  if (ratio === undefined) return t("module.compression.acpSettings.inherit");
  return `${Number((ratio * 100).toPrecision(6))}%`;
}

/** 数值/计数字段值位显示；未设显示继承 */
export function acpCountValue(value: number | undefined, t: Translator): string {
  if (value === undefined) return t("module.compression.acpSettings.inherit");
  return String(value);
}

/** 工具名单值位（N 项）；未设显示继承 */
export function acpToolsValue(tools: readonly string[] | undefined, t: Translator): string {
  if (tools === undefined) return t("module.compression.acpSettings.inherit");
  return t("module.compression.acpSettings.global.value.set", { count: tools.length });
}

/** 提示词覆写组值位（已覆写 N 项）；未设显示继承 */
export function acpPromptsValue(
  prompts: Readonly<Partial<Record<AcpPromptOverrideKey, string>>> | undefined,
  t: Translator,
): string {
  if (prompts === undefined) return t("module.compression.acpSettings.inherit");
  return t("module.compression.acpSettings.prompts.set", { count: Object.keys(prompts).length });
}

/** reasoning 组值位（开/关 · 阈值）；未设显示继承 */
export function acpReasoningValue(
  reasoning: { drop?: boolean; threshold?: number } | undefined,
  t: Translator,
): string {
  if (reasoning === undefined) return t("module.compression.acpSettings.inherit");
  const parts: string[] = [];
  if (reasoning.drop !== undefined) {
    parts.push(t(reasoning.drop ? "module.compression.acpSettings.on" : "module.compression.acpSettings.off"));
  }
  if (reasoning.threshold !== undefined) parts.push(String(reasoning.threshold));
  return parts.join(" · ");
}

/** 图片处理组值位（开/关 · 保留 N 条）；未设显示继承 */
export function acpImagesValue(
  value: { stripImages?: boolean; stripImagesKeepRecent?: number },
  t: Translator,
): string {
  const parts: string[] = [];
  if (value.stripImages !== undefined) {
    parts.push(t(value.stripImages ? "module.compression.acpSettings.on" : "module.compression.acpSettings.off"));
  }
  if (value.stripImagesKeepRecent !== undefined) parts.push(String(value.stripImagesKeepRecent));
  return parts.length === 0 ? t("module.compression.acpSettings.inherit") : parts.join(" · ");
}

/**
 * baseUrl 的展示形：剥掉 URL 里的 userinfo（凭据），诊断与规则行不携带
 * 敏感信息（规格「运行时诊断」）；无法按 URL 解析时原样展示（trim 过的值）。
 */
export function displayBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  try {
    const url = new URL(trimmed);
    return `${url.protocol}//${url.host}${url.pathname}${url.search}`;
  } catch {
    return trimmed;
  }
}

/** 规则身份的显示标签：provider/model，带可选约束（api / baseUrl） */
export function compressionRuleLabel(rule: CompressionModelRule): string {
  let label = `${rule.provider}/${rule.model}`;
  if (rule.api !== undefined) label += ` · api=${rule.api}`;
  if (rule.baseUrl !== undefined) label += ` · ${displayBaseUrl(rule.baseUrl)}`;
  return label;
}

/**
 * 策略解析的可读诊断（规格「运行时诊断」）：每次解析都能得到——实际模式、
 * 来源、命中规则、contextWindow、协议、profile 与回退原因；冲突时带冲突规则
 * 编号（展示用 1 基）。逐条一段，菜单详情页逐行展示。
 */
export function resolutionDiagnosisLines(
  resolution: CompressionStrategyResolution,
  t: Translator,
): string[] {
  const lines: string[] = [
    t("module.compression.diag.mode", { value: compressionModeLabel(resolution.mode, t) }),
    t("module.compression.diag.source", { value: compressionSourceLabel(resolution.source, t) }),
  ];
  if (resolution.matchedRule) {
    lines.push(
      t("module.compression.diag.rule", {
        value: compressionRuleLabel(resolution.matchedRule.rule),
      }),
    );
  }
  for (const conflict of resolution.conflicts) {
    lines.push(
      t("module.compression.diag.conflict", {
        rules: conflict.indices.map((index) => index + 1).join(", "),
      }),
    );
  }
  lines.push(
    resolution.contextWindow === undefined
      ? t("module.compression.diag.contextWindowMissing")
      : t("module.compression.diag.contextWindow", { value: String(resolution.contextWindow) }),
  );
  if (resolution.protocol !== undefined) {
    lines.push(t("module.compression.diag.protocol", { value: codexProtocolLabel(resolution.protocol, t) }));
  }
  if (resolution.profile !== undefined && resolution.profile !== "") {
    lines.push(t("module.compression.diag.profile", { value: resolution.profile }));
  }
  if (resolution.fallbackReason !== undefined) {
    lines.push(
      t("module.compression.diag.fallback", {
        value: compressionFallbackLabel(resolution.fallbackReason, t),
      }),
    );
  }
  return lines;
}

/** 诊断的单行形式（菜单行描述位）：各段以「 · 」连接 */
export function formatResolutionDiagnosis(
  resolution: CompressionStrategyResolution,
  t: Translator,
): string {
  return resolutionDiagnosisLines(resolution, t).join(" · ");
}
