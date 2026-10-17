import { isDeepStrictEqual } from "node:util";
import {
  CodexCompactionProtocolError,
  type JsonObject,
  MAX_COMPACTION_ITEM_BYTES,
  validateCompactionItem,
} from "./protocol.ts";

export class ContextManagementProtocolError extends CodexCompactionProtocolError {
  constructor(message: string) {
    super(`Context management ${message}`);
    this.name = "ContextManagementProtocolError";
  }
}

/** Context Management 请求中的服务端压缩阈值。 */
export const CONTEXT_MANAGEMENT_THRESHOLD = 1024;

/**
 * 只作用于这次维护请求的内容。它让 relay 返回可供后续继续工作的
 * handoff，同时明确禁止在维护请求中执行原任务或调用工具。
 */
export const COMPACTION_MAINTENANCE_MESSAGE =
  "[PI_CONTEXT_COMPACTION_V1] This request is conversation maintenance only. " +
  "Preserve the original conversation goals, instructions, progress, and unfinished work for later continuation. " +
  "Return a concise continuation handoff with the goal, completed work, pending work, next action, and blockers. " +
  "For this request only, do not perform tasks or call tools. " +
  "This maintenance instruction expires when this response completes. " +
  "On later requests, follow the original conversation instructions and continue any unfinished task, including tool use when needed.";

/** Context Management 历史的硬上限，与 checkpoint 的持久化预算保持一致。 */
export const CONTEXT_MANAGEMENT_HISTORY_BYTE_BUDGET = 8 * 1024 * 1024;
export const CONTEXT_MANAGEMENT_HISTORY_TOKEN_BUDGET = 64_000;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function invalid(message: string): never {
  throw new ContextManagementProtocolError(message);
}

function validateCompletedCheckpoint(value: unknown): JsonObject {
  let item: JsonObject;
  try {
    item = validateCompactionItem(value);
  } catch {
    invalid("returned an invalid checkpoint");
  }
  if (item.status !== undefined && item.status !== "completed") invalid("returned an incomplete checkpoint");
  return item;
}

/**
 * Context Management 允许 checkpoint 后保留 reasoning 或 assistant message。
 * 这里先校验它们的可回放结构；reasoning 的加密正文在最终发布前还要再次
 * 由 validateMaintenanceOutput 强制确认。
 */
function validateObservedMaintenanceOutput(value: unknown): JsonObject {
  if (!isObject(value) || bytes(value) > MAX_COMPACTION_ITEM_BYTES) invalid("returned an invalid output item");
  if (value.status !== undefined && value.status !== "completed") invalid("returned incomplete output");
  if (value.type === "reasoning") {
    if (
      !Array.isArray(value.summary) ||
      !value.summary.every(
        (part) => isObject(part) && part.type === "summary_text" && typeof part.text === "string",
      )
    ) {
      invalid("returned invalid reasoning output");
    }
    if (
      value.encrypted_content !== undefined &&
      value.encrypted_content !== null &&
      typeof value.encrypted_content !== "string"
    ) {
      invalid("returned invalid encrypted reasoning");
    }
  } else if (value.type === "message" && value.role === "assistant") {
    if (
      !Array.isArray(value.content) ||
      !value.content.every(
        (part) =>
          isObject(part) &&
          ((part.type === "output_text" && typeof part.text === "string") ||
            (part.type === "refusal" && typeof part.refusal === "string")),
      )
    ) {
      invalid("returned invalid assistant output");
    }
  } else {
    invalid("returned unsupported output (tool invocation is disabled)");
  }
  return structuredClone(value);
}

/** 只能发布带完整 encrypted_content 的 reasoning。 */
export function validateMaintenanceOutput(value: unknown): JsonObject {
  const item = validateObservedMaintenanceOutput(value);
  if (
    item.type === "reasoning" &&
    (typeof item.encrypted_content !== "string" || item.encrypted_content.length === 0)
  ) {
    invalid("returned reasoning without replayable encrypted reasoning");
  }
  return item;
}

/**
 * 校验 Context Management 的完整 replacement history：第一个元素必须是
 * completed checkpoint，后续只能是可回放的 reasoning 或 assistant message，
 * 并且不能为了过预算静默截断后缀。
 */
