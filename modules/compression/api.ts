// 压缩模块的静态导出面：模块 id、配置词汇表与类型。
// 只放类型 / 常量 / 纯函数，不放装配逻辑（index.ts）与实现（mod.ts / strategy.ts）。
//
// 模块边界（规格「实现决策→模块边界」）：本模块拥有独立配置节、菜单入口与三语文案。
// 工单 02 起策略解析（strategy.ts）与规则编辑器（rules-editor.ts）就位；
// session_before_compact 等压缩事件接管仍归后续工单。

/** 模块 id：同时是配置节名（modules.compression）与菜单项 id 前缀 */
export const COMPRESSION_MODULE_ID = "compression";

/**
 * 压缩配置节自己的结构版本（`modules.compression.schemaVersion`）。
 * 与 pi-toolkit.json 顶层的 TOOLKIT_SCHEMA_VERSION 互相独立：
 * 压缩节内新增字段只升本版本；高于本版本的节无法安全解释，
 * 由解析器报告问题并整节回退默认策略（见 config.ts）。
 * 工单 02 新增 modelRules / acpAutoDetect / acpAutoDetectThreshold 均为
 * 向后兼容的新字段（旧节缺省读默认），按「新字段可以向后兼容读取」留在版本 1。
 */
export const COMPRESSION_SCHEMA_VERSION = 1;

/** 产品压缩模式（规格固定词汇：native / codex / acp） */
export const COMPRESSION_MODES = ["native", "codex", "acp"] as const;
export type CompressionMode = (typeof COMPRESSION_MODES)[number];

/** native 模式的触发策略：auto 保留 Pi 自动阈值压缩，manual 只响应手动 /compact */
export const NATIVE_TRIGGER_POLICIES = ["auto", "manual"] as const;
export type NativeTriggerPolicy = (typeof NATIVE_TRIGGER_POLICIES)[number];

/**
 * Codex 压缩协议（规格「Codex 契约」的三条上游协议路径）：
 * remote-v2 = Remote V2；responses-compact = responses/compact；
 * context-management = Context Management。
 */
export const CODEX_PROTOCOLS = ["remote-v2", "responses-compact", "context-management"] as const;
export type CodexProtocol = (typeof CODEX_PROTOCOLS)[number];

/** codex 规则未显式指定 protocol 时的产品默认（Remote V2 为主路径） */
export const DEFAULT_CODEX_PROTOCOL: CodexProtocol = "remote-v2";

/** Codex 能力不足时的失败策略（规格场景 8）：native 回退 / error 严格报错 */
export const CODEX_UNSUPPORTED_POLICIES = ["native", "error"] as const;
export type CodexUnsupportedPolicy = (typeof CODEX_UNSUPPORTED_POLICIES)[number];

/**
 * codex 规则可显式声明的 Responses profile（codex/profiles.ts 的兼容声明词汇；
 * 解析器按自由字符串收，编辑器只写这两个合法值）。未指定 = 已知 Responses API
 * 按 API 推导，自定义 API 需显式声明 codex-responses-v1（见 codex/preflight.ts）。
 */
export const CODEX_RULE_PROFILES = ["codex-responses-v1", "openai-responses-v1"] as const;
export type CodexRuleProfile = (typeof CODEX_RULE_PROFILES)[number];

/**
 * ACP 自动检测默认口径（规格「策略模型与匹配」）：窗口小于或等于阈值进 ACP，
 * 阈值默认 200000 tokens。开关默认关闭——自动 ACP 是可选便利能力（规格「用户体验
 * 优先级」），且 ACP owner 在后续工单落地前不存在；需要零配置分流的用户显式打开。
 * 元数据缺失时仍不猜测（见 strategy.ts）。
 */
export const DEFAULT_ACP_AUTO_DETECT_ENABLED = false;
export const DEFAULT_ACP_CONTEXT_WINDOW_THRESHOLD = 200000;

// ─────────────────────────────────────────────────────────────
// ACP 高级配置（工单 10）：global → provider → model 逐字段合并的 compress 覆盖
// ─────────────────────────────────────────────────────────────

/**
 * prompt pack 选择（规格场景 15）：full = 完整提示词（内核默认）；
 * lean = 精简 pack（内核 leanPack：精简 how-to-compress 契约 + 单行工具描述）。
 * 上游 billion-context-pi 同名概念；产品只暴露这两个内置取值。
 */
export const ACP_PROMPT_PACKS = ["full", "lean"] as const;
export type AcpPromptPack = (typeof ACP_PROMPT_PACKS)[number];

/**
 * 提示词覆写的四个槽位：acp-kernel 的 load-bearing Prompts 字段（覆写整段生效，
 * 见 kernel prompts.d.ts 的风险说明）。空串/缺省 = 不覆写该槽位。
 */
export const ACP_PROMPT_OVERRIDE_KEYS = [
  "compressPhilosophy",
  "howToCompressRules",
  "tier2DistillRules",
  "tier3CondenseRules",
] as const;
export type AcpPromptOverrideKey = (typeof ACP_PROMPT_OVERRIDE_KEYS)[number];

