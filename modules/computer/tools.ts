// computer 模块工具层（工单 05 接线五个工具；工单 06 补 computer_inspect / computer_read、能力门与动作日志；工单 19 补观察带图；工单 24 补 turn_end 收尾隐藏 AI 光标；工单 28 接线 computer_wait；工单 29 把等待轮询切到原生文本探测；工单 30 接线 computer_run）。
//
// 分工（工单 05 的收敛约定，同一套语义只有一份实现）：
// - 状态层（./state.ts）是快照、@rN/@eN 编号、陈旧判定、差异与大纲折叠的唯一语义；
//   等待轮询用的文本匹配与摊平观察树也是它导出的纯函数（工单 28），不碰状态生命周期；
// - 后端（./backend.ts）只喂观察树与根描述、执行动作并回执；
// - 动作日志（./log.ts）只管落盘格式，记录时机与内容由本层决定；
// - 截图基础设施（./screenshots.ts）只管目录、命名与旧图回收，采集预算与失败清理的时机由本层决定；
// - 本层负责模型面：参数校验、动作目录校验（显式目标）、引用解析、结果文本的预算。
//
// 已接线九个工具（computer_run 随工单 30 落地：PRE-BATCH 冻结 + 逐步执行 + 结束物化恰一份快照）。

import { join } from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import type { Translator } from "../../i18n/index.ts";
import type { ModuleContext } from "../../kit/module.ts";
import type { ComputerBackend, ComputerBackendAction, ComputerBackendObservation, ComputerBackendTarget } from "./backend.ts";
import {
  COMPUTER_ACTION_CONTRACTS,
  COMPUTER_CAPTURE_LONG_EDGE,
  COMPUTER_CAPTURE_MIN_LONG_EDGE,
  COMPUTER_IMAGE_BASE64_BUDGET,
  COMPUTER_OUTLINE_BUDGET,
  COMPUTER_READ_DEFAULT_CHARS,
  COMPUTER_RUN_DEFAULT_TIMEOUT_MS,
  COMPUTER_RUN_EXPECT_DEFAULT_TIMEOUT_MS,
  COMPUTER_RUN_MAX_STEP_ACTIONS,
  COMPUTER_RUN_MAX_STEPS,
  COMPUTER_RUN_MAX_TOTAL_ACTIONS,
  COMPUTER_SEARCH_DEFAULT_LIMIT,
  COMPUTER_TEXT_BUDGET,
  COMPUTER_TOOL_CONTRACTS,
  COMPUTER_WAIT_DEFAULT_TIMEOUT_MS,
  parseComputerRef,
  type ComputerActData,
  type ComputerAction,
  type ComputerActionField,
  type ComputerCaptureRecord,
  type ComputerError,
  type ComputerErrorCode,
  type ComputerExpectation,
  type ComputerInspectData,
  type ComputerNodeInspection,
  type ComputerNodeSummary,
  type ComputerObserveCapture,
  type ComputerObserveData,
  type ComputerReadData,
  type ComputerResult,
  type ComputerRootSummary,
  type ComputerRootsData,
  type ComputerRunData,
  type ComputerRunStepResult,
  type ComputerSearchData,
  type ComputerStateChange,
  type ComputerStateId,
  type ComputerStatusData,
  type ComputerToolContract,
  type ComputerWaitData,
  type ComputerWaitUntil,
  type ComputerRef,
  type ElementRef,
  type RootRef,
} from "./contract.ts";
import type { ComputerActionLogEntry, ComputerActionLogSink } from "./log.ts";
import { parseComputerKeyEntries } from "./key-names.ts";
import { COMPUTER_ERROR_MESSAGE_KEYS } from "./messages/index.ts";
import { imageFrameOf, imagePointToDesktop } from "./coordinates.ts";
import {
  createComputerState,
  flattenObservedComputerTree,
  isPathPrefix,
  locateObservedSubtree,
  renderComputerOutline,
  scoreComputerNodeText,
  type ComputerObservedFlatNode,
  type ComputerObservedNode,
  type ComputerRootDescriptor,
  type ComputerSnapshot,
  type ComputerSnapshotNode,
  type ComputerStateStore,
  type ComputerSubtreeIdentity,
} from "./state.ts";
import {
  ensureScreenshotDir,
  removeScreenshot,
  screenshotFileName,
  sweepScreenshots,
  type ComputerScreenshotSettings,
} from "./screenshots.ts";

// 模型可见文本的字符预算定义在 contract.ts（工单 18 定稿），经顶部 import 引入使用。
// 观察大纲最大，超过就截断并让模型改用 computer_search；更细的折叠规则在工单 06 定稿。

/** 大纲被截断时指路 computer_search：整棵树读不完时，搜索是更便宜的路径 */
const OUTLINE_TRUNCATED_MARKER =
  "... outline truncated; use computer_search with this stateId to find elements by text or role";

/** 其它文本被截断时的提示 */
const TRUNCATED_MARKER = "... truncated; narrow the query or act on what is already listed";

/** 工具入参类型：字段面与 contract.ts 的对应 schema 一致；schema 由 pi 宿主在 execute 前校验 */
interface ObserveParams {
  readonly root?: string;
  /** true 时先采一张窗口图再观察，图与快照共用一个 stateId；失败会让整个调用失败 */
  readonly capture?: boolean;
}
interface SearchParams {
  readonly stateId: string;
  readonly text?: string;
  readonly role?: string;
  readonly limit?: number;
}
interface InspectParams {
  readonly stateId: string;
  readonly ref: string;
}
interface ActParams {
  readonly stateId: string;
  readonly actions: readonly ComputerAction[];
}
interface ReadParams {
  readonly stateId: string;
  readonly ref: string;
  readonly offset?: number;
  readonly maxChars?: number;
}
interface WaitWindowParams {
  readonly ref?: string;
  readonly title?: string;
  readonly app?: string;
}
interface WaitParams {
  readonly stateId?: string;
  readonly text?: string;
  readonly ref?: string;
  readonly until?: ComputerWaitUntil;
  readonly window?: WaitWindowParams;
  readonly delayMs?: number;
  readonly timeoutMs?: number;
}
interface RunStepParams {
  readonly actions?: readonly ComputerAction[];
  readonly expect?: ComputerExpectation;
}
interface RunParams {
  readonly stateId: string;
  readonly steps: readonly RunStepParams[];
  readonly timeoutMs?: number;
}

/** details 走结构化的 ComputerResult，content 走模型可见文本 */
type ToolDetails<T> = ComputerResult<T>;

/**
 * 工单 07：把契约里的提示词元数据交给宿主（进系统提示的可用工具列表与 Guidelines）；
 * 数组复制一份传给宿主，避免契约常量被外部改写。
 */
function promptMeta(contract: ComputerToolContract): { promptSnippet: string; promptGuidelines: string[] } {
  return { promptSnippet: contract.promptSnippet, promptGuidelines: [...contract.promptGuidelines] };
}

