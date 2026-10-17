// ACP 高级配置的消费接缝（工单 10）：把级联合并后的 compress 覆盖解析成
// acp-kernel 的运行时输入。
//
// 纯行为：给定（当前模型身份 + 已解析的 AcpAdvancedSettings）产出唯一的
// AcpResolvedRuntime——内核 Config、渲染 nudge 用的 Prompts、prompt pack 选择、
// 宿主侧策略字段（reasoning / stripImages，归工单 09/11 的投影与发送层消费）。
// 不读网络、不碰会话状态；引擎（engine.ts）在本接缝之上只做注入与诊断呈现。
//
// 内核映射（上游 billion-context-pi 的 resolveConfig 同款）：
// - maxContextLimit            → nudge.maxContextLimitPct
// - emergencyThresholdPercent  → nudge.emergencyThresholdPct + truncate.threshold
// - nudgeGrowthTokens          → nudge.growthFloor + nudge.growthCap
// - preserveRecentMessages     → preserveRecentMessages
// - protectedTools             → protectedTools
// - prompts                    → resolvePrompts（nudge 渲染直接生效；工具描述面归 09/11）
// - promptPack                 → 解析选择并携带（full=内核默认；lean 的工具描述与
//   compress 提示节应用归工单 09/11 的工具/系统提示层，本接缝只负责选定）
// - reasoning / stripImages*   → 原样携带（宿主侧投影/发送期策略，09/11 消费）
//
// 升档校验（emergency ≥ max）违反时两项都回退内核默认（0.75 / 0.95），问题以
// AcpEscalationIssue 携带，由引擎诊断呈现（解析层不做静态检查，避免被更深层
// 覆盖后误报，见 config.ts 的 acpEscalationIssue）。

import { createHash } from "node:crypto";
import {
  defaultConfig,
  resolvePrompts,
  type Config,
  type Prompts,
} from "acp-kernel";
import {
  EMPTY_ACP_ADVANCED_SETTINGS,
  type AcpAdvancedSettings,
  type AcpCompressOverrides,
  type AcpPromptPack,
} from "../api.ts";
import {
  acpEscalationIssue,
  mergeAcpCompressOverrides,
  type AcpEscalationIssue,
} from "../config.ts";
import { ACP_DEFAULT_PROTECTION, resolveAcpKernelConfig, type AcpProtectionPolicy } from "./protection.ts";

/** 模型目录未声明 contextWindow 时的兜底窗口（与上游 billion-context-pi 同值） */
export const ACP_FALLBACK_CONTEXT_LIMIT = 150000;

/** 运行时身份输入：provider / modelId 用于级联定位；contextWindow 用于内核分母 */
export interface AcpRuntimeIdentity {
  readonly provider?: string;
  readonly modelId?: string;
  readonly contextWindow?: number;
}

/** 级联合并 + 内核映射后的 ACP 运行时输入（引擎与后续工单的稳定接缝） */
export interface AcpResolvedRuntime {
  /** acp-kernel Config：阈值 / nudge / 近期保护 / 工具保护已按覆盖写入 */
  readonly kernel: Config;
  /** 渲染 nudge 用的提示词（含覆写；内核 load-bearing 契约见 prompts.d.ts） */
  readonly prompts: Prompts;
  /** prompt pack：full 完整 / lean 精简（默认 full） */
  readonly promptPack: AcpPromptPack;
  /** 级联合并后的完整覆盖（reasoning / stripImages 等宿主侧字段由下游消费） */
  readonly merged: AcpCompressOverrides;
  /** 升档校验问题（emergency < max 时携带；两项已在本结果里回退默认） */
  readonly escalation: AcpEscalationIssue | undefined;
}

/** contextWindow 元数据校验：有限正数才作分母，否则用兜底（不猜测更大值） */
function limitOf(identity: AcpRuntimeIdentity): number {
  const window = identity.contextWindow;
  return typeof window === "number" && Number.isFinite(window) && window > 0
    ? window
    : ACP_FALLBACK_CONTEXT_LIMIT;
}

/**
 * 覆盖 → 内核 Config（上游 resolveConfig 同款路径：defaultConfig 后写入阈值字段；
 * 未覆盖字段保持内核默认）。
 */