/** ACP compress 覆盖的可编辑字段（编辑器行序；数值/枚举/分组各走各的控件） */
export const ACP_COMPRESS_FIELDS = [
  "maxContextLimit",
  "emergencyThresholdPercent",
  "nudgeGrowthTokens",
  "preserveRecentMessages",
  "protectedTools",
  "promptPack",
  "prompts",
  "reasoning",
  "stripImages",
  "stripImagesKeepRecent",
] as const;
export type AcpCompressField = (typeof ACP_COMPRESS_FIELDS)[number];

/**
 * ACP compress 覆盖（三级级联共用同一形状；上游 billion-context-pi 的
 * CompressSettings 字段名）：字段缺省（undefined）表示「本层不覆盖、继承上一级」。
 * 逐字段合并见 config.ts 的 mergeAcpCompressOverrides；内核映射见 acp/config.ts。
 */
export interface AcpCompressOverrides {
  /** 最大上下文阈值：用量达到该比例触发强制 nudge（内核 nudge.maxContextLimitPct）。
   *  解析结果为比例 (0,1]；配置文件接受 0.75 或 "75%" 两种写法（与上游一致） */
  readonly maxContextLimit?: number;
  /** 紧急截断阈值：达到该比例触发紧急截断（内核 nudge.emergencyThresholdPct +
   *  truncate.threshold）；合并结果不得低于 maxContextLimit（否则逐项回退，见
   *  config.ts 的 acpEscalationIssue） */
  readonly emergencyThresholdPercent?: number;
  /** nudge 增长步长（tokens）：每累积这么多新可压缩内容发一次软 nudge
   *  （内核 nudge.growthFloor + nudge.growthCap） */
  readonly nudgeGrowthTokens?: number;
  /** 近期消息保留（条）：软保护区里的最近消息数（内核 preserveRecentMessages） */
  readonly preserveRecentMessages?: number;
  /** 工具保护名单：名单内工具的每次调用+结果都硬保护不参与压缩（内核 protectedTools） */
  readonly protectedTools?: readonly string[];
  /** prompt pack：full 完整 / lean 精简（消费接缝在 acp/config.ts 解析，工具面应用归工单 09/11） */
  readonly promptPack?: AcpPromptPack;
  /** 提示词覆写：按槽位覆写内核四条 load-bearing 提示词（nudge 渲染即生效） */
  readonly prompts?: Readonly<Partial<Record<AcpPromptOverrideKey, string>>>;
  /** reasoning 处理：drop = 丢弃历史 compress 调用里超限的 thinking；threshold = 触发阈值（字符）。
   *  投影期宿主侧变换，运行时消费归工单 09/11，本工单落到配置与级联 */
  readonly reasoning?: { readonly drop?: boolean; readonly threshold?: number };
  /** 图片处理：stripImages = 剥离历史消息的图片载荷（发送期宿主侧）；keepRecent = 最近
   *  N 条消息保留图片。发送期消费归工单 09/11，本工单落到配置与级联 */
  readonly stripImages?: boolean;
  readonly stripImagesKeepRecent?: number;
}

/** provider 级覆盖：同一形状 + 可选的按 model id 细分的模型级覆盖 */
export interface AcpProviderOverrides extends AcpCompressOverrides {
  readonly models?: Readonly<Record<string, AcpCompressOverrides>>;
}

/** `modules.compression.acp` 的解析结果：全局覆盖 + provider 级（含 model 级） */
export interface AcpAdvancedSettings {
  readonly global: AcpCompressOverrides;
  readonly providers: Readonly<Record<string, AcpProviderOverrides>>;
}

/** 空的 ACP 高级配置（未配置节/未注入读取口时的等价默认） */
export const EMPTY_ACP_ADVANCED_SETTINGS: AcpAdvancedSettings = { global: {}, providers: {} };

/**
 * 模型规则（规格「策略模型与匹配」）：显式规则至少包含 provider 与 model id；
 * api / baseUrl 是可选约束（提高匹配精度）；mode 是结果；protocol / profile /
 * onUnsupported 是命中后的 Codex 参数，不参与匹配精度。
 * 配置解析（config.ts）负责逐项校验；解析结果中的规则已做空白规范化。
 */
export interface CompressionModelRule {
  /** 供应商 id（规则身份的必要部分） */
  readonly provider: string;
  /** 模型 id（规则身份的必要部分；不同供应商的同名模型互不串用） */
  readonly model: string;
  /** 可选约束：仅当模型身份的 api 与之相等时命中 */
  readonly api?: string;
  /** 可选约束：按规范化 baseUrl（去尾斜杠、协议/主机/端口/路径）比较 */
  readonly baseUrl?: string;
  /** 命中后的压缩模式 */
  readonly mode: CompressionMode;
  /** Codex 协议（mode=codex 时有效；缺省用产品默认） */
  readonly protocol?: CodexProtocol;
  /** Codex Responses 字段兼容声明（mode=codex 时有效） */
  readonly profile?: string;
  /** Codex 能力不足的失败策略（mode=codex 时有效；缺省 native） */
  readonly onUnsupported?: CodexUnsupportedPolicy;
}

