const MAX_NAME_LENGTH = 72;

export const MAX_TASK_NAME_LENGTH = MAX_NAME_LENGTH;

export function normalizeSubagentName(name: string, fallback = "subagent"): string {
  const normalized = name.replace(/\s+/g, " ").trim() || fallback;
  return normalized.slice(0, MAX_NAME_LENGTH);
}

export function sanitizeSubagentFileName(name: string, fallback = "subagent"): string {
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return sanitized || fallback;
}

/**
 * Canonical task name (the agent handle). Model input is never rejected for form:
 * separators, case, spaces, punctuation and overlong text are all folded into
 * `[a-z0-9_]` and truncated. Returns "" when nothing usable remains, so the caller
 * can decide the fallback (message-derived name, agent type, or a counter).
 */
export function normalizeTaskName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MAX_TASK_NAME_LENGTH)
    .replace(/_+$/g, "");
}

/** Derive a task name from the first line of a task message that yields one. */
export function deriveTaskNameFromMessage(message: unknown): string {
  if (typeof message !== "string") return "";
  for (const line of message.split(/\r?\n/)) {
    const candidate = normalizeTaskName(line);
    if (candidate) return candidate;
  }
  return "";
}