export function registerComputerTools(
  context: ModuleContext,
  backend: ComputerBackend,
  actionLog: ComputerActionLogSink,
  // 截图落盘设置由装配层注入（工单 19）：工具层不自己取 agentDir，测试才能把图落到临时目录
  screenshots: ComputerScreenshotSettings,
  // 状态层可注入（工单 28 修复轮）：测试包一层计数代理直接断言状态层 observe 次数，不再靠元素编号间接推断
  state: ComputerStateStore = createComputerState(),
): void {
  const t = context.t;
  const contracts = COMPUTER_TOOL_CONTRACTS;

  // AI 光标收尾（工单 24）：只记「本轮真的派发过指针动作」（坐标动作与元素滚轮，helper 侧
  // 都会 MoveTo），turn_end 据此隐藏覆盖层；普通回合不触发任何桥交互。
  let pointerActivityThisTurn = false;
  const hideCursorAfterTurn = (): void => {
    if (!pointerActivityThisTurn) return;
    pointerActivityThisTurn = false;
    // fire-and-forget：收尾隐藏失败不抛不阻塞模型（helper 侧还有干扰恢复、空闲兜底与看门狗）
    void backend.cursor(false).catch(() => undefined);
  };
  context.pi.on("turn_start", () => {
    pointerActivityThisTurn = false;
  });
  context.pi.on("turn_end", hideCursorAfterTurn);

  context.pi.registerTool({
    name: "computer_status",
    label: contracts.computer_status.title,
    description: contracts.computer_status.description,
    ...promptMeta(contracts.computer_status),
    parameters: contracts.computer_status.parameters,
    executionMode: "sequential",
    async execute(): Promise<AgentToolResult<ToolDetails<ComputerStatusData>>> {
      const result = await backend.status();
      if (!result.ok) return failure(t, "computer_status", result.error);
      const text = cap(renderStatus(result.data));
      return success(result.data, text.text);
    },
  });

  context.pi.registerTool({
    name: "computer_roots",
    label: contracts.computer_roots.title,
    description: contracts.computer_roots.description,
    ...promptMeta(contracts.computer_roots),
    parameters: contracts.computer_roots.parameters,
    executionMode: "sequential",
    async execute(): Promise<AgentToolResult<ToolDetails<ComputerRootsData>>> {
      const discovered = await backend.roots();
      if (!discovered.ok) return failure(t, "computer_roots", discovered.error);
      const data: ComputerRootsData = { roots: state.registerRoots(discovered.data) };
      const text = cap(renderRoots(data.roots));
      return success(data, text.text);
    },
  });

  context.pi.registerTool({
    name: "computer_observe",
    label: contracts.computer_observe.title,
    description: contracts.computer_observe.description,
    ...promptMeta(contracts.computer_observe),
    parameters: contracts.computer_observe.parameters,
    executionMode: "sequential",
    async execute(
      _toolCallId: string,
      params: ObserveParams,
    ): Promise<AgentToolResult<ToolDetails<ComputerObserveData>>> {
      // 能力探测前置（工单 06）：先读能力，不支持无障碍树就明确报错，而不是返回一棵空树
      const capability = await treeCapabilityError(backend);
      if (capability) return failure(t, "computer_observe", capability);
      const discovered = await backend.roots();
      if (!discovered.ok) return failure(t, "computer_observe", discovered.error);
      const summaries = state.registerRoots(discovered.data);
      const summary = pickRoot(state, summaries, params.root);
      if (!summary.ok) return failure(t, "computer_observe", summary.error);

      // 带图观察（工单 19）：先采集再观察，图与快照共用一个预生成的 stateId（文件名先写 id 再 observe）。
      // 采集失败整个调用失败：快照与图要么一起有、要么一起没有（采集失败的删图由 captureWithBudget
      // 统一负责，这里只管 observe/state 两段失败）。清理与回收都用工具层自己生成的 capturePath，
      // 后端回执里的 path 只进回执，不作为删图依据（评审 C9）。
      let capture: ComputerCaptureRecord | undefined;
      let capturePath: string | undefined;
      let stateId: ComputerStateId | undefined;
      if (params.capture === true) {
        stateId = state.nextStateId();
        capturePath = join(screenshots.dir, screenshotFileName(summary.data.key, stateId));
        try {
          // 原生层是原子写但不建父目录（helper 只在同目录建临时文件）：采集前由工具层把目录建好
          ensureScreenshotDir(screenshots.dir);
        } catch (error) {
          return failure(t, "computer_observe", {
            code: "action_failed",
            detail: `cannot create screenshot directory: ${describeError(error)}`,
          });
        }
        const captured = await captureWithBudget(backend, summary.data.key, capturePath);
        if (!captured.ok) return failure(t, "computer_observe", captured.error);
        capture = captured.data;
      }

      const observed = await backend.observe(summary.data.key);
      if (!observed.ok) {
        // 图已落盘但不会有快照绑定它，留下只会是回收不掉的孤儿：先尽力删图再报观察失败
        if (capturePath !== undefined) removeScreenshot(capturePath);
        return failure(t, "computer_observe", observed.error);
      }

      let observation: ComputerObserveData;
      try {
        observation = state.observe({
          root: summary.data.ref,
          tree: observed.data.tree,
          ...(capture !== undefined ? { capture } : {}),
          ...(stateId !== undefined ? { stateId } : {}),
        });
      } catch (error) {
        // 状态层拒绝这份采集记录（跨根或字段自相矛盾）：同样不能让图留在盘上
        if (capturePath !== undefined) removeScreenshot(capturePath);
        throw error;
      }

      // 成功绑上快照才回收旧图：失败路径没有新图，回收只会白删上一张
      if (capturePath !== undefined) {
        sweepScreenshots(screenshots.dir, summary.data.key, capturePath, screenshots.limitBytes);
      }

      const outline = cap(observation.outline, COMPUTER_OUTLINE_BUDGET, OUTLINE_TRUNCATED_MARKER);
      let data: ComputerObserveData = {
        ...observation,
        outline: outline.text,
        // 原生层的规模截断也如实标进回执：大纲折叠、文本硬截断与原生截断共用这一个标记
        truncated: observation.truncated || outline.truncated || observed.data.truncated,
        ...(capture !== undefined ? { capture: toObserveCapture(capture) } : {}),
      };
      // 差异列表也可能把整条回执顶超预算；这时截的是整条文本，truncated 要跟上
      const text = cap(renderObservation(data));
      if (text.truncated) data = { ...data, truncated: true };
      return success(data, text.text);
    },
  });

  context.pi.registerTool({
    name: "computer_search",
    label: contracts.computer_search.title,
    description: contracts.computer_search.description,
    ...promptMeta(contracts.computer_search),
    parameters: contracts.computer_search.parameters,
    executionMode: "sequential",
    async execute(
      _toolCallId: string,
      params: SearchParams,
    ): Promise<AgentToolResult<ToolDetails<ComputerSearchData>>> {
      if (params.text === undefined && params.role === undefined) {
        return failure(t, "computer_search", {
          code: "invalid_params",
          detail: "provide text or role (at least one); the schema cannot express this either-or",
        });
      }
      const snapshot = currentSnapshot(state, params.stateId);
      if (!snapshot.ok) return failure(t, "computer_search", snapshot.error);
      const matched = searchSnapshot(snapshot.data, params);
      const limit = params.limit ?? COMPUTER_SEARCH_DEFAULT_LIMIT;
      const data: ComputerSearchData = {
        matches: matched.slice(0, limit).map(toNodeSummary),
        total: matched.length,
      };
      const text = cap(renderSearch(data, params));
      return success(data, text.text);
    },
  });

  context.pi.registerTool({
    name: "computer_inspect",
    label: contracts.computer_inspect.title,
    description: contracts.computer_inspect.description,
    ...promptMeta(contracts.computer_inspect),
    parameters: contracts.computer_inspect.parameters,
    executionMode: "sequential",
    async execute(
      _toolCallId: string,
      params: InspectParams,
    ): Promise<AgentToolResult<ToolDetails<ComputerInspectData>>> {
      const resolved = resolveSnapshotRef(state, params.stateId, params.ref, { elementOnly: true });
      if (!resolved.ok) return failure(t, "computer_inspect", resolved.error);
      const data = inspectSnapshotNode(resolved.data.snapshot, resolved.data.node);
      const text = cap(renderInspect(data));
      return success(text.truncated ? { ...data, truncated: true } : data, text.text);
    },
  });

  context.pi.registerTool({
    name: "computer_act",
    label: contracts.computer_act.title,
    description: contracts.computer_act.description,
    ...promptMeta(contracts.computer_act),
    parameters: contracts.computer_act.parameters,
    executionMode: "sequential",
    async execute(_toolCallId: string, params: ActParams): Promise<AgentToolResult<ToolDetails<ComputerActData>>> {
      const snapshot = currentSnapshot(state, params.stateId);
      if (!snapshot.ok) return failure(t, "computer_act", snapshot.error);
      const prepared = prepareActions(state, params.stateId, snapshot.data, params.actions);
      if (!prepared.ok) return failure(t, "computer_act", prepared.error);
      // 这批动作里有指针动作（坐标动作与元素滚轮都含 MoveTo）：turn_end 收尾时据此隐藏 AI 光标（工单 24）
      if (
        prepared.data.some((entry) => entry.command.x !== undefined || entry.command.action === "scroll")
      ) {
        pointerActivityThisTurn = true;
      }
      // 快照的根在 observe 时校验过，一定登记过；这里回查是为了拿后端要的稳定 key
      const root = state.findRoot(snapshot.data.root);
      if (!root) {
        return failure(t, "computer_act", {
          code: "target_not_found",
          detail: `the observed root ${snapshot.data.root} is no longer registered`,
        });
      }
      const receipt = await backend.act({ rootKey: root.key, actions: prepared.data });
      // 动作日志（工单 06）：派发出去的动作逐条记，成功失败都记；写失败不改变动作结果，只在文本里标注
      let logNote = "";
      try {
        await actionLog(logEntries(params.stateId, snapshot.data.root, root.key, prepared.data, receipt));
      } catch (error) {
        logNote = `\n[action log write failed: ${describeError(error)}]`;
      }
      if (!receipt.ok) return failure(t, "computer_act", receipt.error, logNote);
      const next = state.observe({ root: snapshot.data.root, tree: receipt.data.tree });
      const data: ComputerActData = { stateId: next.stateId, changes: next.changes };
      // 原生截断时不改结构（契约的 ComputerActData 没有截断字段），在文本里如实标注
      const text = cap(`${renderAct(data, receipt.data.truncated)}${logNote}`);
      return success(data, text.text);
    },
  });

  context.pi.registerTool({
    name: "computer_read",
    label: contracts.computer_read.title,
    description: contracts.computer_read.description,
    ...promptMeta(contracts.computer_read),
    parameters: contracts.computer_read.parameters,
    executionMode: "sequential",
    async execute(
      _toolCallId: string,
      params: ReadParams,
    ): Promise<AgentToolResult<ToolDetails<ComputerReadData>>> {
      // read 的元素或根都可以：控件（文档、编辑框）与窗口本身都能提供文本
      const resolved = resolveSnapshotRef(state, params.stateId, params.ref, { elementOnly: false });
      if (!resolved.ok) return failure(t, "computer_read", resolved.error);
      const node = resolved.data.node;
      // 分页就是 read 的预算：页大小由 maxChars 控制（上限见 contract.ts 的 COMPUTER_READ_MAX_CHARS），不再叠通用文本切截，
      // 否则 nextOffset 会与实际返回的文本对不上。
      const text = nodeText(node);
      const offset = params.offset ?? 0;
      const maxChars = params.maxChars ?? COMPUTER_READ_DEFAULT_CHARS;
      // 不劈开代理对：切点落在高位代理后面时向前挪一格（emoji 这类补充平面字符由两个 UTF-16 码元组成）
      let end = offset + maxChars;
      if (end < text.length && isHighSurrogate(text, end - 1) && isLowSurrogate(text, end)) end -= 1;
      const chunk = text.slice(offset, end);
      const hasMore = offset + chunk.length < text.length;
      const data: ComputerReadData = {
        text: chunk,
        truncated: hasMore,
        ...(hasMore ? { nextOffset: offset + chunk.length } : {}),
      };
      return success(data, renderRead(node, data, offset, text.length));
    },
  });

  context.pi.registerTool({
    name: "computer_wait",
    label: contracts.computer_wait.title,
    description: contracts.computer_wait.description,
    ...promptMeta(contracts.computer_wait),
    parameters: contracts.computer_wait.parameters,
    executionMode: "sequential",
    // 等待可能占用几十秒：signal 供宿主取消（Esc），onUpdate 供它推进度行；两者都是宿主传入的运行时参数
    async execute(
      _toolCallId: string,
      params: WaitParams,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<ToolDetails<ComputerWaitData>> | undefined,
    ): Promise<AgentToolResult<ToolDetails<ComputerWaitData>>> {
      return executeComputerWait(t, state, backend, params, { signal, onUpdate });
    },
  });

  context.pi.registerTool({
    name: "computer_run",
    label: contracts.computer_run.title,
    description: contracts.computer_run.description,
    ...promptMeta(contracts.computer_run),
    parameters: contracts.computer_run.parameters,
    executionMode: "sequential",
    // 整批可能占用几分钟：signal 供宿主取消（Esc）；动作在途时被取消要回 effectsUnknown 回执而不是抛错
    async execute(
      _toolCallId: string,
      params: RunParams,
      signal: AbortSignal | undefined,
    ): Promise<AgentToolResult<ToolDetails<ComputerRunData>>> {
      return executeComputerRun(t, state, backend, actionLog, params, {
        signal,
        // 光标联动与 act 同口径：整批里任一步含指针动作，本轮就记指针活动
        markPointerActivity: () => {
          pointerActivityThisTurn = true;
        },
      });
    },
  });
}

// ---------------------------------------------------------------------------
// computer_wait（工单 28）：三模式等待原语 —— 先快照后轮询，命中/超时才物化快照
// ---------------------------------------------------------------------------

/** 退避表前五轮（工单 28 定稿）：150→1000ms，之后相位切换 */
const WAIT_FAST_LADDER_MS: readonly number[] = [150, 300, 500, 750, 1000];
/** 前 30s 保持约每秒一轮；5 分钟内每 2s；再往后 5→15s */
const WAIT_SECOND_PHASE_MS = 30_000;
const WAIT_TWO_SECOND_PHASE_MS = 300_000;
const WAIT_SLOW_FLOOR_MS = 5_000;
const WAIT_SLOW_CEIL_MS = 15_000;
/** 睡眠切片上限：逐片响应取消，最坏 250ms 察觉；进度最多每 5s 一行 */
const WAIT_SLEEP_SLICE_MS = 250;
const WAIT_PROGRESS_INTERVAL_MS = 5_000;

/**
 * 第 round 轮失败后睡多久（round 从 0 起，elapsedMs 是已等待时长）。
 * 纯函数导出：退避节奏直接在测试里断言这张表，不真等（测试接缝选型见工单 28 记录）。
 */
export function computerWaitPollDelayMs(elapsedMs: number, round: number): number {
  if (round < WAIT_FAST_LADDER_MS.length) return WAIT_FAST_LADDER_MS[round];
  if (elapsedMs < WAIT_SECOND_PHASE_MS) return 1000;
  if (elapsedMs < WAIT_TWO_SECOND_PHASE_MS) return 2000;
  // 慢相位：5000ms 起，每多等一分钟加 2500，封顶 15000
  return Math.min(
    WAIT_SLOW_CEIL_MS,
    WAIT_SLOW_FLOOR_MS + 2_500 * Math.floor((elapsedMs - WAIT_TWO_SECOND_PHASE_MS) / 60_000),
  );
}

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 取消就如实抛（宿主把 execute 抛错转成调用失败），不装作条件已满足；tool 名进错误文本，跨工具复用不串台 */
function throwIfWaitAborted(signal: AbortSignal | undefined, tool = "computer_wait"): void {
  if (signal?.aborted) {
    throw new Error(`${tool} was cancelled before the condition was met`);
  }
}

/**
 * 分片睡眠：每片 ≤250ms，片边界响应取消；onSlice 每片回调一次（进入时的首行也在其中），
 * 进度节流在回调里做（这里不判）。onSlice 排在 abort 检查之后：已取消时不再多推一行进度。
 * 桥 v1 没有调用级取消，单轮观察最坏占用一次桥超时，能即时打断的只有睡眠。
 */
async function waitSleepSlices(
  totalMs: number,
  signal: AbortSignal | undefined,
  onSlice: () => void,
  tool = "computer_wait",
): Promise<void> {
  const end = Date.now() + totalMs;
  for (;;) {
    throwIfWaitAborted(signal, tool);
    onSlice();
    const remaining = end - Date.now();
    if (remaining <= 0) return;
    await sleepMs(Math.min(WAIT_SLEEP_SLICE_MS, remaining));
  }
}

/** 文本条件的子树限定：identity 供每轮重定位，ref 只进描述 */
interface WaitScope {
  readonly identity: ComputerSubtreeIdentity;
  readonly ref: string;
}