export function acpKernelConfigFor(
  identity: AcpRuntimeIdentity,
  effective: AcpCompressOverrides,
  protection?: AcpProtectionPolicy,
): Config {
  // 基座：工单 09 的保护策略层（默认 = 模块内默认值）；级联字段显式设置时覆盖
  const config = resolveAcpKernelConfig(limitOf(identity), protection ?? ACP_DEFAULT_PROTECTION);
  if (effective.preserveRecentMessages !== undefined) {
    config.preserveRecentMessages = effective.preserveRecentMessages;
  }
  if (effective.protectedTools !== undefined) {
    config.protectedTools = [...effective.protectedTools];
  }
  if (effective.maxContextLimit !== undefined) config.nudge.maxContextLimitPct = effective.maxContextLimit;
  if (effective.emergencyThresholdPercent !== undefined) {
    config.nudge.emergencyThresholdPct = effective.emergencyThresholdPercent;
    config.truncate.threshold = effective.emergencyThresholdPercent;
  }
  if (effective.nudgeGrowthTokens !== undefined) {
    config.nudge.growthFloor = effective.nudgeGrowthTokens;
    config.nudge.growthCap = effective.nudgeGrowthTokens;
  }
  return config;
}

/** 剔除两个阈值字段（升档校验失败时回退内核默认；不落 undefined 键） */
function dropThresholds(merged: AcpCompressOverrides): AcpCompressOverrides {
  const { maxContextLimit: _max, emergencyThresholdPercent: _emergency, ...rest } = merged;
  void _max;
  void _emergency;
  return rest;
}

/**
 * 解析 ACP 运行时输入（对外主出口）：
 * 1. 按 provider/modelId 做三级级联逐字段合并（mergeAcpCompressOverrides）；
 * 2. 升档校验失败时把两个阈值都回退内核默认（其余字段不受影响）；
 * 3. 映射内核 Config（分母 = contextWindow 或兜底）；解析提示词与 prompt pack。
 */
export function resolveAcpRuntimeConfig(
  identity: AcpRuntimeIdentity,
  acp: AcpAdvancedSettings,
  protection?: AcpProtectionPolicy,
): AcpResolvedRuntime {
  const merged = mergeAcpCompressOverrides(
    acp ?? EMPTY_ACP_ADVANCED_SETTINGS,
    identity.provider,
    identity.modelId,
  );
  const escalation = acpEscalationIssue(merged);
  const effective = escalation === undefined ? merged : dropThresholds(merged);
  return {
    kernel: acpKernelConfigFor(identity, effective, protection),
    prompts: resolvePrompts(effective.prompts, { acknowledgeRisk: true }),
    promptPack: effective.promptPack ?? "full",
    merged: effective,
    escalation,
  };
}

// ─────────────────────────────────────────────────────────────
// 配置代际（工单 11）：sidecar 写入时的配置指纹与兼容判定
// ─────────────────────────────────────────────────────────────

/**
 * 运行时配置指纹（配置代际）：对 resolved runtime 的内核 Config + 提示词做
 * 稳定序列化后的 sha256。指纹只用于「同一构建内的相等比较」，从不解释内容、
 * 不跨版本比较（内核升级后指纹自然变化，按配置代际变化处理）。
 */
export function acpConfigFingerprint(resolved: AcpResolvedRuntime): string {
  const stable = JSON.stringify({
    kernel: resolved.kernel,
    prompts: resolved.prompts,
    promptPack: resolved.promptPack,
  });
  return createHash("sha256").update(stable).digest("hex").slice(0, 16);
}

/** 配置代际判定结果：compatible 时 sidecar 状态继续使用；reason 供诊断去重 */
export interface AcpConfigGenerationVerdict {
  readonly compatible: boolean;
  readonly reason?: "legacy-sidecar" | "config-changed" | "incompatible";
}

/**
 * 配置代际兼容判定（工单 11）：sidecar 落盘后 ACP 配置发生变更时，已有状态
 * 与新配置是否兼容。
 *
 * 判定依据（锁定口径，测试锁定）：acp-kernel 的 CompressionState 形状与配置
 * 解耦——块与引用只按消息 id / 摘要 / tier 解释，配置（阈值 / nudge / 保护 /
 * 提示词 / prompt pack）只影响运行时行为，不影响已落盘状态的可解释性。
 * 因此配置代际变化恒为兼容：状态保留、新配置即刻生效，绝不因配置变化重建
 * 或丢弃 sidecar。结构不兼容由 schemaVersion（newer-schema）机制承担。
 * incompatible 分支是给未来「配置参与状态解释」时的接缝，当前不可达。
 */
export function judgeAcpConfigGeneration(
  storedFingerprint: string | undefined,
  currentFingerprint: string,
): AcpConfigGenerationVerdict {
  if (storedFingerprint === undefined) return { compatible: true, reason: "legacy-sidecar" };
  if (storedFingerprint === currentFingerprint) return { compatible: true };
  return { compatible: true, reason: "config-changed" };
}
