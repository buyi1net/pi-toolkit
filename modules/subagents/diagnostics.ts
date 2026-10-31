export function debugLog(message: string, error?: unknown): void {
  const enabled = process.env.PI_SUBAGENTS_DEBUG === "1" || process.env.PI_SUBAGENTS_DEBUG === "true";
  if (!enabled) return;

  const suffix = error === undefined
    ? ""
    : `: ${error instanceof Error ? error.message : String(error)}`;
  console.error(`[pi-subagents] ${message}${suffix}`);
}