type WaitCondition =
  | {
      readonly kind: "text";
      readonly until: ComputerWaitUntil;
      readonly text: string;
      readonly scope?: WaitScope;
    }
  | {
      readonly kind: "window";
      readonly until: ComputerWaitUntil;
      /** 匹配用后端稳定 key；模型给的 @rN 另存 ref 回显，内部 key 不进条件描述 */
      readonly rootKey?: string;
      readonly ref?: string;
      readonly title?: string;
      readonly app?: string;
    }
  | { readonly kind: "delay"; readonly delayMs: number };

function describeWaitCondition(condition: WaitCondition): string {
  switch (condition.kind) {
    case "text":
      return `text ${JSON.stringify(condition.text)} ${condition.until}${
        condition.scope !== undefined ? ` within ${condition.scope.ref}` : ""
      }`;
    case "window": {
      const parts = [
        condition.ref !== undefined ? `ref ${condition.ref}` : undefined,
        condition.title !== undefined ? `title containing ${JSON.stringify(condition.title)}` : undefined,
        condition.app !== undefined ? `app containing ${JSON.stringify(condition.app)}` : undefined,
      ].filter((part) => part !== undefined);
      return `root with ${parts.join(" and ")} ${condition.until}`;
    }
    case "delay":
      return `fixed delay of ${condition.delayMs}ms`;
  }
}

/** 快照子树（含起点自己）；没有 scope 就是整棵快照但排除根（与 computer_search 同口径：根是观察对象本身） */
function snapshotScopeNodes(
  snapshot: ComputerSnapshot,
  scopeNode: ComputerSnapshotNode | undefined,
): readonly ComputerSnapshotNode[] {
  if (scopeNode === undefined) return snapshot.nodes.filter((node) => node.depth > 0);
  const byParent = new Map<ComputerRef, ComputerSnapshotNode[]>();
  for (const node of snapshot.nodes) {
    if (node.parentRef === undefined) continue;
    const siblings = byParent.get(node.parentRef) ?? [];
    siblings.push(node);
    byParent.set(node.parentRef, siblings);
  }
  const collected: ComputerSnapshotNode[] = [];
  const walk = (node: ComputerSnapshotNode): void => {
    collected.push(node);
    for (const child of byParent.get(node.ref) ?? []) walk(child);
  };
  walk(scopeNode);
  return collected;
}

/** 轮询一轮的文本匹配：scope 先按身份重定位（定位不到=子树不存在，文本算找不到） */
function observedTextFound(
  nodes: readonly ComputerObservedFlatNode[],
  text: string,
  scope: ComputerSubtreeIdentity | undefined,
): boolean {
  let candidates: readonly ComputerObservedFlatNode[];
  if (scope === undefined) {
    candidates = nodes.filter((node) => node.depth > 0);
  } else {
    const located = locateObservedSubtree(nodes, scope);
    if (!located) return false;
    candidates = nodes.filter((node) => isPathPrefix(located.path, node.path));
  }
  return candidates.some((node) => scoreComputerNodeText(node, text) !== undefined);
}

/** window 条件在场判定：多个字段与在一起（ref 按 key 精确，title/app 子串、大小写不敏感） */
function windowRootFound(
  roots: readonly ComputerRootDescriptor[],
  condition: Extract<WaitCondition, { readonly kind: "window" }>,
): boolean {
  const title = condition.title?.toLowerCase();
  const app = condition.app?.toLowerCase();
  return roots.some((root) => {
    if (condition.rootKey !== undefined && root.key !== condition.rootKey) return false;
    if (title !== undefined && !root.title.toLowerCase().includes(title)) return false;
    if (app !== undefined && !root.app.toLowerCase().includes(app)) return false;
    return true;
  });
}

/** 命中或超时才物化：用最后一次观察建一份快照（推进一代，旧快照退役）；没观察过就不物化 */
function materializeWaitSnapshot(
  state: ComputerStateStore,
  root: RootRef,
  tree: ComputerObservedNode | undefined,
): ComputerStateId | undefined {
  if (tree === undefined) return undefined;
  return state.observe({ root, tree }).stateId;
}

/**
 * computer_wait 的执行体：运行期校验（三模式恰一、存在性）→ 先判调用方快照 → 退避轮询。
 * text 模式每轮先走原生探测（helper 内命中即停，工单 29），probe 不可用时回退
 * 「原生观察 + 纯函数匹配」（工单 28 的原轮询）；命中/超时才取一次现场物化并返回 stateId。
 * window 模式走 roots（不需要无障碍树），永不物化；delay 模式什么都不看，只分片睡眠。
 */
async function executeComputerWait(
  t: Translator,
  state: ComputerStateStore,
  backend: ComputerBackend,
  params: WaitParams,
  run: {
    readonly signal: AbortSignal | undefined;
    readonly onUpdate: AgentToolUpdateCallback<ToolDetails<ComputerWaitData>> | undefined;
  },
): Promise<AgentToolResult<ToolDetails<ComputerWaitData>>> {
  const fail = (error: ComputerError): AgentToolResult<ToolDetails<ComputerWaitData>> =>
    failure(t, "computer_wait", error);

  // 三模式恰一与存在性：schema 表达不了互斥，运行期判（工单 28 定稿口径）
  const selected = [
    params.text !== undefined ? "text" : undefined,
    params.window !== undefined ? "window" : undefined,
    params.delayMs !== undefined ? "delayMs" : undefined,
  ].filter((mode) => mode !== undefined);
  if (selected.length !== 1) {
    const what = selected.length === 0 ? "none was given" : `${selected.join(" and ")} were given together`;
    return fail({
      code: "invalid_params",
      detail: `exactly one of text, window or delayMs must be given (${what}); the schema cannot express this either-or`,
    });
  }
  throwIfWaitAborted(run.signal);

  const startedAt = Date.now();
  const elapsedMs = (): number => Date.now() - startedAt;
  /** 进度节流：进入等待阶段先推一行，之后每 5s 一行；切片回调每片都进，这里挡掉多余的 */
  let lastProgressAt = -WAIT_PROGRESS_INTERVAL_MS;
  const progressOf = (condition: WaitCondition) => (): void => {
    const now = elapsedMs();
    if (now - lastProgressAt < WAIT_PROGRESS_INTERVAL_MS) return;
    lastProgressAt = now;
    run.onUpdate?.({
      content: [
        {
          type: "text",
          text: `still waiting for ${describeWaitCondition(condition)}: ${Math.round(now / 1000)}s elapsed`,
        },
      ],
      details: { ok: true, data: { met: false, elapsedMs: now } },
    });
  };

  // —— 纯延时：不观察、不产生 stateId；全量睡完，timeoutMs 不参与 ——
  if (params.delayMs !== undefined) {
    if (params.stateId !== undefined) {
      return fail({ code: "invalid_params", detail: "the delayMs mode takes no stateId; it observes nothing" });
    }
    if (params.ref !== undefined || params.until !== undefined) {
      return fail({ code: "invalid_params", detail: "the delayMs mode takes no ref/until; it waits a fixed time" });
    }
    if (params.timeoutMs !== undefined) {
      return fail({
        code: "invalid_params",
        detail: "the delayMs mode takes no timeoutMs; the full delay always elapses",
      });
    }
    const condition: WaitCondition = { kind: "delay", delayMs: params.delayMs };
    await waitSleepSlices(params.delayMs, run.signal, progressOf(condition));
    const data: ComputerWaitData = { met: true, elapsedMs: elapsedMs() };
    return success(data, renderWait(data, condition));
  }

  // —— text / window 共同前置：stateId 必填且必须是当前快照（延迟陈旧检查无意义） ——
  if (params.stateId === undefined) {
    return fail({
      code: "invalid_params",
      detail: "the text and window modes need the stateId of the current observation",
    });
  }
  const snapshot = currentSnapshot(state, params.stateId);
  if (!snapshot.ok) return fail(snapshot.error);
  const root = state.findRoot(snapshot.data.root);
  if (!root) {
    return fail({
      code: "target_not_found",
      detail: `the observed root ${snapshot.data.root} is no longer registered`,
    });
  }
  const until: ComputerWaitUntil = params.until ?? "present";
  const timeoutMs = params.timeoutMs ?? COMPUTER_WAIT_DEFAULT_TIMEOUT_MS;

  if (params.text !== undefined) {
    // 文本条件需要无障碍树（与 computer_observe 同一口径）；window 模式走 roots 不需要
    const capability = await treeCapabilityError(backend);
    if (capability) return fail(capability);
    let scope: WaitScope | undefined;
    let scopeNode: ComputerSnapshotNode | undefined;
    if (params.ref !== undefined) {
      const resolved = state.resolveRef(params.stateId, params.ref);
      if (!resolved.ok) return fail(resolved.error);
      scope = {
        identity: {
          path: snapshotPath(snapshot.data, resolved.node),
          role: resolved.node.role,
          ...(resolved.node.name !== undefined ? { name: resolved.node.name } : {}),
        },
        ref: params.ref,
      };
      scopeNode = resolved.node;
    }
    const condition: WaitCondition = { kind: "text", until, text: params.text, ...(scope ? { scope } : {}) };
    // 先判调用方快照：命中即回，省一次整树读取，也不产生新 stateId
    const initialFound = snapshotScopeNodes(snapshot.data, scopeNode).some(
      (node) => scoreComputerNodeText(node, params.text!) !== undefined,
    );
    if (initialFound === (until === "present")) {
      const data: ComputerWaitData = { met: true, elapsedMs: elapsedMs() };
      return success(data, renderWait(data, condition));
    }
    // 轮询（工单 29 切流）：text 条件每轮先走 probe——helper 内命中即停，不把整棵树搬回工具层；
    // probe 不可用（capability_unsupported，或老 helper 对未知命令回的 invalid_params）时
    // 本次等待内回退 observe 轮询并如实记一次日志，不假装探测过。命中/超时才取一次现场物化；
    // 那次观察失败不把等待判死（工单 29 评审修复），回 met 无 stateId 并记日志。
    const deadline = Date.now() + timeoutMs;
    const progress = progressOf(condition);
    const settle = async (met: boolean): Promise<AgentToolResult<ToolDetails<ComputerWaitData>>> => {
      // probe 轮询期间不搬树：命中/超时后才正常观察一次拿完整现场（沿用物化口径）
      if (lastTree === undefined) {
        const observed = await backend.observe(root.key);
        if (!observed.ok) {
          // 物化观察失败不把等待判死（工单 29 评审修复）：探测结论本身成立，缺的只是现场快照。
          // 如实回 met 与 elapsedMs（无 stateId）并记日志，不把整次等待陪葬；模型要现场可再 observe。
          console.warn(
            `[pi-computer] computer_wait: the settling observe failed (${observed.error.code}` +
              `${observed.error.detail === undefined ? "" : `: ${observed.error.detail}`}); returning met without a stateId`,
          );
          const bare: ComputerWaitData = { met, elapsedMs: elapsedMs() };
          return success(bare, renderWait(bare, condition, true));
        }
        lastTree = observed.data.tree;
      }
      // 物化恰好一次：用最后一次观察建快照并返回它的 stateId（成功与失败都给现场）
      const stateId = materializeWaitSnapshot(state, snapshot.data.root, lastTree);
      const data: ComputerWaitData = { met, elapsedMs: elapsedMs(), ...(stateId !== undefined ? { stateId } : {}) };
      return success(data, renderWait(data, condition));
    };
    let lastTree: ComputerObservedNode | undefined;
    let probeUsable = true;
    let round = 0;
    for (;;) {
      if (round > 0) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return settle(false);
        await waitSleepSlices(Math.min(computerWaitPollDelayMs(elapsedMs(), round - 1), remaining), run.signal, progress);
        // 睡到 deadline 就收口：不再多探测一轮，超时是硬上限
        if (Date.now() >= deadline) return settle(false);
      }
      throwIfWaitAborted(run.signal);
      if (probeUsable) {
        const probed = await backend.probe({
          rootKey: root.key,
          text: params.text,
          ...(scope !== undefined
            ? {
                path: scope.identity.path,
                role: scope.identity.role,
                ...(scope.identity.name !== undefined ? { name: scope.identity.name } : {}),
              }
            : {}),
        });
        if (probed.ok) {
          if (probed.data === (until === "present")) return settle(true);
        } else if (probed.error.code === "capability_unsupported" || probed.error.code === "invalid_params") {
          probeUsable = false;
          // 降级不假装：老 helper 不认识 probe（回 invalid_params）或会话探测不到 UIA，
          // 如实记一次再回退 observe 轮询（回退口径与工单 28 相同）
          console.warn(
            `[pi-computer] computer_wait: native text probe unavailable (${probed.error.code}` +
              `${probed.error.detail === undefined ? "" : `: ${probed.error.detail}`}); falling back to observe polling`,
          );
        } else {
          // 其它错误（窗口没了、桥超时等）与 observe 轮询同口径：如实失败，不静默降级
          return fail(probed.error);
        }
      }
      if (!probeUsable) {
        // 回退路径：每轮原生观察 + 纯函数匹配（工单 28 的原轮询），并留着最后一次树给物化
        const observed = await backend.observe(root.key);
        if (!observed.ok) return fail(observed.error);
        lastTree = observed.data.tree;
        const found = observedTextFound(flattenObservedComputerTree(observed.data.tree), params.text, scope?.identity);
        if (found === (until === "present")) return settle(true);
      }
      round += 1;
    }
  }

  if (params.window !== undefined) {
    // 顶层 ref 是 text 模式的子树限定字段：window 模式给了就是参数错，不静默忽略（模型明确传了就有预期）
    if (params.ref !== undefined) {
      return fail({
        code: "invalid_params",
        detail: "the window mode takes no ref; match a root with window.ref, or scope a text wait with ref",
      });
    }
    const hasAnyField =
      params.window.ref !== undefined || params.window.title !== undefined || params.window.app !== undefined;
    if (!hasAnyField) {
      return fail({
        code: "invalid_params",
        detail: "the window condition needs at least one of ref, title or app; an empty condition never settles",
      });
    }
    let rootKey: string | undefined;
    if (params.window.ref !== undefined) {
      const registered = state.findRoot(params.window.ref);
      if (!registered) {
        return fail({
          code: "target_not_found",
          detail: `${params.window.ref} is not a known root; call computer_roots again and use one of the returned refs`,
        });
      }
      rootKey = registered.key;
    }
    const condition: WaitCondition = {
      kind: "window",
      until,
      ...(rootKey !== undefined ? { ref: params.window.ref, rootKey } : {}),
      ...(params.window.title !== undefined ? { title: params.window.title } : {}),
      ...(params.window.app !== undefined ? { app: params.window.app } : {}),
    };
    const windowCondition = condition as Extract<WaitCondition, { readonly kind: "window" }>;
    const conditionMet = (roots: readonly ComputerRootDescriptor[]): boolean => {
      const found = windowRootFound(roots, windowCondition);
      return until === "present" ? found : !found;
    };
    // 快照里只有它自己的根，回答不了「别的窗口在不在」：首轮（不睡）就问一次 roots
    const deadline = Date.now() + timeoutMs;
    const progress = progressOf(condition);
    let round = 0;
    for (;;) {
      if (round > 0) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          const data: ComputerWaitData = { met: false, elapsedMs: elapsedMs() };
          return success(data, renderWait(data, condition));
        }
        await waitSleepSlices(Math.min(computerWaitPollDelayMs(elapsedMs(), round - 1), remaining), run.signal, progress);
        // 睡到 deadline 就收口：不再多问一轮 roots，超时是硬上限
        if (Date.now() >= deadline) {
          const data: ComputerWaitData = { met: false, elapsedMs: elapsedMs() };
          return success(data, renderWait(data, condition));
        }
      }
      throwIfWaitAborted(run.signal);
      const discovered = await backend.roots();
      if (!discovered.ok) return fail(discovered.error);
      if (conditionMet(discovered.data)) {
        const data: ComputerWaitData = { met: true, elapsedMs: elapsedMs() };
        return success(data, renderWait(data, condition));
      }
      round += 1;
    }
  }

  // 上面的模式恰一检查保证到这里至少命中一个分支；这行只为满足返回类型
  return fail({ code: "invalid_params", detail: "unreachable: wait mode selection" });
}

