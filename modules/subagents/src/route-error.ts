import type { SessionStats } from "./session.ts";

/**
 * 路由异常结构化分类:子代理的 errorMessage 被归到有限的 kind 集合,连同
 * retryable 与 suggestedActions 一起作为 tool result details 里的
 * route_exception 提供给主编排代理。是否重试/换模型由主代理决定——本扩展
 * 不做自动 fallback,也不暂停其它 sibling 子代理。
 */
export type RouteExceptionKind =
  | "quota_exhausted"
  | "rate_limited"
  | "auth_failed"
  | "model_unavailable"
  | "context_too_large"
  | "provider_error"
  | "tool_failure"
  | "unknown";

export interface RouteException {
  kind: RouteExceptionKind;
  retryable: boolean;
  /** 原始错误文本(人类可读 content 之外的程序可读副本)。 */
  message: string;
  /** 能从已解析模型 id 拆出时提供("openrouter/z-ai/glm-5.2" → "openrouter")。 */
  provider?: string;
  /** 已解析模型 id(不含 provider 前缀;能解析时提供)。 */
  model?: string;
  /** 子代理会话中已执行的工具调用数(区分"启动即败"与"执行中途失败")。 */
  toolCount?: number;
  suggestedActions: string[];
}

/** 拆分 "provider/model[:thinking]" 形式的模型 id;无 provider 前缀时省略。 */
export function splitModelRef(modelRef: string): { provider?: string; model: string } {
  const slash = modelRef.indexOf("/");
  if (slash > 0 && slash < modelRef.length - 1) {
    return { provider: modelRef.slice(0, slash), model: modelRef.slice(slash + 1) };
  }
  return { model: modelRef };
}

interface RoutePattern {
  kind: RouteExceptionKind;
  retryable: boolean;
  patterns: RegExp[];
  suggestedActions: string[];
}

/**
 * 分类规则按优先级排列:更具体/更高价值判定(上下文超限、鉴权、额度、
 * 模型不存在)先于通用供应商错误;通用 5xx/网络类最后兜底,未命中即 unknown。
 * 模式来自常见供应商错误文案(Anthropic/OpenAI/OpenRouter),保守避免误判。
 */
const ROUTE_PATTERNS: RoutePattern[] = [
  {
    kind: "context_too_large",
    retryable: false,
    patterns: [
      /context (?:length|window)/i,
      /maximum context/i,
      /context too large/i,
      /prompt is too long/i,
      /input (?:is )?too long/i,
      /too many (?:input )?tokens/i,
      /token limit/i,
      /exceeds? the maximum/i,
    ],
    suggestedActions: [
      "Reduce or split the task, or attach less context",
      "Spawn with a model that has a larger context window",
    ],
  },
  {
    kind: "auth_failed",
    retryable: false,
    patterns: [
      /\b401\b/,
      /\b403\b/,
      /unauthorized/i,
      /forbidden/i,
      /invalid api key/i,
      /api key/i,
      /authentication/i,
      /not authenticated/i,
    ],
    suggestedActions: [
      "Check the provider credentials/API key configuration",
      "Fix the credential, then retry manually",
    ],
  },
  {
    kind: "quota_exhausted",
    retryable: false,
    patterns: [
      /quota/i,
      /\b402\b/,
      /insufficient (?:credits?|balance|funds)/i,
      /out of credits?/i,
      /credit balance/i,
      /billing/i,
      /payment/i,
      /spending limit/i,
    ],
    suggestedActions: [
      "Check the provider account balance/quota",
      "Decide on a different provider/model and respawn manually — no automatic switch",
    ],
  },
  {
    kind: "rate_limited",
    retryable: true,
    patterns: [/\b429\b/, /rate limit/i, /too many requests/i, /overloaded/i],
    suggestedActions: [
      "Wait for the limit window to pass, then retry manually",
      "Consider a different model or provider if this recurs",
    ],
  },
  {
    kind: "model_unavailable",
    retryable: false,
    patterns: [
      /model (?:is )?not found/i,
      /does not exist/i,
      /unknown model/i,
      /invalid model/i,
      /no such model/i,
      /model.*not available/i,
      /has been (?:decommissioned|deprecated)/i,
    ],
    suggestedActions: [
      "Verify the model id for this provider",
      "Update the pi-subagents tier mapping or pass an explicit model",
    ],
  },
  {
    kind: "tool_failure",
    retryable: false,
    patterns: [/tool (?:call|execution) failed/i, /failed to (?:run|execute) tool/i],
    suggestedActions: [
      "Inspect the sub-agent session for the failing tool call",
      "Retry with a narrower task or different tools",
    ],
  },
  {
    kind: "provider_error",
    retryable: true,
    patterns: [
      /\b5\d\d\b/,
      /bad gateway/i,
      /service unavailable/i,
      /internal server error/i,
      /server error/i,
      /timeout|timed out/i,
      /econn(?:refused|reset|aborted)/i,
      /enotfound/i,
      /fetch failed/i,
      /connection (?:error|refused|reset)/i,
    ],
    suggestedActions: [
      "Check the provider status page, then retry manually",
      "Retry with a different provider/model if the outage persists",
    ],
  },
];

/**
 * 从错误文本分类路由异常。context.model 取自主代理已解析的模型 id
 * (launch loadout / resume loadout),只做展示拆分,不影响 kind 判定。
 */
export function buildRouteException(
  errorMessage: string,
  context?: { model?: string | null; toolCount?: number },
): RouteException {
  const matched = ROUTE_PATTERNS.find((route) =>
    route.patterns.some((pattern) => pattern.test(errorMessage)),
  );
  const modelRef = context?.model?.trim();
  const split = modelRef ? splitModelRef(modelRef) : { provider: undefined, model: undefined };
  const base = matched ?? {
    kind: "unknown" as const,
    retryable: false,
    suggestedActions: [
      "Inspect the sub-agent session file for the full error",
      "Retry manually or spawn with a different model",
    ],
  };
  return {
    kind: base.kind,
    retryable: base.retryable,
    message: errorMessage,
    ...(split.provider ? { provider: split.provider } : {}),
    ...(split.model ? { model: split.model } : {}),
    ...(context?.toolCount != null ? { toolCount: context.toolCount } : {}),
    suggestedActions: base.suggestedActions,
  };
}

/**
 * 子代理结果 → route_exception(details 组装的统一入口):errorMessage 缺失
 * (成功/取消)或 userClosed(用户关闭 pane,非 provider/agent 错误)返回
 * undefined;已有 errorMessage 则现场分类,并把 stats.toolCount 一并带上。
 */
export function routeExceptionFromResult(
  result: { errorMessage?: string; stats?: Pick<SessionStats, "toolCount">; userClosed?: boolean },
  model?: string | null,
): RouteException | undefined {
  if (!result.errorMessage || result.userClosed) return undefined;
  return buildRouteException(result.errorMessage, {
    model,
    toolCount: result.stats?.toolCount,
  });
}
