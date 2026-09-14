import { Type, type Static } from "@sinclair/typebox";

export const MAX_COHORT_ID_LENGTH = 128;

export function normalizeCohortId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

export function validateCohortId(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") {
    return `Invalid cohortId: must be a string when provided; got ${String(value)}.`;
  }
  const normalized = value.trim();
  if (!normalized) return "Invalid cohortId: must be non-empty after trimming.";
  if (/[\u0000-\u001f\u007f]/.test(normalized)) {
    return "Invalid cohortId: must not contain control characters.";
  }
  if (normalized.length > MAX_COHORT_ID_LENGTH) {
    return `Invalid cohortId: must be at most ${MAX_COHORT_ID_LENGTH} characters.`;
  }
  return null;
}

export const SubagentParams = Type.Object({
  agent: Type.String({
    description:
      "Which agent to spawn (e.g. 'worker', 'scout', 'researcher'). This loads the agent's " +
      "fixed profile — its model, tool loadout, and system prompt. Must be one of the available agents.",
  }),
  task: Type.String({ description: "Task/prompt for the sub-agent" }),
  name: Type.Optional(
    Type.String({
      description:
        "Optional cosmetic label for the subagent's pane and widget row. Defaults to the agent name. " +
        "Has no effect on which agent runs — use `agent` for that.",
    }),
  ),
  cohortId: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: MAX_COHORT_ID_LENGTH,
      pattern: "^[^\\u0000-\\u001F\\u007F]+$",
      description:
        "Optional opaque group label for displaying and aggregating results from parallel subagents. " +
        "It has no scheduling, dependency, ownership, retention, or cleanup semantics; resume keeps the original label.",
    }),
  ),
  model: Type.Optional(Type.String({ description: "Model override (overrides agent default and takes precedence over `tier`). Supports 'provider/id' and optional ':<thinking>' suffix" })),
  tier: Type.Optional(
    Type.String({
      description:
        "Model tier preset: 'fast', 'balanced', or 'deep' (aliases quick/balance|standard/strong accepted). " +
        "Resolved from the pi-subagents config as an ordered candidate pool (models.fast/balanced/deep, arrays; the first configured candidate is the preferred model). " +
        "Candidates are tried in the configured order: when the host model catalog is available, candidates that verifiably lack a capability the agent profile requires (frontmatter `capabilities`, e.g. vision/reasoning) or do not support the resolved thinking level are skipped in favor of later candidates; " +
        "a candidate whose provider is known (from the last runtime status refresh) to have exhausted its quota, be offline, or be persistently unstable is also skipped. Unknown/unconfirmed status never blocks a candidate. " +
        "If the launched candidate then dies on a transient route error (rate limit / overload / timeout / temporary 5xx) before doing any work, the call automatically retries the next untried candidate (each candidate at most once, configured order, one shared timeoutMs budget); parameter/credential/quota/context errors are never auto-retried. " +
        "The tool result records the preferred model, the actual model, and the downgrade reason; if every candidate fails, a clear aggregated error is returned. " +
        "An explicit `model` always wins over `tier` (and is verified, never swapped — no failover). A tier without a configured candidate pool fails with a clear error — models are never silently swapped. " +
        "A default thinking level configured for the tier (thinking.fast/balanced/deep) applies when neither `thinking` nor the agent profile sets one.",
    }),
  ),
  thinking: Type.Optional(
    Type.String({
      description:
        "Thinking level override for this spawn: off, minimal, low, medium, high, xhigh, or max. " +
        "Priority: this explicit value > the agent's frontmatter thinking > the tier's configured default > the model's own ':<thinking>' suffix. " +
        "When the target model is known and does not support the resolved level, the spawn fails with a clear error instead of silently running at a different level.",
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory for the sub-agent. The agent starts in this folder and picks up its local .pi/ config, CLAUDE.md, skills, and extensions. Use for role-specific subfolders.",
    }),
  ),
  dependsOn: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Names of same-session subagents that MUST reach a terminal state BEFORE this call launches. " +
        "Also works for sibling subagent calls issued in the SAME assistant message: the dependent call waits on the upstream completion promise instead of launching in parallel; independent siblings still run in parallel. " +
        "When every dependency completed, a short upstream-results context block is appended to `task` (real extracted summaries, never fabricated). " +
        "If any dependency failed or was cancelled, this call does NOT launch and returns a structured `dependencyException` in the tool result details — no pane/process is created. " +
        "Rejected without launching: depending on this call's own name, on unknown names (not running, not announced in this message, and not in the session registry), and on interactive demo-pane subagents (they have no waitable terminal state). " +
        "Dependencies that already finished in an earlier turn are resolved from the session's name registry / session files.",
    }),
  ),
  surface: Type.Optional(
    Type.Union(
      [
        Type.Literal("auto"),
        Type.Literal("background"),
        Type.Literal("pane"),
      ],
      {
        description:
          "Where the sub-agent runs. 'auto' (default): autonomous agents run headless as an independent background pi process " +
          '(no pane/tab is created); demo/interactive agents run in a visible pane the user can operate. ' +
          "'background': force headless (refused for interactive agents — they need a visible pane). 'pane': force a visible pane. " +
          "Headless sub-agents are NOT visible and cannot be operated by the user.",
      },
    ),
  ),
  retention: Type.Optional(
    Type.Union(
      [
        Type.Literal("auto"),
        Type.Literal("preserve"),
        Type.Literal("discard"),
      ],
      {
        description:
          "Session retention for headless autonomous sub-agents after this call settles. 'auto' (default): delete this sub-agent's " +
          "session JSONL, .loadout.json, context task/system-prompt files and activity/runtime registration after a SUCCESSFUL terminal state; " +
          "failed, cancelled or handed-off runs are preserved so you can resume them with subagent_message. 'preserve': always keep everything. " +
          "'discard': always delete after a terminal state (including failure/cancellation) — use when you know you will never resume. " +
          "Visible pane / demo sub-agents are ALWAYS preserved regardless of this parameter. Deletion happens only after the result has been " +
          "extracted and returned — it never affects the tool result.",
      },
    ),
  ),
  timeoutMs: Type.Optional(
    Type.Integer({
      minimum: 1000,
      description:
        "Optional wait timeout in milliseconds (>= 1000) for THIS tool call's hard-barrier wait on an AUTONOMOUS sub-agent. " +
        "Omit it to wait indefinitely (existing behavior). When the timeout fires the call returns a structured non-terminal `timed-out` result: " +
        "the sub-agent itself is NOT killed, NOT cancelled, nothing is cleaned up and no summary is fabricated — it keeps running exactly like an " +
        "Escape-detached wait, and its real result is delivered later as a single steer message (lateDelivery). DependsOn consumers keep waiting " +
        "for the real terminal state. The timeout covers the post-launch run wait only; it does not shorten the pre-launch dependsOn wait. " +
        "Refused for interactive (demo) agents — their spawn returns immediately and has no wait to bound. " +
        "Siblings in the same message return their own tool results independently; a timed-out call is not a batch summary.",
    }),
  ),
  member: Type.Optional(
    Type.Boolean({
      description:
        "Spawn this sub-agent as a persistent TEAM MEMBER instead of a one-shot task. The call returns an immediate ack (no hard barrier): " +
        "the member runs as a long-lived headless process, stays alive after each round, and receives follow-up rounds via team_dispatch. " +
        "Each round's result is delivered once as a steer message when it ends. Members may message each other (fire-and-forget team_send) only " +
        "along ACL edges declared in the agent profile's `peer-send`. Constraints (violations are refused): headless only (surface may not be " +
        "'pane'), retention is forced to 'preserve' (may not be 'discard'), no timeoutMs, no dependsOn, and interactive (demo) agents cannot be " +
        "members. Members cannot be dependsOn targets (no process-level terminal state). Stopping a member requires subagent_stop; host session " +
        "shutdown or /reload terminates members and marks them offline (session preserved for explicit resume).",
    }),
  ),
});

export type SubagentParams = Static<typeof SubagentParams>;