// ---------------------------------------------------------------------------
// computer_run（工单 30）：批量执行 —— PRE-BATCH 冻结、逐步执行、结束物化恰一份快照
// ---------------------------------------------------------------------------

/**
 * run 执行期的一步：全部引用已按调用方快照冻结（ref → path/role/name、坐标已换算，
 * expect 的子树限定冻结成身份）；执行期只留身份核对，不再回头解析。
 */
interface FrozenRunStep {
  readonly actions: readonly ComputerBackendAction[];
  readonly expect?: FrozenRunExpect;
}

/**
 * 冻结后的断言：text 或 window 恰一，求值口径与 computer_wait 的对应分支一致
 * （text：免桥首判 + probe 轮询 + observe 回退；window：roots 轮询）。
 */
type FrozenRunExpect =
  | {
      readonly kind: "text";
      readonly text: string;
      readonly until: ComputerWaitUntil;
      readonly timeoutMs: number;
      readonly scope?: WaitScope;
      /** 调用方快照里的限定节点：还没有树证据时的免桥首判用 */
      readonly scopeNode?: ComputerSnapshotNode;
    }
  | {
      readonly kind: "window";
      readonly until: ComputerWaitUntil;
      readonly timeoutMs: number;
      /** 匹配用后端稳定 key（PRE-BATCH 冻结时从 @rN 解析）；模型给的 ref 只进描述 */
      readonly rootKey?: string;
      readonly ref?: string;
      readonly title?: string;
      readonly app?: string;
    };

/** 冻结断言 → 条件描述：失败 detail 走 computer_wait 同一渲染器，两个工具的回执口径不分叉 */
function describeRunExpect(expect: FrozenRunExpect): string {
  if (expect.kind === "text") {
    return describeWaitCondition({
      kind: "text",
      until: expect.until,
      text: expect.text,
      ...(expect.scope !== undefined ? { scope: expect.scope } : {}),
    });
  }
  return describeWaitCondition({
    kind: "window",
    until: expect.until,
    ...(expect.rootKey !== undefined ? { ref: expect.ref, rootKey: expect.rootKey } : {}),
    ...(expect.title !== undefined ? { title: expect.title } : {}),
    ...(expect.app !== undefined ? { app: expect.app } : {}),
  });
}

/**
 * 整批取消且动作在途时的事实回执：桥 v1 没有调用级取消，动作是否落地未知，
 * 只能按结果未知如实报（复用 bridge_timeout 的语义；effectsUnknown 据此置位）。
 */
const RUN_CANCELLED_IN_FLIGHT: ComputerError = {
  code: "bridge_timeout",
  detail:
    "the run was cancelled while this step's actions were in flight; whether they took effect is unknown — " +
    "observe the root again before retrying",
};

/** 失败步的错误是否属于「已发出的动作结果未知」：桥超时 / 干扰中断（原生层固定前缀） */
function runEffectsUnknown(error: ComputerError): boolean {
  return error.code === "bridge_timeout" || (error.detail?.startsWith("user_interference_result_unknown:") ?? false);
}

/** 安全点上的取消（不在途）：与 computer_wait 同纪律，如实抛，不装作跑完 */
function throwIfRunAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("computer_run was cancelled before the remaining steps ran");
  }
}

