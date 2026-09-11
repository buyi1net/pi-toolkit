const MAX_NAME_LENGTH = 72;

/** 统一 pane、widget 和 registry 使用的显示名，避免不可寻址的空白字符。 */
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