/**
 * 策略解析的模型身份输入（规格「策略模型与匹配」）：provider、model id、API、
 * 规范化 baseUrl 与 contextWindow。全部字段只读；contextWindow 是模型目录声明
 * 的元数据，不代表 relay 真实支持相同窗口，仅用于可选的 ACP 自动分流。
 */
export interface ModelIdentity {
  readonly provider: string;
  readonly modelId: string;
  /** API 标记（如 openai-responses）：只用于请求适配、诊断和可选约束，绝不单独造成 Codex 接管 */
  readonly api?: string;
  /** provider 的 base URL；缺失表示未知（带 baseUrl 约束的规则不命中） */
  readonly baseUrl?: string;
  /** 模型目录声明的上下文窗口（tokens）；缺失或无效表示元数据不可用 */
  readonly contextWindow?: number;
}

/** 压缩模块当前生效的顶层设置（结构化字段全部经 config.ts 解析校验后进入这里） */
export interface CompressionSettings {
  /** 解析结果按当前结构版本解释（输入节缺省或非法时不进入本结果） */
  readonly schemaVersion: number;
  /** 默认压缩模式；未命中显式规则且未命中自动 ACP 时使用 */
  readonly defaultMode: CompressionMode;
  /** native 模式触发策略；默认 manual（面向大上下文模型，保留原始上下文） */
  readonly nativeTrigger: NativeTriggerPolicy;
  /** ACP 自动检测开关（规格场景 10 的关闭选项） */
  readonly acpAutoDetect: boolean;
  /** ACP 自动检测的 contextWindow 阈值（tokens，含） */
  readonly acpAutoDetectThreshold: number;
  /** 已校验的模型规则（非法条目在解析时逐项报告并剔除） */
  readonly modelRules: readonly CompressionModelRule[];
  /** ACP 高级配置（工单 10）：`modules.compression.acp` 的解析结果；字段非法逐项报告并回退（剔除该字段），不阻断其它字段与模型规则 */
  readonly acp: AcpAdvancedSettings;
}

export const DEFAULT_COMPRESSION_SETTINGS: CompressionSettings = {
  schemaVersion: COMPRESSION_SCHEMA_VERSION,
  defaultMode: "native",
  nativeTrigger: "manual",
  acpAutoDetect: DEFAULT_ACP_AUTO_DETECT_ENABLED,
  acpAutoDetectThreshold: DEFAULT_ACP_CONTEXT_WINDOW_THRESHOLD,
  modelRules: [],
  acp: EMPTY_ACP_ADVANCED_SETTINGS,
};

/**
 * 配置节解析问题：逐项报告的最小单位（kind + 出问题字段的完整路径 + 原值描述）。
 * 文案键在 messages/（三语），config.ts 只产出结构化问题，不带语言。
 */
export type CompressionConfigProblem =
  | { readonly kind: "schemaVersionInvalid"; readonly field: string; readonly value: string }
  | {
      readonly kind: "schemaVersionTooNew";
      readonly field: string;
      readonly value: string;
      readonly supported: number;
    }
  | {
      readonly kind: "badEnum";
      readonly field: string;
      readonly value: string;
      readonly allowed: readonly string[];
      readonly fallback: string;
    }
  | { readonly kind: "badBoolean"; readonly field: string; readonly value: string; readonly fallback: boolean }
  | { readonly kind: "badNumber"; readonly field: string; readonly value: string; readonly fallback: number }
  | { readonly kind: "badString"; readonly field: string; readonly value: string }
  | { readonly kind: "rulesInvalid"; readonly field: string; readonly value: string }
  | { readonly kind: "ruleInvalid"; readonly field: string; readonly value: string }
  | { readonly kind: "ruleMissingIdentity"; readonly field: string; readonly value: string }
  // ── ACP 高级配置（工单 10）：结构问题与字段级非法 ──
  | { readonly kind: "acpSectionInvalid"; readonly field: string; readonly value: string }
  | { readonly kind: "acpProvidersInvalid"; readonly field: string; readonly value: string }
  | { readonly kind: "acpProviderInvalid"; readonly field: string; readonly value: string }
  | { readonly kind: "acpModelsInvalid"; readonly field: string; readonly value: string }
  | { readonly kind: "acpModelInvalid"; readonly field: string; readonly value: string }
  | { readonly kind: "badPercent"; readonly field: string; readonly value: string }
  | { readonly kind: "badCount"; readonly field: string; readonly value: string }
  | { readonly kind: "badPositiveInt"; readonly field: string; readonly value: string }
  | { readonly kind: "badArray"; readonly field: string; readonly value: string };