export function validateContextManagementHistory(
  history: readonly unknown[],
  options: {
    readonly byteBudget?: number;
    readonly tokenBudget?: number;
  } = {},
): JsonObject[] {
  const byteBudget = options.byteBudget ?? CONTEXT_MANAGEMENT_HISTORY_BYTE_BUDGET;
  const tokenBudget = options.tokenBudget ?? CONTEXT_MANAGEMENT_HISTORY_TOKEN_BUDGET;
  if (!Array.isArray(history) || history.length === 0 || bytes(history) > byteBudget) {
    invalid("exceeded the replacement history limit");
  }
  const checkpoint = validateCompletedCheckpoint(history[0]);
  const suffix = history.slice(1).map(validateMaintenanceOutput);
  if (JSON.stringify(suffix).length > tokenBudget * 4) {
    invalid("exceeded the replacement text budget");
  }
  return [checkpoint, ...suffix];
}

/**
 * raw Responses SSE 的有序收集器。事件顺序是权威来源：新的 checkpoint
 * 会替换旧 checkpoint，但只保留它之后已经完成的 maintenance 输出。
 */
export function createContextManagementCollector() {
  let history: JsonObject[] = [];
  let completed = false;
  let failure: unknown;
  const doneById = new Map<string, JsonObject>();
  const doneWithoutId = new Map<string, JsonObject>();
  let historyIndices = new Map<JsonObject, number>();

  const rememberDone = (item: JsonObject): void => {
    if (typeof item.id === "string") {
      if (doneById.has(item.id)) invalid("repeated a completed output item");
      doneById.set(item.id, item);
      return;
    }
    const key = JSON.stringify(item);
    if (doneWithoutId.has(key)) invalid("repeated a completed output item");
    doneWithoutId.set(key, item);
  };

  const terminalItem = (item: unknown): JsonObject | undefined => {
    if (!isObject(item)) invalid("returned invalid terminal output");
    if (typeof item.id === "string") return doneById.get(item.id);
    return doneWithoutId.get(JSON.stringify(item));
  };

  return {
    observe(event: unknown): void {
      if (failure) return;
      try {
        if (!isObject(event) || typeof event.type !== "string") invalid("returned an invalid stream event");
        if (completed) invalid("returned events after completion");
        if (event.type === "error" || event.type === "response.failed" || event.type === "response.incomplete") {
          invalid("stream did not complete successfully");
        }
        if (event.type === "response.output_item.done") {
          const item =
            isObject(event.item) && event.item.type === "compaction"
              ? validateCompletedCheckpoint(event.item)
              : validateObservedMaintenanceOutput(event.item);
          rememberDone(item);
          if (item.type === "compaction") {
            history = [item];
            historyIndices = new Map([[item, 0]]);
          } else if (history.length > 0) {
            historyIndices.set(item, history.length);
            history.push(item);
          }
        } else if (event.type === "response.completed" || event.type === "response.done") {
          if (
            !isObject(event.response) ||
            event.response.status !== "completed" ||
            !Array.isArray(event.response.output)
          ) {
            invalid("returned an invalid terminal response");
          }
          for (const terminal of event.response.output) {
            const done = terminalItem(terminal);
            if (!done || done.type !== (isObject(terminal) ? terminal.type : undefined)) {
              invalid("returned terminal output without a completed item event");
            }
            const canonical =
              done.type === "reasoning" &&
              !done.encrypted_content &&
              isObject(terminal) &&
              typeof terminal.encrypted_content === "string" &&
              terminal.encrypted_content.length > 0
                ? { ...done, encrypted_content: terminal.encrypted_content }
                : done;
            if (!isDeepStrictEqual(canonical, terminal)) invalid("returned conflicting terminal output");
            if (canonical.type !== "compaction") validateObservedMaintenanceOutput(canonical);
            const index = historyIndices.get(done);
            if (index !== undefined) history[index] = canonical;
          }
          completed = true;
        }
      } catch (error) {
        // onPayload / raw stream callbacks 不能把异步异常直接泄漏给 provider。
        failure = error;
      }
    },
    finish(): JsonObject[] {
      if (failure) throw failure;
      if (!completed) invalid("stream ended without a successful terminal response");
      return validateContextManagementHistory(history);
    },
  };
}
