// ACP 保护策略（工单 09）：工具保护、近期消息保护与高价值工具调用保留的
// 判定配置与模块内默认值。
//
// 移植自 billion-context-pi 的 src/config.ts resolveConfig 保护字段段（MIT，
// 见模块 UPSTREAM.md）：上游把 adapter 配置里的保护字段合并进内核 Config；
// 本仓把同一合并逻辑收拢为 AcpProtectionPolicy —— 引擎当前只用模块内默认值
// （与上游默认一致），工单 10 的 global → provider → model 配置级联解析出
// 一份策略后经 createAcpEngine 的 protection 接缝注入，本文件不读配置。
//
// 保护语义（内核 acp-kernel 0.0.98 实现，本模块只负责传参）：
// - 工具保护 protectedTools / protectedLatestTools：命中的工具调用+结果对
//   永不（或仅最新一次）参与压缩，压缩块覆盖时被排除、视图保留；
// - 近期消息保护 preserveRecentMessages / preserveRecentTokens：最近 N 条
//   消息与最近 token 窗口软保护区，压缩范围落入保护区被内核拒绝（面板
//   文本列出原因）；
// - 高价值工具调用保留：内核 ALWAYS_PROTECTED_TOOLS（compress / acp_rule）
//   无条件硬保护——compress 调用参数是摘要与解压/搜索的事实源，压掉即断链；
// - neverPreserveRecentTools / preserveRecentTools：近期保护区的排除/回补
//   名单（decompress/search_context/read/bash 默认不占近期保护区，保证大
//   结果可立即回收）。缺省沿用内核内建名单。

import { defaultConfig, type Config } from "acp-kernel";

/**
 * ACP 保护策略（工单 10 配置级联的目标形状；字段全部可选，缺省 = 模块默认）。
 * 语义与内核 Config 的同名字段一一对应，见文件头注释。
 */
export interface AcpProtectionPolicy {
  /** 工具名/模式列表：每次调用+结果对都受硬保护（高价值独立内容型工具） */
  readonly protectedTools?: readonly string[];
  /** 工具名/模式列表：仅最新一次调用+结果对受硬保护（累计快照型工具） */
  readonly protectedLatestTools?: readonly string[];
  /** 近期保护区排除名单；缺省 = 内核内建（decompress/search_context/read/bash） */
  readonly neverPreserveRecentTools?: readonly string[];
  /** 近期保护区回补名单（从有效排除名单里减去）；缺省 = 不回补 */
  readonly preserveRecentTools?: readonly string[];
  /** 近期消息保护条数 */
  readonly preserveRecentMessages?: number;
  /** 近期消息保护 token 窗口 */
  readonly preserveRecentTokens?: number;
}

/**
 * 模块内默认保护策略（与上游 billion-context-pi resolveConfig 的缺省一致）：
 * 无额外硬保护工具、近期保护 5 条 / 5000 tokens、排除名单交给内核内建值。
 * 显式写死而非依赖内核 defaultConfig 的缺省，升级内核时行为不漂移。
 */
export const ACP_DEFAULT_PROTECTION: Readonly<AcpProtectionPolicy> = Object.freeze({
  protectedTools: [],
  protectedLatestTools: [],
  preserveRecentMessages: 5,
  preserveRecentTokens: 5000,
});

/** 保护策略 → 内核 Config 覆盖项（未设置字段不覆盖，保留内核缺省） */
export function acpProtectionOverrides(
  policy: AcpProtectionPolicy | undefined,
): Partial<Config> {
  if (!policy) return {};
  const overrides: Partial<Config> = {};
  if (policy.protectedTools !== undefined) overrides.protectedTools = [...policy.protectedTools];
  if (policy.protectedLatestTools !== undefined) {
    overrides.protectedLatestTools = [...policy.protectedLatestTools];
  }
  if (policy.neverPreserveRecentTools !== undefined) {
    overrides.neverPreserveRecentTools = [...policy.neverPreserveRecentTools];
  }
  if (policy.preserveRecentTools !== undefined) {
    overrides.preserveRecentTools = [...policy.preserveRecentTools];
  }
  if (policy.preserveRecentMessages !== undefined) {
    overrides.preserveRecentMessages = policy.preserveRecentMessages;
  }
  if (policy.preserveRecentTokens !== undefined) {
    overrides.preserveRecentTokens = policy.preserveRecentTokens;
  }
  return overrides;
}

/** 解析内核 Config：上下文窗口 + 保护策略（引擎与重建路径共用的唯一入口） */
export function resolveAcpKernelConfig(
  modelContextLimit: number,
  policy?: AcpProtectionPolicy,
): Config {
  return defaultConfig(modelContextLimit, acpProtectionOverrides(policy ?? ACP_DEFAULT_PROTECTION));
}
