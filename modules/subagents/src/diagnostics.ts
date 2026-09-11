/**
 * 可选诊断日志。默认关闭，避免插件正常使用时污染宿主输出。
 * 设置 PI_SUBAGENTS_DEBUG=1 或 true 后记录尽力而为路径的失败原因。
 */
export function debugLog(message: string, error?: unknown): void {
  const enabled = process.env.PI_SUBAGENTS_DEBUG === "1" || process.env.PI_SUBAGENTS_DEBUG === "true";
  if (!enabled) return;

  const suffix = error === undefined
    ? ""
    : `: ${error instanceof Error ? error.message : String(error)}`;
  console.error(`[pi-subagents] ${message}${suffix}`);
}
