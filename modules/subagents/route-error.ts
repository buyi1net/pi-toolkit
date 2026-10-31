import type { SessionStats } from "./session.ts";

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

  message: string;

  provider?: string;

  model?: string;

  toolCount?: number;
  suggestedActions: string[];
}

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