/** 派发后的动作与取消信号赛跑：取消赢在回执前 → "cancelled"（效果未知）；否则照常回回执 */
async function raceRunActWithAbort(
  actPromise: Promise<ComputerResult<ComputerBackendObservation>>,
  signal: AbortSignal | undefined,
): Promise<ComputerResult<ComputerBackendObservation> | "cancelled"> {
  if (signal === undefined) return actPromise;
  let onAbort: () => void = () => {};
  const aborted = new Promise<"cancelled">((resolve) => {
    onAbort = () => resolve("cancelled");
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([actPromise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * computer_run 的执行体：运行期双重校验 → PRE-BATCH 冻结全部动作与子树限定 → 逐步执行
 * （动作步走 backend.act 的回执树，断言步复用等待的条件求值器：免桥首判 + probe 轮询 +
 * observe 回退）→ 结束（成功或失败）物化恰一份快照。执行期不调 state.observe，
 * 纯内存推进，一步不堆一份状态；身份核对交给 helper（对不上 stale_ref 停批）。
 */
async function executeComputerRun(
  t: Translator,
  state: ComputerStateStore,
  backend: ComputerBackend,
  actionLog: ComputerActionLogSink,
  params: RunParams,
  run: {
    readonly signal: AbortSignal | undefined;
    readonly markPointerActivity: () => void;
  },
): Promise<AgentToolResult<ToolDetails<ComputerRunData>>> {
  const fail = (error: ComputerError): AgentToolResult<ToolDetails<ComputerRunData>> =>
    failure(t, "computer_run", error);

  // —— 规模上限与空 step：schema 拦一道，这里再拦一道（绕过 schema 的调用方也拿 invalid_params） ——
  if (params.steps.length === 0) {
    return fail({ code: "invalid_params", detail: "steps must contain at least one step" });
  }
  if (params.steps.length > COMPUTER_RUN_MAX_STEPS) {
    return fail({
      code: "invalid_params",
      detail: `at most ${COMPUTER_RUN_MAX_STEPS} steps per run, got ${params.steps.length}`,
    });
  }
  let totalActions = 0;
  for (const [index, step] of params.steps.entries()) {
    const count = step.actions?.length ?? 0;
    if (count > COMPUTER_RUN_MAX_STEP_ACTIONS) {
      return fail({
        code: "invalid_params",
        detail: `step ${index + 1} has ${count} actions; at most ${COMPUTER_RUN_MAX_STEP_ACTIONS} per step`,
      });
    }
    totalActions += count;
    if (count === 0 && step.expect === undefined) {
      return fail({
        code: "invalid_params",
        detail: `step ${index + 1} is empty: give actions or an expect (the schema cannot express this either-or)`,
      });
    }
  }
  if (totalActions > COMPUTER_RUN_MAX_TOTAL_ACTIONS) {
    return fail({
      code: "invalid_params",
      detail: `at most ${COMPUTER_RUN_MAX_TOTAL_ACTIONS} actions per run, got ${totalActions}`,
    });
  }
  throwIfRunAborted(run.signal);

  // 不设前置能力门（与 computer_act 同口径）：纯坐标批次不依赖语义树，前置整批拒绝会连它一起拦下；
  // 断言要读树时由 probe/observe 如实报错停批

  const snapshotResult = currentSnapshot(state, params.stateId);
  if (!snapshotResult.ok) return fail(snapshotResult.error);
  const snapshot = snapshotResult.data;
  const root = state.findRoot(snapshot.root);
  if (!root) {
    return fail({
      code: "target_not_found",
      detail: `the observed root ${snapshot.root} is no longer registered`,
    });
  }

  // —— PRE-BATCH 冻结：全部步骤的动作与子树限定按调用方快照一次性解析，任一非法整批拒发 ——
  // 键名预校验（工单 31）：helper 的键名校验在 act 层（每步派发时才看见那步的 keys），
  // 不预校验的话非法键名要到那一步才炸、前面步骤的副作用已经落地（真机验收抓到的半批执行）；
  // 这里在冻结阶段把全部 keypress 的 keys 先解析一遍，任何一个非法整批拒绝（零派发、零物化），
  // 回执形状与其它冻结失败一致，错误文案与 helper 的 parse_keys 同口径（见 ./key-names.ts 镜像）
  for (const [index, step] of params.steps.entries()) {
    for (const [actionIndex, action] of (step.actions ?? []).entries()) {
      if (action.action !== "keypress" || action.keys === undefined) continue;
      const parsedKeys = parseComputerKeyEntries(action.keys);
      if (!parsedKeys.ok) {
        return fail({
          code: "invalid_params",
          detail: `step ${index + 1}, action ${actionIndex + 1} (keypress): ${parsedKeys.message}`,
        });
      }
    }
  }
  const frozen: FrozenRunStep[] = [];
  for (const [index, step] of params.steps.entries()) {
    let actions: readonly ComputerBackendAction[] = [];
    if (step.actions !== undefined && step.actions.length > 0) {
      const prepared = prepareActions(state, params.stateId, snapshot, step.actions);
      if (!prepared.ok) {
        return fail({ code: prepared.error.code, detail: `step ${index + 1}, ${prepared.error.detail ?? ""}` });
      }
      actions = prepared.data;
    }
    let expect: FrozenRunExpect | undefined;
    if (step.expect !== undefined) {
      const until = step.expect.until ?? "present";
      const timeoutMs = step.expect.timeoutMs ?? COMPUTER_RUN_EXPECT_DEFAULT_TIMEOUT_MS;
      const hasText = step.expect.text !== undefined;
      const hasWindow = step.expect.window !== undefined;
      if (hasText === hasWindow) {
        return fail({
          code: "invalid_params",
          detail:
            `step ${index + 1}: exactly one of expect.text or expect.window must be given ` +
            `(${hasText ? "both were" : "neither was"}); the schema cannot express this either-or`,
        });
      }
      if (hasWindow) {
        // 顶层 ref 是 text 断言的子树限定字段：window 断言给了就是参数错，不静默忽略（与 computer_wait 同口径）
        if (step.expect.ref !== undefined) {
          return fail({
            code: "invalid_params",
            detail: `step ${index + 1}: the window expect takes no ref; match a root with window.ref`,
          });
        }
        const window = step.expect.window!;
        if (window.ref === undefined && window.title === undefined && window.app === undefined) {
          return fail({
            code: "invalid_params",
            detail:
              `step ${index + 1}: the window expect needs at least one of ref, title or app; ` +
              "an empty condition never settles",
          });
        }
        // PRE-BATCH 冻结：@rN 在冻结时解析成稳定 key（与整批纪律一致；key 是稳定身份，执行期不再回查注册表）
        let rootKey: string | undefined;
        if (window.ref !== undefined) {
          const registered = state.findRoot(window.ref);
          if (!registered) {
            return fail({
              code: "target_not_found",
              detail: `step ${index + 1}: ${window.ref} is not a known root; call computer_roots again and use one of the returned refs`,
            });
          }
          rootKey = registered.key;
        }
        expect = {
          kind: "window",
          until,
          timeoutMs,
          ...(rootKey !== undefined ? { rootKey, ref: window.ref } : {}),
          ...(window.title !== undefined ? { title: window.title } : {}),
          ...(window.app !== undefined ? { app: window.app } : {}),
        };
      } else {
        const text = step.expect.text!;
        let scope: WaitScope | undefined;
        let scopeNode: ComputerSnapshotNode | undefined;
        if (step.expect.ref !== undefined) {
          const resolved = state.resolveRef(params.stateId, step.expect.ref);
          if (!resolved.ok) {
            return fail({ code: resolved.error.code, detail: `step ${index + 1}: ${resolved.error.detail ?? ""}` });
          }
          scope = {
            identity: {
              path: snapshotPath(snapshot, resolved.node),
              role: resolved.node.role,
              ...(resolved.node.name !== undefined ? { name: resolved.node.name } : {}),
            },
            ref: step.expect.ref,
          };
          scopeNode = resolved.node;
        }
        expect = {
          kind: "text",
          text,
          until,
          timeoutMs,
          ...(scope !== undefined ? { scope } : {}),
          ...(scopeNode !== undefined ? { scopeNode } : {}),
        };
      }
    }
    frozen.push({ actions, ...(expect !== undefined ? { expect } : {}) });
  }
  // 光标联动与 act 同口径（坐标动作与元素滚轮都含 MoveTo）：整批里任何一步有指针动作，本轮就记指针活动
  if (
    frozen.some((step) =>
      step.actions.some((entry) => entry.command.x !== undefined || entry.command.action === "scroll"),
    )
  ) {
    run.markPointerActivity();
  }

  // —— 执行期共享状态：都不碰 state.observe，纯内存推进 ——
  const runDeadline = Date.now() + (params.timeoutMs ?? COMPUTER_RUN_DEFAULT_TIMEOUT_MS);
  const stepResults: ComputerRunStepResult[] = [];
  const logNotes: string[] = [];
  let completed = 0;
  /** 手头最新树（还没有树时指调用方快照）之后没有未经树证实的界面变化 */
  let treeFresh = true;
  let lastTree: ComputerObservedNode | undefined;
  let probeUsable = true;

  /**
   * 断言求值：复用等待的求值器口径（text：免桥首判 → probe 轮询 → observe 回退；
   * window：roots 轮询），超时被整体预算截短
   */
  const evaluateRunExpect = async (
    expect: FrozenRunExpect,
  ): Promise<
    | { readonly outcome: "met" }
    | { readonly outcome: "expectation" }
    | { readonly outcome: "budget" }
    | { readonly outcome: "error"; readonly error: ComputerError }
  > => {
    const expectStartedAt = Date.now();
    const deadline = Math.min(expectStartedAt + expect.timeoutMs, runDeadline);
    if (expect.kind === "window") {
      // window 断言走 roots 轮询（与 computer_wait 的 window 分支同语义）：快照回答不了「别的根在不在」，
      // 首轮（不睡）就问一次 roots；不碰树，treeFresh 不参与
      const condition: Extract<WaitCondition, { readonly kind: "window" }> = {
        kind: "window",
        until: expect.until,
        ...(expect.rootKey !== undefined ? { ref: expect.ref, rootKey: expect.rootKey } : {}),
        ...(expect.title !== undefined ? { title: expect.title } : {}),
        ...(expect.app !== undefined ? { app: expect.app } : {}),
      };
      const wanted = expect.until === "present";
      let round = 0;
      for (;;) {
        // round 0 也判预算：动作步超预算后进断言，先看 deadline 再发第一轮 roots（也是桥调用）
        if (Date.now() >= deadline) break;
        if (round > 0) {
          const remaining = deadline - Date.now();
          await waitSleepSlices(
            Math.min(computerWaitPollDelayMs(Date.now() - expectStartedAt, round - 1), remaining),
            run.signal,
            () => {},
            "computer_run",
          );
          if (Date.now() >= deadline) break;
        }
        throwIfRunAborted(run.signal);
        const discovered = await backend.roots();
        if (!discovered.ok) return { outcome: "error", error: discovered.error };
        if (windowRootFound(discovered.data, condition) === wanted) return { outcome: "met" };
        round += 1;
      }
      return Date.now() >= runDeadline ? { outcome: "budget" } : { outcome: "expectation" };
    }
    const wanted = expect.until === "present";
    const scope = expect.scope;
    // 免桥首判（treeFresh 门槛）：手头树新鲜才直接判（上一步动作回执/轮询观察，或还没树时的调用方快照）；
    // probe 命中过的树只是历史证据，拿它判 absent 会假命中（树之后界面可能又变了）
    if (treeFresh) {
      if (lastTree !== undefined) {
        if (observedTextFound(flattenObservedComputerTree(lastTree), expect.text, scope?.identity) === wanted) {
          return { outcome: "met" };
        }
      } else if (
        snapshotScopeNodes(snapshot, expect.scopeNode).some(
          (node) => scoreComputerNodeText(node, expect.text) !== undefined,
        ) === wanted
      ) {
        return { outcome: "met" };
      }
    } else if (Date.now() < deadline) {
      // 树不新鲜就先观察一轮再判：判 met 需要新鲜证据，过时树对 absent 恒不可信
      const observed = await backend.observe(root.key);
      if (!observed.ok) return { outcome: "error", error: observed.error };
      lastTree = observed.data.tree;
      treeFresh = true;
      if (observedTextFound(flattenObservedComputerTree(lastTree), expect.text, scope?.identity) === wanted) {
        return { outcome: "met" };
      }
    }
    let round = 0;
    for (;;) {
      // round 0 也判预算：动作步超预算后进断言，不再烧第一轮探测的桥超时（probe 与观察都是桥调用）
      if (Date.now() >= deadline) break;
      if (round > 0) {
        const remaining = deadline - Date.now();
        await waitSleepSlices(
          Math.min(computerWaitPollDelayMs(Date.now() - expectStartedAt, round - 1), remaining),
          run.signal,
          () => {},
          "computer_run",
        );
        if (Date.now() >= deadline) break;
      }
      throwIfRunAborted(run.signal);
      if (probeUsable) {
        const probed = await backend.probe({
          rootKey: root.key,
          text: expect.text,
          ...(scope !== undefined
            ? {
                path: scope.identity.path,
                role: scope.identity.role,
                ...(scope.identity.name !== undefined ? { name: scope.identity.name } : {}),
              }
            : {}),
        });
        if (probed.ok) {
          if (probed.data === wanted) {
            // probe 命中只证明条件在场：手头的树可能已落后于界面，收口前要补一次观察
            treeFresh = false;
            return { outcome: "met" };
          }
        } else if (probed.error.code === "capability_unsupported" || probed.error.code === "invalid_params") {
          probeUsable = false;
          console.warn(
            `[pi-computer] computer_run: native text probe unavailable (${probed.error.code}` +
              `${probed.error.detail === undefined ? "" : `: ${probed.error.detail}`}); falling back to observe polling`,
          );
        } else {
          return { outcome: "error", error: probed.error };
        }
      }
      if (!probeUsable) {
        const observed = await backend.observe(root.key);
        if (!observed.ok) return { outcome: "error", error: observed.error };
        lastTree = observed.data.tree;
        treeFresh = true;
        if (observedTextFound(flattenObservedComputerTree(lastTree), expect.text, scope?.identity) === wanted) {
          return { outcome: "met" };
        }
      }
      round += 1;
    }
    // 到期收口：先分清是断言自己的超时还是整体预算耗尽
    return Date.now() >= runDeadline ? { outcome: "budget" } : { outcome: "expectation" };
  };

  /**
   * 结束收口（成功与失败同一路）：恰物化一份快照作为顶层 stateId；
   * 收口观察失败按容忍口径（参照 computer_wait 的 settle）：回 status 与提示、不带 stateId，
   * 不把整次 run 判死；动作日志写失败的标注随收据带回
   */
  const finish = async (
    status: ComputerRunData["status"],
    options: { readonly failedStep?: number; readonly error?: ComputerError } = {},
  ): Promise<AgentToolResult<ToolDetails<ComputerRunData>>> => {
    const effectsUnknown = options.error !== undefined && runEffectsUnknown(options.error);
    // 补一次观察拿结束现场：只有「手头树可能落后」时才补；桥已判病（结果未知类错误）不雪上加霜
    let closingObservationFailed = false;
    if (!treeFresh && !effectsUnknown) {
      const observed = await backend.observe(root.key);
      if (observed.ok) {
        lastTree = observed.data.tree;
        treeFresh = true;
      } else {
        closingObservationFailed = true;
        console.warn(
          `[pi-computer] computer_run: the closing observe failed (${observed.error.code}` +
            `${observed.error.detail === undefined ? "" : `: ${observed.error.detail}`}); returning no stateId`,
        );
      }
    }
    // 恰一份物化：手头有树就建快照（效果未知时最后一次回执树也物化，回执已提示它可能过时）；
    // 全程没拿到过树且收口没失败就沿用调用方 stateId（它仍当前）；收口观察失败就不给 stateId
    let stateId: ComputerStateId | undefined;
    if (lastTree !== undefined) {
      stateId = state.observe({ root: snapshot.root, tree: lastTree }).stateId;
    } else if (!closingObservationFailed) {
      stateId = params.stateId;
    }
    const data: ComputerRunData = {
      ...(stateId !== undefined ? { stateId } : {}),
      status,
      completed,
      steps: [...stepResults],
      ...(options.failedStep !== undefined ? { failedStep: options.failedStep } : {}),
      effectsUnknown,
    };
    const text = cap(
      `${renderRun(data, frozen.length, {
        // 沿用调用方 stateId 时换掉「旧引用已陈旧」的泛泛提示：根本没有新快照，那句话会误导
        reusedStateId: stateId === params.stateId,
        // 在途取消的回执要点名取消本身：只落 bridge_timeout 码讲不清动作可能已生效、结果未知
        cancelledInFlight: options.error === RUN_CANCELLED_IN_FLIGHT,
      })}${logNotes.join("")}`,
    );
    return success(data, text.text);
  };

  for (const [index, step] of frozen.entries()) {
    const stepNumber = index + 1;
    // 预算先行：不够开一步就停批，如实报 timeout（本步未开跑，steps 里没有它的条目）
    if (Date.now() >= runDeadline) {
      return finish("timeout", { failedStep: stepNumber });
    }

    if (step.actions.length > 0) {
      throwIfRunAborted(run.signal);
      const actPromise = Promise.resolve(backend.act({ rootKey: root.key, actions: step.actions }));
      // 取消竞态下桥侧拒绝不得变成未处理拒绝（赢不了赛跑的 promise 也要挂上处理）
      actPromise.catch(() => undefined);
      const receipt = await raceRunActWithAbort(actPromise, run.signal);
      if (receipt === "cancelled") {
        stepResults.push({ ok: false, error: RUN_CANCELLED_IN_FLIGHT });
        try {
          await actionLog(
            logEntries(params.stateId, snapshot.root, root.key, step.actions, {
              ok: false,
              error: RUN_CANCELLED_IN_FLIGHT,
            }),
          );
        } catch {
          // 取消收尾时日志写不上就不写：收据已按结果未知回报，不再多一条标注
        }
        return finish("failed", { failedStep: stepNumber, error: RUN_CANCELLED_IN_FLIGHT });
      }
      // 动作日志沿用 act 口径：派发出去的动作逐条记，成功失败都记；写失败不改结果，只在文本里标注
      try {
        await actionLog(logEntries(params.stateId, snapshot.root, root.key, step.actions, receipt));
      } catch (error) {
        logNotes.push(`\n[action log write failed: ${describeError(error)}]`);
      }
      if (!receipt.ok) {
        stepResults.push({ ok: false, error: receipt.error });
        // 失败步意味着界面已不在手头树的口径上（或动作结果未知）：收口前补一次观察拿现场
        treeFresh = false;
        return finish("failed", { failedStep: stepNumber, error: receipt.error });
      }
      lastTree = receipt.data.tree;
      treeFresh = true;
    }

    if (step.expect !== undefined) {
      // 安全点取消（与动作步同纪律）：expect-only 步在免桥首判前也查 signal——Esc 后不应回 completed
      throwIfRunAborted(run.signal);
      const outcome = await evaluateRunExpect(step.expect);
      if (outcome.outcome === "budget") {
        treeFresh = false;
        return finish("timeout", { failedStep: stepNumber });
      }
      if (outcome.outcome === "error") {
        stepResults.push({ ok: false, error: outcome.error });
        treeFresh = false;
        return finish("failed", { failedStep: stepNumber, error: outcome.error });
      }
      if (outcome.outcome === "expectation") {
        const error: ComputerError = {
          code: "expectation_failed",
          detail: `expected ${describeRunExpect(step.expect)} was not satisfied within ${step.expect.timeoutMs}ms`,
        };
        stepResults.push({ ok: false, error });
        // 断言失败要物化当时现场：收口前补一次观察
        treeFresh = false;
        return finish("failed", { failedStep: stepNumber, error });
      }
    }

    stepResults.push({ ok: true });
    completed += 1;
  }
  return finish("completed");
}

// ---------------------------------------------------------------------------
// 带图观察（工单 19）：采集预算、回执收窄与失败清理
// ---------------------------------------------------------------------------

/** 超预算后最多再缩图重采几次：给高熵画面留余地，但不能变成无限重试 */
const CAPTURE_MAX_RESAMPLES = 3;
/** 重采目标按预算的 90% 反算：给 PNG 压缩率波动留头寸，免得刚好卡线再重采一次 */
const CAPTURE_BUDGET_HEADROOM = 0.9;

/**
 * 按宿主图片预算采集一张窗口图（工单 19）：先按 COMPUTER_CAPTURE_LONG_EDGE 采；
 * base64 长度超 COMPUTER_IMAGE_BASE64_BUDGET 就收紧长边重采（最多 CAPTURE_MAX_RESAMPLES 次）。
 * 失败必删图：本函数任何失败返回都先尽力删掉 path 处已落盘的文件，这是失败清理的单一出口，
 * 调用方在采集失败路径上不用再关心清理。缩到下限仍超只能是异常（元数据与图像对不上等），
 * 如实回 action_failed + detail，不假装图能用。
 */
async function captureWithBudget(
  backend: ComputerBackend,
  rootKey: string,
  path: string,
): Promise<ComputerResult<ComputerCaptureRecord>> {
  const fail = (error: ComputerError): ComputerResult<ComputerCaptureRecord> => {
    removeScreenshot(path);
    return { ok: false, error };
  };
  let maxLongEdge = COMPUTER_CAPTURE_LONG_EDGE;
  let resamples = 0;
  for (;;) {
    const captured = await backend.capture({ target: { kind: "window", key: rootKey }, path, maxLongEdge });
    if (!captured.ok) return fail(captured.error);
    const base64Length = base64LengthOf(captured.data.image.bytes);
    // 严格小于：Pi read 是 inputBase64Size < maxBytes 才不缩放，等于也会触发缩放，口径保持与它一致
    if (base64Length < COMPUTER_IMAGE_BASE64_BUDGET) return captured;

    const actualLongEdge = Math.max(captured.data.image.width, captured.data.image.height);
    const atFloor = actualLongEdge <= COMPUTER_CAPTURE_MIN_LONG_EDGE;
    if (resamples >= CAPTURE_MAX_RESAMPLES || atFloor) {
      // 两种停手原因分开说：次数用尽时最后一次长边可能离下限还很远，不能都写成「缩到 320 下限」
      const reason = atFloor
        ? `already at the ${COMPUTER_CAPTURE_MIN_LONG_EDGE}px long-edge floor after ${resamples} resample(s)`
        : `gave up after ${resamples} resample(s) (last long edge ${actualLongEdge}px)`;
      return fail({
        code: "action_failed",
        detail: `capture is still ${base64Length} base64 bytes, over the ${COMPUTER_IMAGE_BASE64_BUDGET}-byte host image budget; ${reason}`,
      });
    }
    // 长边按面积近似缩放：base64 长度≈像素数，sqrt(预算/实长) 把长边收到预算内，再打九折留头寸
    const target = Math.floor(
      actualLongEdge * Math.sqrt((CAPTURE_BUDGET_HEADROOM * COMPUTER_IMAGE_BASE64_BUDGET) / base64Length),
    );
    const tightened = Math.min(actualLongEdge - 1, Math.max(COMPUTER_CAPTURE_MIN_LONG_EDGE, target));
    // 收紧不动（实际长边不受请求约束）就没有再采的意义，直接按失败上报，别空转
    if (tightened >= maxLongEdge) {
      return fail({
        code: "action_failed",
        detail:
          `capture stays over the host image budget and tightening makes no progress: ` +
          `the reported long edge ${actualLongEdge}px is already over the requested long edge ${maxLongEdge}px`,
      });
    }
    resamples += 1;
    maxLongEdge = tightened;
  }
}

/** base64 长度按 3 字节一组打包：ceil(bytes/3)*4，与 Pi read 的图片预算同口径 */
function base64LengthOf(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

/** 采集记录收窄成模型面回执：只挑 path/image/region/source/mayBeObscured，window/display 不外传 */
function toObserveCapture(capture: ComputerCaptureRecord): ComputerObserveCapture {
  return {
    path: capture.path,
    image: { ...capture.image },
    region: { ...capture.region },
    ...(capture.source !== undefined ? { source: capture.source } : {}),
    ...(capture.mayBeObscured !== undefined ? { mayBeObscured: capture.mayBeObscured } : {}),
  };
}

// ---------------------------------------------------------------------------
// 结果装配与文本渲染
// ---------------------------------------------------------------------------

function success<T>(data: T, text: string): AgentToolResult<ToolDetails<T>> {
  return { content: [{ type: "text", text }], details: { ok: true, data } };
}

function failure<T>(t: Translator, tool: string, error: ComputerError, note = ""): AgentToolResult<ToolDetails<T>> {
  // 错误说明按错误码查三语键表；detail 是原生层给的自由文本，同样要过文本预算
  const message = t(COMPUTER_ERROR_MESSAGE_KEYS[error.code]);
  const detail = error.detail === undefined ? "" : `\nDetail: ${error.detail}`;
  const text = cap(`${tool} failed with ${error.code}: ${message}${detail}${note}`);
  return { content: [{ type: "text", text: text.text }], details: { ok: false, error } };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isHighSurrogate(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * 把模型可见文本按行截断到预算以内（details 里的结构不动，截断只发生在文本上）。
 * 预算与提示语由调用方给：大纲超预算时要指路 computer_search，通用文本只要提示收窄。
 */
function cap(
  text: string,
  budget: number = COMPUTER_TEXT_BUDGET,
  marker: string = TRUNCATED_MARKER,
): { readonly text: string; readonly truncated: boolean } {
  if (text.length <= budget) return { text, truncated: false };
  const cut = text.slice(0, budget);
  const lastNewline = cut.lastIndexOf("\n");
  const body = lastNewline > 0 ? cut.slice(0, lastNewline) : cut;
  return { text: `${body}\n${marker}`, truncated: true };
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

function renderStatus(data: ComputerStatusData): string {
  const caps = data.capabilities;
  const permissions = Object.entries(caps.permissions)
    .map(([name, value]) => `${name}=${value}`)
    .join(", ");
  return [
    `platform: ${caps.platform}`,
    `accessibility: ${yesNo(caps.accessibility)}`,
    `capture: ${yesNo(caps.capture)}`,
    `input: ${yesNo(caps.input)}`,
    `coordinate mode: ${caps.coordinateMode}`,
    `background input: ${caps.backgroundInput}`,
    `permissions: ${permissions}`,
    `native helper: ${data.bridge.ready ? "ready" : "not ready"} (protocol version: ${data.bridge.protocolVersion ?? "none"})`,
    `limits: ${caps.limits.length > 0 ? caps.limits.join("; ") : "(none reported)"}`,
  ].join("\n");
}

function renderRoots(roots: readonly ComputerRootSummary[]): string {
  if (roots.length === 0) return "No operable roots. Make sure the target application is running.";
  return [
    ...roots.map(
      (root) => `${root.ref} ${root.kind} "${root.title}" - ${root.app}${root.focused ? " (focused)" : ""}`,
    ),
    "Roots are discovery only: observe one with computer_observe to get a stateId.",
  ].join("\n");
}

function renderObservation(data: ComputerObserveData): string {
  const lines = [
    `stateId: ${data.stateId}`,
    `root: ${data.root}, nodes: ${data.nodeCount}${data.truncated ? " (truncated)" : ""}`,
    ...(data.capture !== undefined ? [renderCapture(data.capture)] : []),
    data.outline,
  ];
  if (data.previousStateId !== undefined) {
    lines.push(`changes since ${data.previousStateId}:`);
    lines.push(...(data.changes.length > 0 ? data.changes.map(renderChange) : ["(none)"]));
  }
  lines.push("Refs (@rN/@eN) are valid only for this stateId; refs from the previous state are stale.");
  return lines.join("\n");
}

/** 带图观察的图片信息行：路径 + 图面尺寸/缩放 + 采集区域，屏幕回退时标出遮挡风险 */
function renderCapture(capture: ComputerObserveCapture): string {
  const region = capture.region;
  const fallback = capture.source === "screen_region" ? " - screen fallback, may be obscured by other windows" : "";
  return (
    `image: ${capture.path} (${capture.image.width}x${capture.image.height}, scale ${capture.image.scale}) ` +
    `region x=${region.x} y=${region.y} w=${region.width} h=${region.height}${fallback}; node bounds are pixels of this image`
  );
}

function renderChange(change: ComputerStateChange): string {
  return `- ${change.kind} ${change.ref} ${change.summary}`;
}

function renderSearch(data: ComputerSearchData, params: SearchParams): string {
  const query = [
    params.text === undefined ? undefined : `text=${JSON.stringify(params.text)}`,
    params.role === undefined ? undefined : `role=${params.role}`,
  ]
    .filter((part) => part !== undefined)
    .join(", ");
  if (data.matches.length === 0) return `No match for ${query} in this state.`;
  const lines = data.matches.map(renderNodeLine);
  if (data.total > data.matches.length) {
    lines.push(`... showing ${data.matches.length} of ${data.total} matches; raise limit or narrow the query`);
  }
  return lines.join("\n");
}

function renderNodeLine(node: ComputerNodeSummary): string {
  const name = node.name === undefined ? "" : ` "${node.name}"`;
  const value = node.value === undefined ? "" : ` = "${node.value}"`;
  return `${node.ref} ${node.role}${name}${value}`;
}

function renderAct(data: ComputerActData, nativeTruncated: boolean): string {
  const lines = [
    `stateId: ${data.stateId}`,
    "changes:",
    ...(data.changes.length > 0 ? data.changes.map(renderChange) : ["(none)"]),
  ];
  // 原生树被规模上限截断时差异可能不全，如实标注，别让模型把残缺当全部
  if (nativeTruncated) {
    lines.push("note: the native tree was truncated at its size limit; changes may be incomplete");
  }
  lines.push("Continue with this stateId; refs from the previous state are stale.");
  return lines.join("\n");
}

function renderInspect(data: ComputerInspectData): string {
  const node = data.node;
  const name = node.name === undefined ? "" : ` "${node.name}"`;
  const value = node.value === undefined ? "" : ` value="${node.value}"`;
  const bounds =
    node.bounds === undefined
      ? ""
      : `; bounds: x=${node.bounds.x} y=${node.bounds.y} w=${node.bounds.width} h=${node.bounds.height}`;
  const lines = [
    `${node.ref} ${node.role}${name}${value}`,
    `enabled: ${yesNo(node.enabled)}; focused: ${yesNo(node.focused)}${bounds}`,
  ];
  if (node.description !== undefined) lines.push(`description: ${node.description}`);
  lines.push(`actions: ${node.actions.length > 0 ? node.actions.join(", ") : "(none)"}`);
  lines.push(`subtree: ${data.nodeCount} node(s)${data.truncated ? " (folded or truncated)" : ""}`);
  lines.push(data.outline);
  return lines.join("\n");
}

function renderRead(node: ComputerSnapshotNode, data: ComputerReadData, offset: number, totalChars: number): string {
  const name = node.name === undefined ? "" : ` "${node.name}"`;
  const where = `${node.ref} ${node.role}${name}`;
  if (totalChars === 0) return `${where}: (no text)`;
  if (data.text.length === 0) {
    return `${where}: empty page — the text has ${totalChars} characters and offset ${offset} is past its end`;
  }
  const lines = [`${where}: characters ${offset + 1}-${offset + data.text.length} of ${totalChars}`, data.text];
  if (data.nextOffset !== undefined) lines.push(`... more text; continue with offset ${data.nextOffset}`);
  return lines.join("\n");
}

/** computer_wait 的模型可见回执：命中/超时/纯延时三种口径都过同一个渲染器与同一个文本预算 */
function renderWait(
  data: ComputerWaitData,
  condition: WaitCondition,
  closingObservationFailed = false,
): string {
  const lines = [
    `met: ${yesNo(data.met)}`,
    `condition: ${describeWaitCondition(condition)}`,
    `elapsed: ${data.elapsedMs}ms${data.met ? "" : " (timed out)"}`,
  ];
  if (data.stateId !== undefined) {
    lines.push(`stateId: ${data.stateId}`);
    lines.push(
      data.met
        ? "Continue with this stateId; refs from the previous state are stale."
        : "The condition was not met before the timeout; this is the last observation during the wait.",
    );
  } else if (!data.met) {
    // 无 stateId 的超时：收口观察失败时要说清为什么没有现场，模型才知道去 observe 一次
    lines.push(
      closingObservationFailed
        ? "The condition was not met before the timeout; the closing observation failed, so no final stateId is available. Call computer_observe to see the current interface."
        : "The condition was not met before the timeout; the interface may still be busy.",
    );
  } else {
    // 命中但无 stateId：快照首判命中 / window 模式 / 纯延时 / 收口观察失败，各自的下一步不一样
    if (condition.kind === "text")
      lines.push(
        closingObservationFailed
          ? "The wait settled, but the closing observation failed, so no stateId was produced. Call computer_observe to get current state."
          : "Satisfied by the given snapshot; no new observation was taken.",
      );
    if (condition.kind === "window") lines.push("Call computer_roots to pick up the change, then observe the root you need.");
    if (condition.kind === "delay") lines.push("A pure delay produces no new state; call computer_observe before acting again.");
  }
  // 条件行会回显调用方给的 text/title/app：统一过 cap，超长参数不得原样回灌
  return cap(lines.join("\n")).text;
}

/** computer_run 的模型可见回执：状态、步数、失败步与顶层 stateId 的下一步指引都过同一个文本预算 */
function renderRun(
  data: ComputerRunData,
  totalSteps: number,
  options: { readonly reusedStateId?: boolean; readonly cancelledInFlight?: boolean } = {},
): string {
  const lines = [`status: ${data.status}`, `steps: ${data.completed} of ${totalSteps} completed`];
  if (data.steps.length > 0) {
    lines.push(
      `step results: ${data.steps
        .map((step) => (step.ok ? "ok" : `failed (${step.error?.code ?? "unknown"})`))
        .join(", ")}`,
    );
  }
  if (data.failedStep !== undefined) {
    const failed = data.steps[data.failedStep - 1];
    if (failed !== undefined && !failed.ok && failed.error?.code === "expectation_failed") {
      lines.push(
        `step ${data.failedStep} failed: ${failed.error.detail ?? "expectation not met"}; ` +
          `${data.completed} step(s) completed before it`,
      );
    } else if (failed !== undefined && !failed.ok) {
      lines.push(`step ${data.failedStep} failed with ${failed.error?.code ?? "unknown"}`);
    } else {
      lines.push(`the run stopped at step ${data.failedStep}`);
    }
  }
  if (data.stateId === undefined) {
    // 收口观察失败（容忍口径）：说清为什么没有现场，模型才知道去 observe 一次
    lines.push(
      "The closing observation failed, so no final stateId is available. Call computer_observe to see the " +
        "current interface before acting.",
    );
  } else {
    lines.push(`stateId: ${data.stateId}`);
  }
  if (data.effectsUnknown) {
    lines.push(
      options.cancelledInFlight
        ? "The run was cancelled while a step's actions were in flight: whether they took effect is unknown. " +
            "This stateId may already be out of date — observe the root again before acting."
        : "Effects are unknown: this stateId may already be out of date — observe the root again before acting.",
    );
  } else if (data.stateId !== undefined && options.reusedStateId) {
    // 沿用调用方 stateId：没有新快照，泛泛的「上一状态的引用已陈旧」会误导
    lines.push(
      data.status === "completed"
        ? "No step needed a new observation; the stateId above is the one passed to this call and is still current."
        : "The run stopped without a new observation; the stateId above is the one passed to this call.",
    );
  } else if (data.stateId !== undefined && data.status === "completed") {
    lines.push("Continue with this stateId; refs from the previous state are stale.");
  } else if (data.stateId !== undefined && data.status === "timeout") {
    lines.push(
      "The overall budget ran out; this stateId is the last trusted observation — observe again before continuing.",
    );
  } else if (data.stateId !== undefined) {
    lines.push("This stateId is the scene at the moment the run stopped; refs from the previous state are stale.");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 状态层适配：根选择、作用域检查、搜索与引用解析
// ---------------------------------------------------------------------------

/** 观察的目标根：给了 @rN 就用它；没给就取最前面的（focused 优先） */
function pickRoot(
  state: ComputerStateStore,
  discovered: readonly ComputerRootSummary[],
  requested: string | undefined,
): ComputerResult<{ readonly ref: RootRef; readonly key: string }> {
  if (requested === undefined) {
    const index = discovered.findIndex((root) => root.focused);
    const first = discovered[index >= 0 ? index : 0];
    if (!first) {
      return { ok: false, error: { code: "target_not_found", detail: "no operable root was found to observe" } };
    }
    // registerRoots 只回摘要，观察还要后端认的稳定 key，按 @rN 回查一次
    const registered = state.findRoot(first.ref);
    if (!registered) {
      return { ok: false, error: { code: "target_not_found", detail: `root ${first.ref} was not registered` } };
    }
    return { ok: true, data: { ref: registered.ref, key: registered.key } };
  }
  const registered = state.findRoot(requested);
  if (!registered) {
    return {
      ok: false,
      error: {
        code: "target_not_found",
        detail: `${requested} is not a known root; call computer_roots again and use one of the returned refs`,
      },
    };
  }
  return { ok: true, data: { ref: registered.ref, key: registered.key } };
}

/** 查询类工具的作用域检查：stateId 必须是当前快照，否则它的引用已经没用了 */
function currentSnapshot(state: ComputerStateStore, stateId: string): ComputerResult<ComputerSnapshot> {
  const snapshot = state.snapshotOf(stateId);
  if (!snapshot || !state.isCurrent(stateId)) {
    return {
      ok: false,
      error: { code: "stale_ref", detail: `state ${stateId} is not the current observation; observe the root again` },
    };
  }
  return { ok: true, data: snapshot };
}

/**
 * 细看与读取类工具共用的一段校验：stateId 必须是当前快照，引用要在当前快照里解析。
 * elementOnly 为 true 时只收元素引用，read 允许根本身（读窗口文本）；重复的拒绝文案收敛在这里。
 */
function resolveSnapshotRef(
  state: ComputerStateStore,
  stateId: string,
  ref: string,
  options: { readonly elementOnly: boolean },
): ComputerResult<{ readonly snapshot: ComputerSnapshot; readonly node: ComputerSnapshotNode }> {
  const snapshot = currentSnapshot(state, stateId);
  if (!snapshot.ok) return snapshot;
  const resolved = state.resolveRef(stateId, ref);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  if (options.elementOnly && resolved.kind !== "element") {
    return {
      ok: false,
      error: {
        code: "invalid_params",
        detail: `${ref} is a root reference; this tool reads elements, pass an @eN reference`,
      },
    };
  }
  return { ok: true, data: { snapshot: snapshot.data, node: resolved.node } };
}

/** 搜索快照里的元素（根不参与：它是观察对象本身）。文本命中位置决定排序，同分保持前序；
 * 评分口径抽在 state.ts 的 scoreComputerNodeText（工单 28），与 computer_wait 轮询共用同一套文本语义 */
function searchSnapshot(snapshot: ComputerSnapshot, query: SearchParams): readonly ComputerSnapshotNode[] {
  const role = query.role?.toLowerCase();
  const scored: { readonly node: ComputerSnapshotNode; readonly score: number }[] = [];
  for (const node of snapshot.nodes) {
    if (node.depth === 0) continue;
    if (role !== undefined && node.role.toLowerCase() !== role) continue;
    if (query.text === undefined) {
      scored.push({ node, score: 0 });
      continue;
    }
    const score = scoreComputerNodeText(node, query.text);
    if (score !== undefined) scored.push({ node, score });
  }
  // Array.prototype.sort 是稳定排序，同分保持快照的前序遍历顺序
  return scored.sort((a, b) => a.score - b.score).map((entry) => entry.node);
}

function toNodeSummary(node: ComputerSnapshotNode): ComputerNodeSummary {
  return {
    // 搜索排除了根，这里的引用一定是元素引用
    ref: node.ref as ElementRef,
    role: node.role,
    ...(node.name !== undefined ? { name: node.name } : {}),
    ...(node.value !== undefined ? { value: node.value } : {}),
  };
}

/** 元素详情：从快照节点收窄成 ComputerNodeInspection，缺省字段不补空值 */
function inspectSnapshotNode(snapshot: ComputerSnapshot, node: ComputerSnapshotNode): ComputerInspectData {
  const view = renderComputerOutline(snapshot, node);
  const outline = cap(view.outline, COMPUTER_OUTLINE_BUDGET, OUTLINE_TRUNCATED_MARKER);
  const inspection: ComputerNodeInspection = {
    ref: node.ref as ElementRef,
    role: node.role,
    ...(node.name !== undefined ? { name: node.name } : {}),
    ...(node.value !== undefined ? { value: node.value } : {}),
    ...(node.description !== undefined ? { description: node.description } : {}),
    enabled: node.enabled,
    focused: node.focused,
    ...(node.bounds ? { bounds: { ...node.bounds } } : {}),
    actions: [...node.actions],
  };
  return {
    node: inspection,
    outline: outline.text,
    nodeCount: view.total,
    truncated: view.folded || outline.truncated,
  };
}

/** computer_read 的文本源：text 优先，缺省回退到 value、name（工单 06 定的回退链） */
function nodeText(node: ComputerSnapshotNode): string {
  return node.text ?? node.value ?? node.name ?? "";
}

/**
 * 观察前的能力门（工单 06）：先读后端能力，桥就绪但不支持无障碍树时明确报 capability_unsupported，
 * 而不是让 observe 返回一棵空树。桥没就绪交给后面的 roots/observe 调用报 bridge_unavailable，原因更准。
 */
async function treeCapabilityError(backend: ComputerBackend): Promise<ComputerError | undefined> {
  const status = await backend.status();
  if (!status.ok) return status.error;
  if (status.data.bridge.ready && !status.data.capabilities.accessibility) {
    return {
      code: "capability_unsupported",
      detail: "the native helper reports accessibility=false: no semantic tree to observe in this session",
    };
  }
  return undefined;
}

/** 一批派发出去的动作 → 日志条目；整批共用一个时间戳与结果 */
function logEntries(
  stateId: ComputerStateId,
  rootRef: RootRef,
  rootKey: string,
  actions: readonly ComputerBackendAction[],
  receipt: ComputerResult<ComputerBackendObservation>,
): readonly ComputerActionLogEntry[] {
  const outcome: "ok" | ComputerErrorCode = receipt.ok ? "ok" : receipt.error.code;
  const detail = receipt.ok ? undefined : receipt.error.detail;
  const time = new Date().toISOString();
  return actions.map((entry) => ({
    time,
    stateId,
    rootKey,
    rootRef,
    command: entry.command,
    ...(entry.target ? { target: entry.target } : {}),
    outcome,
    ...(detail !== undefined ? { detail } : {}),
  }));
}

/**
 * 把契约动作解析成后端动作：先按动作目录校验目标形态与必填字段（缺目标一律 invalid_params，
 * 不允许对「当前焦点」盲动），再用状态层解析引用；任何一条不合法就整批拒绝，一个动作都不发。
 * 坐标动作的图面像素在这里按快照绑定的采集记录换成虚拟桌面物理像素（工单 21）：
 * 后端与桥不认识图面坐标系，上桥的坐标一律是桌面物理像素。
 */
function prepareActions(
  state: ComputerStateStore,
  stateId: string,
  snapshot: ComputerSnapshot,
  actions: readonly ComputerAction[],
): ComputerResult<readonly ComputerBackendAction[]> {
  const prepared: ComputerBackendAction[] = [];
  for (const [index, action] of actions.entries()) {
    const problem = validateAction(action);
    if (problem) {
      return {
        ok: false,
        error: { code: problem.code, detail: `action ${index + 1} (${action.action}): ${problem.detail ?? ""}` },
      };
    }
    let target: ComputerBackendTarget | undefined;
    if (action.ref !== undefined) {
      const resolved = state.resolveRef(stateId, action.ref);
      if (!resolved.ok) return { ok: false, error: resolved.error };
      target = {
        path: snapshotPath(snapshot, resolved.node),
        role: resolved.node.role,
        ...(resolved.node.name !== undefined ? { name: resolved.node.name } : {}),
      };
    }
    let command: ComputerAction = action;
    if (action.x !== undefined) {
      const converted = convertActionPoint(snapshot, action, index);
      if (!converted.ok) return { ok: false, error: converted.error };
      command = converted.data;
    }
    prepared.push({ command, ...(target ? { target } : {}) });
  }
  return { ok: true, data: prepared };
}

/**
 * 图面像素 → 虚拟桌面物理像素：坐标动作必须绑定带图快照（工单 21），
 * 无采集记录或记录几何不构成可换算的图时回 invalid_params，提示先带图观察。
 */
function convertActionPoint(
  snapshot: ComputerSnapshot,
  action: ComputerAction,
  index: number,
): ComputerResult<ComputerAction> {
  const capture = snapshot.capture;
  if (capture === undefined) {
    return {
      ok: false,
      error: {
        code: "invalid_params",
        detail:
          `action ${index + 1} (${action.action}): coordinate actions need the stateId of an observation taken ` +
          "with capture: true; this state has no image, observe again with capture",
      },
    };
  }
  const frame = imageFrameOf(capture);
  if (frame === undefined) {
    return {
      ok: false,
      error: {
        code: "invalid_params",
        detail:
          `action ${index + 1} (${action.action}): the capture bound to this state cannot be used for coordinate ` +
          "conversion; observe again with capture: true",
      },
    };
  }
  const start = imagePointToDesktop(frame, action.x!, action.y!);
  const end =
    action.toX !== undefined && action.toY !== undefined
      ? imagePointToDesktop(frame, action.toX, action.toY)
      : undefined;
  return {
    ok: true,
    data: {
      ...action,
      x: start.x,
      y: start.y,
      ...(end !== undefined ? { toX: end.x, toY: end.y } : {}),
    },
  };
}

/**
 * 逻辑字段（contract 的 COMPUTER_ACTION_FIELDS）→ 必填判定与提示。
 * ref 不在这里，它由目标形态（上面按 target 判的那一段）负责。
 */
const REQUIRED_FIELD_RULES: Readonly<
  Record<
    Exclude<ComputerActionField, "ref">,
    { readonly present: (action: ComputerAction) => boolean; readonly detail: string }
  >
> = {
  point: { present: (action) => action.x !== undefined && action.y !== undefined, detail: "needs x and y" },
  to: {
    present: (action) => action.toX !== undefined && action.toY !== undefined,
    detail: "needs toX and toY (the drag end)",
  },
  delta: {
    present: (action) => action.deltaX !== undefined || action.deltaY !== undefined,
    detail: "needs deltaX or deltaY",
  },
  text: { present: (action) => action.text !== undefined, detail: "needs text" },
  keys: {
    present: (action) => action.keys !== undefined && action.keys.length > 0,
    detail: "needs a non-empty keys array",
  },
  // button/count 是可选修饰（只在坐标点击上生效），没有任何动作把它们列为必填；
  // 登记在这里只为填满 Record 的键面，present 永远不会被 requires 消费
  button: { present: (action) => action.button !== undefined, detail: "needs button" },
  count: { present: (action) => action.count !== undefined, detail: "needs count" },
};

/**
 * 动作目录校验：目标形态、坐标成对、必填字段。返回 undefined 表示合法。
 * 目标形态与动作要求的对不上时一律拒绝，不管多余的字段是被忽略还是会被后端用上：
 * 模型同时给引用和坐标，说明意图不确定，静默挑一个执行比报错更贵。
 */
function validateAction(action: ComputerAction): ComputerError | undefined {
  const contract = COMPUTER_ACTION_CONTRACTS[action.action];
  if (!contract) return { code: "invalid_params", detail: "unknown action" };
  const parsed = action.ref === undefined ? undefined : parseComputerRef(action.ref);
  if (action.ref !== undefined && !parsed) {
    return { code: "invalid_params", detail: `ref ${action.ref} is not a valid @rN/@eN reference` };
  }
  const hasPoint = action.x !== undefined || action.y !== undefined;
  switch (contract.target) {
    case "element":
      if (!parsed) return { code: "invalid_params", detail: "needs an explicit element target: pass ref @eN" };
      if (parsed.kind !== "element") {
        return { code: "invalid_params", detail: `needs an element target (@eN), got the root reference ${action.ref}` };
      }
      if (hasPoint) return { code: "invalid_params", detail: "this action takes a ref, not coordinates" };
      break;
    case "window":
      if (!parsed) {
        return {
          code: "invalid_params",
          detail: "needs an explicit target window: pass ref @rN; keyboard input is never sent to the current focus",
        };
      }
      if (parsed.kind !== "root") {
        return { code: "invalid_params", detail: `keyboard input needs a window target (@rN), got ${action.ref}` };
      }
      // 坐标类字段一律拒（x/y 与 toX/toY/deltaX/deltaY 同口径）：键盘动作只认窗口引用
      if (
        hasPoint ||
        action.toX !== undefined ||
        action.toY !== undefined ||
        action.deltaX !== undefined ||
        action.deltaY !== undefined
      ) {
        return { code: "invalid_params", detail: "keyboard input takes a window ref, not coordinates" };
      }
      break;
    case "element_or_point":
      if (!parsed && !hasPoint) {
        return { code: "invalid_params", detail: "needs an explicit target: ref @eN or x/y coordinates" };
      }
      if (parsed && hasPoint) {
        return { code: "invalid_params", detail: "pass either a ref or coordinates, not both" };
      }
      if (parsed && parsed.kind !== "element") {
        return { code: "invalid_params", detail: `needs an element target (@eN) or coordinates, got ${action.ref}` };
      }
      break;
    case "point":
      if (!hasPoint) return { code: "invalid_params", detail: "needs explicit coordinates: pass x and y" };
      if (parsed) {
        return { code: "invalid_params", detail: `this action takes x/y only; drop the ${action.ref} ref` };
      }
      break;
  }
  if (hasPoint && (action.x === undefined || action.y === undefined)) {
    return { code: "invalid_params", detail: "coordinates need both x and y" };
  }
  // button/count（工单 21）只在坐标点击上生效：非 click 动作带了说明意图不明；
  // 元素点击带非缺省值同样拒绝（中/右键、双击只能走坐标点击），报错比静默挑一个便宜
  if ((action.button !== undefined || action.count !== undefined) && action.action !== "click") {
    return { code: "invalid_params", detail: "button/count only apply to coordinate clicks" };
  }
  if (
    parsed !== undefined &&
    ((action.button !== undefined && action.button !== "left") || (action.count !== undefined && action.count !== 1))
  ) {
    return {
      code: "invalid_params",
      detail: "element clicks do not take button/count; use coordinates for middle/right clicks and double clicks",
    };
  }
  for (const field of contract.requires) {
    // 引用类字段已在目标形态里判过，这里只查动作自带的参数
    if (field === "ref") continue;
    const rule = REQUIRED_FIELD_RULES[field];
    if (!rule.present(action)) return { code: "invalid_params", detail: rule.detail };
  }
  return undefined;
}

/** 快照节点 → 结构路径（从根起的子节点下标链）；后端靠它与观察时的身份核对目标 */
function snapshotPath(snapshot: ComputerSnapshot, target: ComputerSnapshotNode): readonly number[] {
  const path: number[] = [];
  let current = target;
  let parentRef = current.parentRef;
  while (parentRef !== undefined) {
    const parent = snapshot.nodes.find((node) => node.ref === parentRef);
    if (!parent) break;
    const siblings = snapshot.nodes.filter((node) => node.parentRef === parentRef);
    path.unshift(siblings.indexOf(current));
    current = parent;
    parentRef = current.parentRef;
  }
  return path;
}
