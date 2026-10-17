// Codex 能力预检（工单 04）：远程请求之前的确定性能力判断。
//
// 规格口径（「Codex 契约」「所有者生命周期与失败回退」）：
// - preflight 只检查「已知不可能」的能力，不发真实请求：已知非 Responses
//   API 直接 unsupported；白名单中的 openai-responses 只代表请求形状可能
//   兼容（profile 可推导），不是 relay 已具备压缩能力的证明——真实能力由
//   fake fixture（本工单）与工单 13 的白名单协议验证确认；
// - profile 来源两途：已知 Responses API 按 API 推导（规则声明与之冲突 =
//   配置错误，unsupported）；自定义 API 只能靠规则显式声明
//   codex-responses-v1（对应上游 apiProfiles 收敛为规则级兼容声明）；
// - 协议适配器缺席（工单 05/06/07 未接入）也是确定性失败：preflight 阶段
//   拦截，按 onUnsupported 策略处置，绝不带着缺失的实现发请求。
//
// 纯函数：输入模型 API、规则 profile、协议与适配器表，输出可诊断结果。

import type { CodexProtocol } from "../api.ts";
import { deriveResponsesProfile, isResponsesCompactionApi, type ResponsesCompactionProfile } from "./profiles.ts";
import type { CodexProtocolAdapterMap, CodexRemoteCompactionAdapter } from "./remote.ts";

/** 预检失败原因（机读；三语文案见 messages/） */
export type CodexPreflightReason = "api-not-responses" | "profile-conflict" | "protocol-unavailable";

export type CodexPreflightResult =
  | {
      readonly status: "pass";
      readonly profile: ResponsesCompactionProfile;
      readonly protocol: CodexProtocol;
      readonly adapter: CodexRemoteCompactionAdapter;
      /** profile 的来源：api 推导 / 规则声明 */
      readonly profileSource: "api" | "rule";
    }
  | {
      readonly status: "unsupported";
      readonly reason: CodexPreflightReason;
      /** 出问题的 API（api-not-responses / profile-conflict 时携带） */
      readonly api?: string;
      /** 规则声明的 profile（profile-conflict 时携带） */
      readonly declaredProfile?: ResponsesCompactionProfile;
      /** 缺席的协议（protocol-unavailable 时携带） */
      readonly protocol?: CodexProtocol;
    };

/**
 * 解析当前模型 + 规则声明下的期望 profile（不依赖适配器可用性）。
 * 投影接缝（context / before_provider_request）的 checkpoint 身份校验用：
 * 已存在的 checkpoint 回放不能因本构建未接协议适配器而失效。
 */
export function resolveExpectedProfile(
  api: string | undefined,
  ruleProfile: string | undefined,
): ResponsesCompactionProfile | undefined {
  const derived = api === undefined ? undefined : deriveResponsesProfile(api);
  if (derived !== undefined) return derived;
  return ruleProfile === "codex-responses-v1" ? "codex-responses-v1" : undefined;
}

/**
 * 能力预检：白名单命中（策略解析已给出 mode=codex）之后、任何远程动作
 * 之前执行。返回 pass 时 adapter/protocol/profile 就绪，owner 进入 prepare；
 * 返回 unsupported 时按 onUnsupported 策略处置（native 回退 / 严格错误），
 * 且不发送任何远程请求。
 */
export function preflightCodexCompaction(input: {
  readonly api: string | undefined;
  readonly ruleProfile: string | undefined;
  readonly protocol: CodexProtocol;
  readonly adapters: CodexProtocolAdapterMap;
}): CodexPreflightResult {
  const derived = input.api === undefined ? undefined : deriveResponsesProfile(input.api);
  let profile: ResponsesCompactionProfile | undefined;
  let profileSource: "api" | "rule" | undefined;
  if (derived !== undefined) {
    profile = derived;
    profileSource = "api";
    if (
      input.ruleProfile !== undefined &&
      input.ruleProfile !== "" &&
      input.ruleProfile !== derived &&
      isResponsesCompactionApi(input.api ?? "")
    ) {
      // 已知 Responses API 的 profile 由 API 决定；规则声明与之冲突是配置
      // 错误——不猜哪个生效，直接 unsupported（修复方式：删掉规则里的
      // profile 声明或改正 API）。
      return { status: "unsupported", reason: "profile-conflict", api: input.api, declaredProfile: input.ruleProfile as ResponsesCompactionProfile };
    }
  } else if (input.ruleProfile === "codex-responses-v1") {
    profile = "codex-responses-v1";
    profileSource = "rule";
  }
  if (profile === undefined || profileSource === undefined) {
    return { status: "unsupported", reason: "api-not-responses", api: input.api };
  }
  const adapter = input.adapters[input.protocol];
  if (adapter === undefined) {
    return { status: "unsupported", reason: "protocol-unavailable", protocol: input.protocol, api: input.api };
  }
  return { status: "pass", profile, protocol: input.protocol, adapter, profileSource };
}
