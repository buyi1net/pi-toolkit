// 视觉模型输出的 JSON 提取：先整体 parse，再截首尾大括号（容忍 markdown 围栏与前后杂文）。

/** 从模型输出中提取 JSON 对象；提取不出返回 undefined。 */
export function extractJson(text: string): Record<string, unknown> | undefined {
  const tryParse = (raw: string): Record<string, unknown> | undefined => {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  };
  const direct = tryParse(text.trim());
  if (direct) return direct;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return tryParse(text.slice(start, end + 1));
  return undefined;
}
