// computer 模块对外契约（工单 01）：工具清单与参数/返回结构、错误码、能力字段、引用规则、动作目录。
//
// 本文件只放类型与常量，不注册工具、不碰 pi 宿主（工具注册在工单 05，状态层与桥在 03/04）。
// 模型可见文本一律英文协议文本，界面与错误说明走 ./messages/ 的三语键表。
// 权威来源：docs/pi-computer/规划书.md 第 3、4、6、10 节与工单 01；实现按这份契约写，改契约先改这里。
//
// 类型与 schema 的关系：入参类型从 TypeBox schema 派生（Static<typeof ...>），
// 模型面与函数面是同一份定义，照 subagents/params.ts 的既有写法。

import { Type, type Static, type TSchema } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// 引用与状态（规划书第 4 节、第 10 节）
// ---------------------------------------------------------------------------

/** 根引用前缀：可操作的目标单元（窗口、菜单、弹层、对话框） */
export const COMPUTER_ROOT_REF_PREFIX = "@r";
/** 元素引用前缀 */
export const COMPUTER_ELEMENT_REF_PREFIX = "@e";
/** 引用形态：@rN / @eN，序号从 1 起、不带前导零 */
export const COMPUTER_REF_PATTERN = /^@([re])([1-9]\d*)$/;

export type ComputerRefKind = "root" | "element";
export type RootRef = `@r${number}`;
export type ElementRef = `@e${number}`;
export type ComputerRef = RootRef | ElementRef;

export interface ComputerRefParts {
  readonly kind: ComputerRefKind;
  readonly index: number;
  readonly ref: ComputerRef;
}

/**
 * 解析引用；形态不合法返回 undefined。
 * 解析只认形态，不判作用域：引用属于哪份快照、是否陈旧由状态层（工单 03）判定。
 */
export function parseComputerRef(value: unknown): ComputerRefParts | undefined {
  if (typeof value !== "string") return undefined;
  const matched = COMPUTER_REF_PATTERN.exec(value);
  if (!matched) return undefined;
  const index = Number(matched[2]);
  if (!Number.isSafeInteger(index)) return undefined;
  const kind: ComputerRefKind = matched[1] === "r" ? "root" : "element";
  return { kind, index, ref: value as ComputerRef };
}

/** 造引用；序号必须是正整数（调用方给错就直接抛，不产出畸形引用） */
export function formatComputerRef(kind: ComputerRefKind, index: number): ComputerRef {
  if (!Number.isSafeInteger(index) || index < 1) {
    throw new RangeError(`引用序号必须是正整数：${String(index)}`);
  }
  const prefix = kind === "root" ? COMPUTER_ROOT_REF_PREFIX : COMPUTER_ELEMENT_REF_PREFIX;
  return `${prefix}${index}`;
}

/**
 * 快照标识，不透明字符串（参考实现用随机 id，模型只透传不解析）。
 * 一次观察产出一个 stateId；动作只接受当前快照的引用，上一份快照仅用于算差异。
 */
export type ComputerStateId = string;

export interface ComputerBounds {
  /**
   * 矩形的口径随载荷走：
   * - 工具层与快照里的 bounds：同一 stateId 所绑图像的图面像素（工单 17，`screenshot_pixels`）；无图快照不带 bounds。
   * - 原生层回执里的 bounds（observe 节点）与 `capture.region`：虚拟桌面物理像素。
   * 两边的换算链见 coordinates.ts（image = (desktop − region 原点) × 各自方向的比例）。
   */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** 快照差异项：观察与动作回执都带它，界面变化一眼可见 */
export interface ComputerStateChange {
  readonly kind: "added" | "updated" | "removed";
  readonly ref: ComputerRef;
  readonly summary: string;
}

// ---------------------------------------------------------------------------
// 能力字段（规划书第 10 节；P1 用真实后端校准取值）
// ---------------------------------------------------------------------------

export const COMPUTER_PLATFORMS = ["windows", "macos", "linux", "unsupported"] as const;
export type ComputerPlatform = (typeof COMPUTER_PLATFORMS)[number];

export const COORDINATE_MODES = ["screenshot_pixels", "global_desktop"] as const;
export type ComputerCoordinateMode = (typeof COORDINATE_MODES)[number];

/** 后台控制：不支持 / 部分支持 / 完全支持（不抢焦点把输入发给目标窗口） */
export const BACKGROUND_INPUT_LEVELS = ["none", "partial", "full"] as const;
export type ComputerBackgroundInput = (typeof BACKGROUND_INPUT_LEVELS)[number];

export const COMPUTER_PERMISSIONS = ["accessibility", "screen_recording", "input_control"] as const;
export type ComputerPermission = (typeof COMPUTER_PERMISSIONS)[number];

export const PERMISSION_STATES = ["granted", "denied", "unknown", "not_required"] as const;
export type ComputerPermissionState = (typeof PERMISSION_STATES)[number];

export interface ComputerCapabilities {
  readonly platform: ComputerPlatform;
  /** 无障碍树是否可读（UIA / AX / AT-SPI） */
  readonly accessibility: boolean;
  readonly capture: boolean;
  readonly input: boolean;
  readonly coordinateMode: ComputerCoordinateMode;
  readonly backgroundInput: ComputerBackgroundInput;
  readonly permissions: Readonly<Record<ComputerPermission, ComputerPermissionState>>;
  /** 本平台或本会话的已知限制，照实上报，不藏 */
  readonly limits: readonly string[];
}

export function computerPlatformFromNode(nodePlatform: string): ComputerPlatform {
  switch (nodePlatform) {
    case "win32":
      return "windows";
    case "darwin":
      return "macos";
    case "linux":
      return "linux";
    default:
      return "unsupported";
  }
}

/** 桥未就绪（P0 与原生层未接入）时的能力快照：一切如实上报为不支持，不假装有 */
export function unavailableCapabilities(platform: ComputerPlatform): ComputerCapabilities {
  return {
    platform,
    accessibility: false,
    capture: false,
    input: false,
    // 坐标口径未探测时按截图像素：坐标兜底只在带图的当前状态下发起，与坐标换算链（P2）同一口径
    coordinateMode: "screenshot_pixels",
    backgroundInput: "none",
    permissions: {
      accessibility: "unknown",
      screen_recording: "unknown",
      input_control: "unknown",
    },
    limits: [],
  };
}

// ---------------------------------------------------------------------------
// 错误码：说明文案在 ./messages/，键为 `module.computer.error.<code>`
// ---------------------------------------------------------------------------

export const COMPUTER_ERROR_CODES = [
  "stale_ref",
  "wrong_scope",
  "target_not_found",
  "capability_unsupported",
  "bridge_timeout",
  "bridge_unavailable",
  "invalid_params",
  "action_failed",
  "expectation_failed",
] as const;
export type ComputerErrorCode = (typeof COMPUTER_ERROR_CODES)[number];

export interface ComputerError {
  readonly code: ComputerErrorCode;
  /** 失败细节（可能是原生层的原始文本），用于排查；说明文案按错误码查三语键表 */
  readonly detail?: string;
}

export type ComputerResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: ComputerError };

// ---------------------------------------------------------------------------
// 动作目录（规划书第 3 节：变更类动作必须带显式目标；readOnly 给 P8 审批留钩子）
// ---------------------------------------------------------------------------

export const COMPUTER_ACTIONS = [
  "press",
  "click",
  "setText",
  "focus",
  "typeText",
  "keypress",
  "scroll",
  "drag",
  "moveMouse",
] as const;
export type ComputerActionName = (typeof COMPUTER_ACTIONS)[number];

/** 动作投递路径：semantic 走无障碍语义接口；background 不抢用户焦点；foreground 明确允许前台输入。 */
export const COMPUTER_ACTION_DELIVERIES = ["semantic", "background", "foreground"] as const;
export type ComputerActionDelivery = (typeof COMPUTER_ACTION_DELIVERIES)[number];

/**
 * 动作条目上除 action 之外的逻辑字段名；必填关系见 COMPUTER_ACTION_CONTRACTS.requires。
 * 逻辑字段 → 条目属性名的对应：ref → ref；point → x/y；to → toX/toY；delta → deltaX/deltaY；
 * text → text；keys → keys；button → button；count → count。条目保持扁平（抄 injacency 的动作形态），
 * 两对坐标靠不同前缀区分，所以目录里用 point/to 两个逻辑名表达「一个坐标」和「拖拽终点」。
 * button/count（工单 21）只在坐标点击上生效，元素点击带非缺省值在工具层回 invalid_params。
 */
export const COMPUTER_ACTION_FIELDS = ["ref", "point", "to", "text", "keys", "delta", "button", "count"] as const;
export type ComputerActionField = (typeof COMPUTER_ACTION_FIELDS)[number];

/**
 * 动作要求的显式目标：
 * - element：必须给 @eN / @rN 引用
 * - element_or_point：引用或坐标二选一
 * - point：必须给坐标
 * - window：必须给目标窗口的根引用（@rN），键盘输入不接受“当前焦点”
 */
export const COMPUTER_ACTION_TARGETS = ["element", "element_or_point", "point", "window"] as const;
export type ComputerActionTarget = (typeof COMPUTER_ACTION_TARGETS)[number];

export interface ComputerActionContract {
  /** P8 审批的分流依据 */
  readonly readOnly: boolean;
  readonly target: ComputerActionTarget;
  readonly requires: readonly ComputerActionField[];
}

/**
 * 本期动作目录全部标为非只读：规划书第 10 节把只读定义为「不改变界面状态」，
 * 而这九个动作都会动到目标应用。moveMouse 不改界面内容，但会移动用户指针，审批按需介入更稳妥；
 * 真要出现纯只读动作，在这里改标记即可。
 *
 * button/count（工单 21）是 click 的可选修饰：left/1 是缺省，缺省值等价于不带字段；
 * 两个字段只在坐标点击上生效，所以 requires 里没有它们（requires 只登记必填字段）。
 * 系统键黑名单（单独 Win、Win+任意、Ctrl+Alt+Del、Alt+F4、Alt+Tab、Ctrl+Shift+Esc、Ctrl+Esc）
 * 已随工单 22 在原生 helper 的计划阶段执法，命中回 invalid_params。
 */
export const COMPUTER_ACTION_CONTRACTS: Readonly<Record<ComputerActionName, ComputerActionContract>> = {
  press: { readOnly: false, target: "element", requires: [] },
  click: { readOnly: false, target: "element_or_point", requires: [] },
  setText: { readOnly: false, target: "element", requires: ["text"] },
  focus: { readOnly: false, target: "element", requires: [] },
  typeText: { readOnly: false, target: "window", requires: ["text"] },
  keypress: { readOnly: false, target: "window", requires: ["keys"] },
  scroll: { readOnly: false, target: "element_or_point", requires: ["delta"] },
  drag: { readOnly: false, target: "point", requires: ["point", "to"] },
  moveMouse: { readOnly: false, target: "point", requires: ["point"] },
};

// ---------------------------------------------------------------------------
// 各工具的返回结构（与 COMPUTER_TOOL_NAMES 一一对应，编译期保证不遗漏）
// ---------------------------------------------------------------------------

export const COMPUTER_ROOT_KINDS = ["window", "menu", "dialog", "popover"] as const;
export type ComputerRootKind = (typeof COMPUTER_ROOT_KINDS)[number];

export interface ComputerRootSummary {
  readonly ref: RootRef;
  readonly kind: ComputerRootKind;
  readonly title: string;
  readonly app: string;
  readonly focused: boolean;
}

export interface ComputerStatusData {
  readonly capabilities: ComputerCapabilities;
  readonly bridge: {
    /** 桥协议版本；未接入原生层时为 null（版本协商由工单 04 的桥负责） */
    readonly protocolVersion: string | null;
    readonly ready: boolean;
  };
}

export interface ComputerRootsData {
  readonly roots: readonly ComputerRootSummary[];
}

// ---------------------------------------------------------------------------
// 采集记录（工单 15/16 落地；工单 17 起是坐标换算的唯一依据，与 stateId 绑定）
// ---------------------------------------------------------------------------

/** 一台显示器：id 是枚举序号（会话内稳定），device 是系统设备名（跨次枚举稳定，读不到时可为空） */
export interface ComputerDisplayInfo {
  readonly id: number;
  readonly device: string;
  /** 显示器矩形，虚拟桌面物理坐标；副屏在主屏左侧/上方时可为负 */
  readonly originX: number;
  readonly originY: number;
  readonly width: number;
  readonly height: number;
  /** 有效 DPI / 96；只作展示与限制说明，坐标一律按物理像素算 */
  readonly scaleFactor: number;
  readonly primary: boolean;
}

/** 一张采集图的元数据；scale = 图像像素 / 物理像素，必须等于 image.width / region.width */
export interface ComputerCaptureImage {
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly format: string;
  readonly scale: number;
}

/** 窗口像素的来源：Windows PrintWindow/屏幕回退，或 macOS Quartz 窗口采集 */
export type ComputerCaptureSource = "print_window" | "screen_region" | "quartz_window";

/**
 * 一次采集的回执：文件路径、图像元数据与采集区域（虚拟桌面物理坐标）。
 * 显示器采集带 display；窗口采集带 window/source/mayBeObscured（三者成组出现，不同时带 display）。
 * region + image + scale 构成图面坐标系（coordinates.ts 的 imageFrameOf），是坐标换算的唯一依据。
 */
export interface ComputerCaptureRecord {
  readonly path: string;
  readonly image: ComputerCaptureImage;
  readonly region: ComputerBounds;
  readonly display?: ComputerDisplayInfo;
  readonly window?: { readonly key: string };
  readonly source?: ComputerCaptureSource;
  /** 屏幕回退的采集可能包含遮挡物；source 为 screen_region 时为 true，窗口专用采集为 false */
  readonly mayBeObscured?: boolean;
}

/**
 * 带图观察回执里的截图信息（工单 19）：落盘路径、图像元数据与采集区域（坐标换算依据）。
 * 只带模型需要的东西；window/display 这类内部来源字段不外传，模型要的是路径与图面几何。
 */
export interface ComputerObserveCapture {
  readonly path: string;
  readonly image: ComputerCaptureImage;
  readonly region: ComputerBounds;
  readonly source?: ComputerCaptureSource;
  readonly mayBeObscured?: boolean;
}

export interface ComputerObserveData {
  readonly stateId: ComputerStateId;
  readonly root: RootRef;
  readonly outline: string;
  readonly nodeCount: number;
  readonly truncated: boolean;
  /** 有上一份快照时给出它的 id，并只在 changes 里给差异 */
  readonly previousStateId?: ComputerStateId;
  readonly changes: readonly ComputerStateChange[];
  /** 只有本次观察带图（computer_observe 传了 capture: true）时出现 */
  readonly capture?: ComputerObserveCapture;
}

export interface ComputerNodeSummary {
  readonly ref: ElementRef;
  readonly role: string;
  readonly name?: string;
  readonly value?: string;
}

export interface ComputerSearchData {
  readonly matches: readonly ComputerNodeSummary[];
  /** 命中总数；matches 只带排名靠前的若干条 */
  readonly total: number;
}

export interface ComputerNodeInspection extends ComputerNodeSummary {
  readonly description?: string;
  readonly enabled: boolean;
  readonly focused: boolean;
  readonly bounds?: ComputerBounds;
  /** 元素暴露的动作，如 invoke / setValue / focus */
  readonly actions: readonly string[];
}

export interface ComputerInspectData {
  readonly node: ComputerNodeInspection;
  /** 该节点起的子树大纲（含节点自己），按观察同一套折叠规则渲染；更深的节点用 computer_inspect 继续展开 */
  readonly outline: string;
  /** 子树节点总数（含节点自己），不受折叠影响 */
  readonly nodeCount: number;
  /** 有节点因折叠或文本预算没进大纲时为 true */
  readonly truncated: boolean;
}

export interface ComputerActData {
  /** 后继快照 id：后续动作与查询都用它，不要直接再观察 */
  readonly stateId: ComputerStateId;
  readonly changes: readonly ComputerStateChange[];
}

export interface ComputerReadData {
  readonly text: string;
  readonly truncated: boolean;
  /** 长文本的续读位置；没有再多的内容时为 undefined */
  readonly nextOffset?: number;
}

export const COMPUTER_WAIT_UNTIL = ["present", "absent"] as const;
export type ComputerWaitUntil = (typeof COMPUTER_WAIT_UNTIL)[number];

export interface ComputerWaitData {
  readonly met: boolean;
  readonly elapsedMs: number;
  /** 等待期间观察到的新快照 id；没有新快照时为 undefined */
  readonly stateId?: ComputerStateId;
}

/**
 * 单步结果（工单 30 定稿）：只回 ok 与错误。不带 stateId、也不带 changes——
 * 每步没有自己的快照（run 结束才物化恰一份），那里的 ref 没有归属状态，带上只会误导。
 */
export interface ComputerRunStepResult {
  readonly ok: boolean;
  readonly error?: ComputerError;
}

export type ComputerRunStatus = "completed" | "failed" | "timeout";

export interface ComputerRunData {
  /** 结束时物化的最后可信观察；effectsUnknown=true 时它可能已过时，先 observe 再动手。
   *  收口观察失败时缺席（与 computer_wait 的容忍口径一致）：模型要先 computer_observe 再动手。 */
  readonly stateId?: ComputerStateId;
  readonly status: ComputerRunStatus;
  /** 完整走完的步数；失败步与未开跑的步不计入 */
  readonly completed: number;
  readonly steps: readonly ComputerRunStepResult[];
  /** 失败或被预算截断的步号（从 1 数）；跑完时缺席 */
  readonly failedStep?: number;
  /** 某步动作是否已发出而结果未知（桥超时 / 干扰中断 / 取消时在途） */
  readonly effectsUnknown: boolean;
}

/** 工具名 → 返回结构；键必须覆盖全部工具，漏写由 typecheck 拦下 */
export interface ComputerToolResults {
  computer_status: ComputerStatusData;
  computer_roots: ComputerRootsData;
  computer_observe: ComputerObserveData;
  computer_search: ComputerSearchData;
  computer_inspect: ComputerInspectData;
  computer_act: ComputerActData;
  computer_read: ComputerReadData;
  computer_wait: ComputerWaitData;
  computer_run: ComputerRunData;
}

export type ComputerToolName = keyof ComputerToolResults & string;

/** 工具清单（顺序即注册顺序，也是测试与文档的对照表） */
export const COMPUTER_TOOL_NAMES: readonly ComputerToolName[] = [
  "computer_status",
  "computer_roots",
  "computer_observe",
  "computer_search",
  "computer_inspect",
  "computer_act",
  "computer_read",
  "computer_wait",
  "computer_run",
];

// ---------------------------------------------------------------------------
// 模型面预算（工单 18 定稿；实测方法与数字见 docs/pi-computer/issues/18-上下文预算定稿.md）。
// 常量在这里定义，schema 与工具实现共用，避免两处各写一份数字。
// ---------------------------------------------------------------------------

/** 观察/搜索/检视等回执的字符上限（read 分页除外，其单页由 COMPUTER_READ_MAX_CHARS 管）；超了截断并指路更省的查询 */
export const COMPUTER_TEXT_BUDGET = 8000;
/** 观察大纲的字符预算：从总预算里留 512 字符给头部、差异列表与尾注 */
export const COMPUTER_OUTLINE_BUDGET = COMPUTER_TEXT_BUDGET - 512;
/** computer_read 不传 maxChars 时的页大小 */
export const COMPUTER_READ_DEFAULT_CHARS = 4000;
/** computer_read 单页字符上限（schema 上限由常量生成；越界参数的执法点是宿主 schema 校验） */
export const COMPUTER_READ_MAX_CHARS = 20000;
/** computer_search 不传 limit 时返回的条数 */
export const COMPUTER_SEARCH_DEFAULT_LIMIT = 20;
/** computer_search 单次最多返回的条数（schema 上限由常量生成；越界参数的执法点是宿主 schema 校验） */
export const COMPUTER_SEARCH_MAX_LIMIT = 200;

/** 带图观察默认采集的长边上限（像素）：给 Pi read 的 2000px 图片阈值留余量，首次采集就大概率不用重采 */
export const COMPUTER_CAPTURE_LONG_EDGE = 1600;
/** 缩图重采的下限长边（像素）：320 长边的 PNG 不可能再超宿主图片预算，缩到这里仍超就是别的问题，如实报错 */
export const COMPUTER_CAPTURE_MIN_LONG_EDGE = 320;
/** 图片的 base64 长度预算：Pi read 的图片预算是 base64 长度口径（4.5MB），不是原始字节；
 * 口径按 Pi 源码为严格小于（image-resize-core 里 inputBase64Size < maxBytes 才不缩放），等于也算超 */
export const COMPUTER_IMAGE_BASE64_BUDGET = 4.5 * 1024 * 1024;

// ---------------------------------------------------------------------------
// 工具参数 schema：pi registerTool 直接吃这些对象，也是模型看得到的协议文本。
// 入参类型一律由对应 schema 派生，不另写一份 interface（避免两处各改一遍）。
// ---------------------------------------------------------------------------

const STATE_ID_FIELD = Type.String({
  minLength: 1,
  description:
    "Opaque state id returned by computer_observe (or the successor state id returned by computer_act / computer_run). " +
    "References are only valid inside their own state id; a state id from before an interface change is rejected as stale.",
});

const ROOT_REF_FIELD = Type.String({
  pattern: "^@r[1-9][0-9]*$",
  description: "Root reference (@rN) taken from computer_roots.",
});

const ELEMENT_REF_FIELD = Type.String({
  pattern: "^@e[1-9][0-9]*$",
  description:
    "Element reference (@eN) from the state that owns it. Refs from a previous state id are rejected as stale " +
    "instead of acting on whatever occupies that place now.",
});

/** 动作的目标引用：元素动作给 @eN，发给窗口的键盘输入给 @rN */
const ACTION_REF_FIELD = Type.String({
  pattern: "^@[re][1-9][0-9]*$",
  description:
    "Target reference from the observed state: @eN for an element, @rN for the target window of keyboard input. " +
    "Refs from a previous state id are rejected instead of acting on whatever occupies that place now.",
});

/** computer_read 的文本来源：元素（文档、编辑框）或根本身（窗口、对话框） */
const READ_REF_FIELD = Type.String({
  pattern: "^@[re][1-9][0-9]*$",
  description:
    "Reference from the observed state to read text from: @eN for an element (document, edit box, text block) or @rN " +
    "for the observed root itself (window, dialog).",
});

const UNTIL_SCHEMA = Type.Union(
  COMPUTER_WAIT_UNTIL.map((value) => Type.Literal(value)),
  { description: "present (default) waits for the text or the matched root to appear; absent waits for it to disappear." },
);

/** text 的长度上限：条件行会把 text 原样回显进回执，超长 needle 不得原样回灌；500 字符对 UI 文本匹配已绰绰有余 */
export const COMPUTER_WAIT_MAX_TEXT_LENGTH = 500;

/** 等待与断言的共同文本条件；两个参数面共用，避免同一形状写两遍。
 * text 与 window 在两个参数面都是运行期互斥（wait 是三模式恰一，run 的 expect 是 text/window 恰一），
 * 复用时两边都把 text 覆写为可选；window 形状共用 WAIT_WINDOW_FIELD。delayMs 是 wait 特有的模式面，不进 expect。 */
const WAIT_TEXT_FIELD = Type.String({
  minLength: 1,
  maxLength: COMPUTER_WAIT_MAX_TEXT_LENGTH,
  description: "Text whose presence or absence ends the wait.",
});
const WAIT_CONDITION_PROPERTIES = {
  text: WAIT_TEXT_FIELD,
  ref: Type.Optional(ELEMENT_REF_FIELD),
  until: Type.Optional(UNTIL_SCHEMA),
};

// 时长护栏（工单 28 定稿）：timeoutMs 默认 30s、下限 50ms 防抖、上限 1 小时——更长的等待由模型分段，
// 好让用户看到进度；硬砍短上限会逼模型反复重发等待，往返与 token 成本更高，还容易踩「动作可能已生效」的未知态。
export const COMPUTER_WAIT_DEFAULT_TIMEOUT_MS = 30_000;
export const COMPUTER_WAIT_MIN_TIMEOUT_MS = 50;
export const COMPUTER_WAIT_MAX_TIMEOUT_MS = 3_600_000;
/** 纯延时的上限与 timeoutMs 同一护栏（1 小时）；下限 1ms，没有防抖下限 */
export const COMPUTER_WAIT_MAX_DELAY_MS = 3_600_000;

// run 的预算与规模上限（工单 30 定稿）：预算默认两分钟，步数/每步动作/总动作按「够用且防呆」定，
// 不留无上限的口子；expect 的缺省超时比 wait 短——假失败比多等几秒更添麻烦（误判会诱发重复动作）。
export const COMPUTER_RUN_DEFAULT_TIMEOUT_MS = 120_000;
export const COMPUTER_RUN_EXPECT_DEFAULT_TIMEOUT_MS = 10_000;
export const COMPUTER_RUN_MAX_STEPS = 64;
export const COMPUTER_RUN_MAX_STEP_ACTIONS = 16;
export const COMPUTER_RUN_MAX_TOTAL_ACTIONS = 256;

const WAIT_TIMEOUT_FIELD = Type.Integer({
  minimum: COMPUTER_WAIT_MIN_TIMEOUT_MS,
  maximum: COMPUTER_WAIT_MAX_TIMEOUT_MS,
  description: `Maximum time to wait before reporting met=false (default ${COMPUTER_WAIT_DEFAULT_TIMEOUT_MS}).`,
});

const WAIT_DELAY_FIELD = Type.Integer({
  minimum: 1,
  maximum: COMPUTER_WAIT_MAX_DELAY_MS,
  description:
    "Pure delay mode: sleep for this many milliseconds (the full delay always elapses; passing timeoutMs here is " +
    "rejected). No observation and no new stateId; call computer_observe before acting on the interface again.",
});

/**
 * window 条件（工单 28）：等某个根（窗口/菜单/弹层/对话框）出现或消失。
 * ref 是 computer_roots 的 @rN（精确按稳定身份判在场）；title/app 是子串匹配。
 * 至少给一个字段——schema 表达不了「至少一个」，运行期校验兜底。
 */
const WAIT_WINDOW_FIELD = Type.Object(
  {
    ref: Type.Optional(
      Type.String({
        pattern: "^@r[1-9][0-9]*$",
        description: "Exact root reference (@rN from computer_roots) whose presence or absence ends the wait.",
      }),
    ),
    title: Type.Optional(Type.String({ description: "Substring matched against root titles (case-insensitive)." })),
    app: Type.Optional(Type.String({ description: "Substring matched against root owning applications (case-insensitive)." })),
  },
  {
    additionalProperties: false,
    description: "Window condition: wait for a root (window, menu, dialog or popover) to appear or disappear; give at least one of ref, title or app.",
  },
);

/** 坐标点击的鼠标按钮取值域（工单 21）；left 是缺省，等价于不带字段 */
export const COMPUTER_MOUSE_BUTTONS = ["left", "middle", "right"] as const;
export type ComputerMouseButton = (typeof COMPUTER_MOUSE_BUTTONS)[number];

/** 坐标点击的次数取值域（工单 21）；1 是缺省，2 是双击 */
export const COMPUTER_CLICK_COUNTS = [1, 2] as const;
export type ComputerClickCount = (typeof COMPUTER_CLICK_COUNTS)[number];

const COMPUTER_ACTION_SCHEMA = Type.Object(
  {
    action: Type.Union(COMPUTER_ACTIONS.map((name) => Type.Literal(name)), {
      description:
        "press/click (invoke, toggle, expand, select or coordinate click), setText (value pattern), focus, " +
        "typeText and keypress (keyboard input addressed to the target window), scroll, drag, moveMouse. " +
        "Each action needs an explicit target: an @eN/@rN ref, or coordinates where the action accepts them; " +
        "keyboard input always names its target window and is never sent to the current focus implicitly. " +
        "Coordinate actions (click/scroll/drag/moveMouse with x/y) need the stateId of a capture: true " +
        "observation: x/y are pixels of that observation's image.",
    }),
    delivery: Type.Optional(
      Type.Union(COMPUTER_ACTION_DELIVERIES.map((value) => Type.Literal(value)), {
        description:
          "Delivery path: semantic uses accessibility APIs; background must not take the user's focus; foreground explicitly permits foreground input. " +
          "Defaults to semantic for element actions and background for physical input.",
      }),
    ),
    ref: Type.Optional(ACTION_REF_FIELD),
    x: Type.Optional(
      Type.Number({
        description:
          "Coordinate target in the session's coordinate mode (screenshot_pixels: pixels of the image bound to this stateId).",
      }),
    ),
    y: Type.Optional(
      Type.Number({
        description:
          "Coordinate target in the session's coordinate mode (screenshot_pixels: pixels of the image bound to this stateId).",
      }),
    ),
    toX: Type.Optional(Type.Number({ description: "drag: end coordinate." })),
    toY: Type.Optional(Type.Number({ description: "drag: end coordinate." })),
    deltaX: Type.Optional(
      Type.Number({ description: "scroll: horizontal wheel steps; positive scrolls right." }),
    ),
    deltaY: Type.Optional(
      Type.Number({ description: "scroll: vertical wheel steps; positive scrolls down." }),
    ),
    text: Type.Optional(Type.String({ description: "setText / typeText: the text to write." })),
    keys: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "keypress: key names in press order; modifiers are pressed in order and released in reverse. " +
          'Each entry is one key combination: join its key names with + ("ctrl+shift+t", "ctrl+s") or give a single key. ' +
          "Named keys: ctrl, shift, alt, meta (win), enter, escape, tab, space, backspace, delete, insert, " +
          "home, end, pageup, pagedown, up, down, left, right, f1-f24. Any other single character names that key " +
          "literally (punctuation is injected as text, not as a keystroke). The + character itself cannot be written " +
          'directly because + separates combination members: name it "plus" (e.g. keys ["7", "plus"] for a calculator\'s ' +
          "plus key). For UI buttons (e.g. a calculator's operator buttons) prefer press with an element ref instead of keypress.",
      }),
    ),
    button: Type.Optional(
      Type.Union(
        COMPUTER_MOUSE_BUTTONS.map((value) => Type.Literal(value)),
        { description: "Coordinate click only: mouse button (default left); rejected on element clicks." },
      ),
    ),
    count: Type.Optional(
      Type.Union(
        COMPUTER_CLICK_COUNTS.map((value) => Type.Literal(value)),
        { description: "Coordinate click only: 1 for a single click (default) or 2 for a double click." },
      ),
    ),
  },
  { additionalProperties: false },
);

/** 动作条目入参：运行期由状态层按 COMPUTER_ACTION_CONTRACTS 校验必填字段与目标类型 */
export type ComputerAction = Static<typeof COMPUTER_ACTION_SCHEMA>;

/** run 的整体预算字段：护栏与 wait 同一套（50ms 防抖 - 1 小时），默认值不同（两分钟） */
const RUN_TIMEOUT_FIELD = Type.Integer({
  minimum: COMPUTER_WAIT_MIN_TIMEOUT_MS,
  maximum: COMPUTER_WAIT_MAX_TIMEOUT_MS,
  description: `Overall budget for the whole run in milliseconds; when it runs out the run stops and reports status "timeout" (default ${COMPUTER_RUN_DEFAULT_TIMEOUT_MS}).`,
});

/** expect 的超时字段：护栏与 wait 同一套，缺省 10s（比等待短：断言假失败会诱发重复动作） */
const RUN_EXPECT_TIMEOUT_FIELD = Type.Integer({
  minimum: COMPUTER_WAIT_MIN_TIMEOUT_MS,
  maximum: COMPUTER_WAIT_MAX_TIMEOUT_MS,
  description: `Maximum time to wait for this expectation before the step fails (default ${COMPUTER_RUN_EXPECT_DEFAULT_TIMEOUT_MS}).`,
});

const COMPUTER_EXPECTATION_SCHEMA = Type.Object(
  {
    ...WAIT_CONDITION_PROPERTIES,
    // 覆写为可选：text 与 window 恰一，互斥由运行期校验（schema 表达不了 either-or）
    text: Type.Optional(WAIT_TEXT_FIELD),
    window: Type.Optional(WAIT_WINDOW_FIELD),
    timeoutMs: Type.Optional(RUN_EXPECT_TIMEOUT_FIELD),
  },
  {
    additionalProperties: false,
    description:
      "Assertion for this step — exactly one of text or window (the schema cannot express this either-or); " +
      "the step fails and the run stops when it is not satisfied.",
  },
);

export type ComputerExpectation = Static<typeof COMPUTER_EXPECTATION_SCHEMA>;

const COMPUTER_RUN_STEP_SCHEMA = Type.Object(
  {
    actions: Type.Optional(
      Type.Array(COMPUTER_ACTION_SCHEMA, {
        maxItems: COMPUTER_RUN_MAX_STEP_ACTIONS,
        description:
          "Actions for this step, resolved against the stateId passed to this call; omit for an expectation-only step.",
      }),
    ),
    expect: Type.Optional(COMPUTER_EXPECTATION_SCHEMA),
  },
  {
    additionalProperties: false,
    description: "One step: actions and/or an expect (a step with neither is rejected); give at least one.",
  },
);

export type ComputerRunStep = Static<typeof COMPUTER_RUN_STEP_SCHEMA>;

export const COMPUTER_TOOL_CONTRACTS: Readonly<Record<ComputerToolName, ComputerToolContract>> = {
  computer_status: {
    title: "Computer capabilities",
    description:
      "Report what this machine can do: platform, accessibility tree, screen capture, native input, coordinate mode, " +
      "background input, permission states and the platform's known limits, plus whether the native helper is ready. " +
      "Read it before promising an operation; unsupported operations fail with capability_unsupported instead of pretending.",
    promptSnippet: "Report platform capabilities and native helper readiness before promising desktop operations",
    promptGuidelines: [
      "Read computer_status before desktop work when it is unclear whether this machine can see the screen or drive input.",
      "When a capability is false, report the limitation to the user instead of retrying the same operation.",
    ],
    readOnly: true,
    parameters: Type.Object({}, { additionalProperties: false }),
  },
  computer_roots: {
    title: "List operable roots",
    description:
      "List the operable roots — windows, menus, dialogs and popovers — with their @rN reference, kind, title, owning " +
      "application and focus state. Use it to choose what to observe. Roots are discovery only: actions need a state id " +
      "from computer_observe.",
    promptSnippet: "List operable desktop roots (windows, menus, dialogs, popovers) with their @rN references",
    promptGuidelines: [
      "Start desktop work by listing roots, then observe the root you need; roots are discovery only and carry no stateId for actions.",
    ],
    readOnly: true,
    parameters: Type.Object({}, { additionalProperties: false }),
  },
  computer_observe: {
    title: "Observe a root",
    description:
      "Observe one root and return a folded outline plus the stateId that owns its element refs. Ref-targeted tools must " +
      "use that stateId; once the interface changes, refs from the old state are rejected as stale. Changes against the " +
      "previous observation are returned with it, and that previous snapshot cannot be used for actions. Set capture to " +
      "take a screenshot of the root first: the receipt then carries the image path, and node bounds are pixels of that " +
      "image (coordinateMode screenshot_pixels). Without capture there is no image and no bounds. A capture failure " +
      "fails the whole observation; retry without capture when the text outline is enough.",
    promptSnippet: "Observe one root and get its folded outline and the stateId that owns its @eN references",
    promptGuidelines: [
      "Ref-based tools need the stateId from an observation; after the interface changes, observe again instead of reusing old refs.",
      "When the outline is truncated, use computer_search with the same stateId rather than observing the root again.",
      "Bounds are screenshot pixels of the image bound to the same stateId; a state without an image has no bounds, so do not invent coordinates for it.",
      "Set capture only when the visual layout, colors or a canvas actually matter; text-only work should observe without it, because an image costs image tokens.",
      "With capture, open the returned image path with the read tool; if the capture fails the whole call fails, so retry without capture when the outline is enough.",
    ],
    readOnly: true,
    parameters: Type.Object(
      {
        root: Type.Optional(
          Type.String({
            pattern: "^@r[1-9][0-9]*$",
            description: "Root to observe, taken from computer_roots. Omit to observe the frontmost root.",
          }),
        ),
        capture: Type.Optional(
          Type.Boolean({
            description:
              "Take a screenshot of the root before observing (default false). The receipt then carries the image path, " +
              "and node bounds become pixels of that image; read the image with the read tool by that path.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
  },
  computer_search: {
    title: "Search the observed outline",
    description:
      "Search the full stored outline of a stateId for text or an element role and return matching @eN refs with role, " +
      "name and value. Cheaper than observing again. Provide at least one of text or role — a call with neither is " +
      "rejected with invalid_params (the schema cannot express the either-or). Matches are ranked and capped, and the " +
      "total match count is returned so a broad query can be refined.",
    promptSnippet: "Search a stateId's stored outline by text or role and get matching @eN references",
    promptGuidelines: [
      "Provide text or role; a call with neither is rejected.",
      "Prefer search over re-observing when a stateId is already available and one specific element is needed.",
    ],
    readOnly: true,
    parameters: Type.Object(
      {
        stateId: STATE_ID_FIELD,
        text: Type.Optional(
          Type.String({ description: "Text to look for in element names, values, text bodies and descriptions." }),
        ),
        role: Type.Optional(
          Type.String({ description: "Platform role to look for, e.g. button, edit, menuItem, listItem." }),
        ),
        // 200 条以上就不是搜索而是观察了：收紧查询比翻页更省上下文（工单 18 定稿）
        limit: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: COMPUTER_SEARCH_MAX_LIMIT,
            description: `Maximum matches to return (default ${COMPUTER_SEARCH_DEFAULT_LIMIT}).`,
          }),
        ),
      },
      { additionalProperties: false },
    ),
  },
  computer_inspect: {
    title: "Inspect one element",
    description:
      "Show what one @eN reference of a stateId really is: role, name, value, description, enabled and focused flags, " +
      "bounds (only when that state carries an image, in that image's pixels), and the actions the element exposes — " +
      "plus the folded outline of its subtree, so a subtree that the observation folded can be expanded without " +
      "observing the root again.",
    promptSnippet: "Inspect one @eN element: role, value, bounds, exposed actions and its folded subtree",
    promptGuidelines: [
      "Use inspect to expand a folded subtree; continue deeper with computer_inspect on the returned refs.",
    ],
    readOnly: true,
    parameters: Type.Object({ stateId: STATE_ID_FIELD, ref: ELEMENT_REF_FIELD }, { additionalProperties: false }),
  },
  computer_act: {
    title: "Act on the observed interface",
    description:
      "Run one or more actions against a stateId and return the successor stateId together with the changes the actions " +
      "caused. Every action must name an explicit target — an @eN/@rN ref or coordinates; nothing is sent to the current " +
      "focus implicitly. Actions are validated against the current snapshot, and stale refs are rejected rather than hitting " +
      "whatever now occupies that place. Continue with the returned stateId.",
    promptSnippet: "Run actions (press, click, setText, focus, keyboard, scroll, drag) against a stateId; returns the successor stateId",
    promptGuidelines: [
      "Every action needs an explicit target: an @eN/@rN ref or coordinates; nothing is sent to the current focus implicitly.",
      "Coordinate actions (click/scroll/drag/moveMouse with x/y) need the stateId of an observation taken with capture: true; x/y/toX/toY are pixels of that image, and the tool converts them before dispatch.",
      "Clicks at coordinates accept button (left default, middle, right) and count (1 default, 2 for double click); element clicks take neither.",
      "Continue with the stateId returned by computer_act; do not reuse refs from the state that was acted on.",
      "When an action is rejected as stale_ref, observe the root again and resolve the target once more.",
    ],
    readOnly: false,
    parameters: Type.Object(
      {
        stateId: STATE_ID_FIELD,
        actions: Type.Array(COMPUTER_ACTION_SCHEMA, {
          minItems: 1,
          description: "Actions to run in order against the same snapshot and its refs.",
        }),
      },
      { additionalProperties: false },
    ),
  },
  computer_read: {
    title: "Read element text",
    description:
      "Read the text owned by one reference of a stateId (an @eN element such as a document or edit box, or the @rN root " +
      "itself, e.g. a window), page by page. Continue long text with offset/nextOffset instead of pulling everything into " +
      "context at once.",
    promptSnippet: "Read the text of an element or root by page, continuing long text with offset/nextOffset",
    promptGuidelines: [
      "Page long text with offset/maxChars instead of pulling everything into context at once.",
    ],
    readOnly: true,
    parameters: Type.Object(
      {
        stateId: STATE_ID_FIELD,
        ref: READ_REF_FIELD,
        offset: Type.Optional(
          Type.Integer({ minimum: 0, description: "Character offset to continue from (default 0)." }),
        ),
        // 默认页与上限见 COMPUTER_READ_DEFAULT_CHARS / COMPUTER_READ_MAX_CHARS：保持单次结果是小文本块，超长文本靠 nextOffset 续读（工单 18 定稿）
        maxChars: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: COMPUTER_READ_MAX_CHARS,
            description: `Maximum characters to return (default ${COMPUTER_READ_DEFAULT_CHARS}).`,
          }),
        ),
      },
      { additionalProperties: false },
    ),
  },
  computer_wait: {
    title: "Wait for a condition",
    description:
      "Wait until one condition holds and report whether it was met. Exactly one mode per call: text (stateId " +
      "required) waits for text to be present or absent, optionally scoped to one @eN subtree; window (stateId " +
      "required) waits for a root — window, menu, dialog or popover — to appear or disappear, matched by an exact " +
      "@rN ref or by title/app substring; delayMs is a plain fixed pause that observes nothing and returns no " +
      "stateId. The text mode checks the snapshot named by stateId first, so an already-satisfied condition returns " +
      "immediately without a new observation; the window mode queries roots immediately instead (a root's own " +
      "snapshot cannot say whether other roots exist); otherwise the wait polls with a growing interval (sub-second " +
      "at first, then 1-2s, at most 15s) until the condition is met or the timeout elapses (default 30000ms). A text " +
      "wait that polled returns the stateId of its last observation — met or not — unless that closing observation " +
      "itself fails, in which case it reports met without a stateId; continue with it. Longer waits " +
      "should be split into shorter calls so progress stays visible.",
    promptSnippet:
      "Wait until text appears/disappears (optionally within a subtree), a window appears/disappears, or a fixed delay elapses",
    promptGuidelines: [
      "For a text wait, check the condition against the stateId you already hold first: computer_wait tests that snapshot before observing, so an already-satisfied condition costs nothing; a window wait queries roots immediately instead.",
      "Continue with the stateId returned by a wait that polled; the previous stateId is stale after it. A text wait may also return met with no stateId (its closing observation failed): call computer_observe to get fresh state. Window and delay waits return no stateId: call computer_roots / computer_observe to continue.",
      "After a delayMs wait, call computer_observe before acting on the interface; the delay produced no new state.",
      "For long conditions, split the wait into shorter calls (for example 60s pieces) instead of one huge timeout, so you can report progress and react between them.",
    ],
    readOnly: true,
    parameters: Type.Object(
      {
        stateId: Type.Optional(
          Type.String({
            minLength: 1,
            description:
              "State id of the current observation. Required for the text and window modes (the text mode checks this " +
              "snapshot first; the window mode only anchors the session on it and queries roots); must not appear " +
              "with delayMs (the schema cannot express this either-or).",
          }),
        ),
        ...WAIT_CONDITION_PROPERTIES,
        // 覆写：wait 的 text 可选（三模式恰一，互斥由运行期校验）；run 的 expect 仍是必填
        text: Type.Optional(WAIT_TEXT_FIELD),
        window: Type.Optional(WAIT_WINDOW_FIELD),
        delayMs: Type.Optional(WAIT_DELAY_FIELD),
        timeoutMs: Type.Optional(WAIT_TIMEOUT_FIELD),
      },
      { additionalProperties: false },
    ),
  },
  computer_run: {
    title: "Run several steps at once",
    description:
      "Run a fixed sequence of steps in one call: each step is a group of actions plus an optional expectation — text in " +
      "the observed root (optionally scoped to one @eN subtree) or a window condition on roots — that must hold before the " +
      "next step runs, and execution stops at the first failing step. All actions of all steps are " +
      "resolved against the stateId passed to this call and frozen before the first step executes — refs become " +
      "structural targets, coordinates are converted through that snapshot's image — and each dispatched action is " +
      "identity-checked by the native helper: a target that changed is rejected as stale_ref and the run stops instead of " +
      "hitting whatever now occupies that place. The receipt reports status (completed / failed / timeout), per-step " +
      "results, how many steps completed, the failing step number, effectsUnknown (true when a dispatched action's " +
      "effect could not be determined, e.g. a bridge timeout or an in-flight cancellation — then observe before acting " +
      "again), and a single top-level stateId: the last trusted observation, materialized once when the run ends. A " +
      "receipt without a stateId means the closing observation itself failed: call computer_observe to get current state. " +
      "Every ref and coordinate must come from the stateId passed in; to act on elements that appeared meanwhile or to " +
      "inspect intermediate results, use computer_wait to pick up a new stateId and start another run.",
    promptSnippet:
      "Run a fixed sequence of action steps with optional expectations in one call, stopping at the first failure",
    promptGuidelines: [
      "Use computer_run for fixed sequences whose later steps do not depend on inspecting earlier results; otherwise act step by step.",
      "Every ref and coordinate in every step is resolved against the stateId passed to this call before the first step runs; a changed target stops the run as stale_ref, and the receipt carries the completed steps and the last trusted stateId.",
      "A step with only an expectation is a checkpoint; when it fails the run stops and the receipt carries the scene at that moment under the top-level stateId.",
      "When the receipt reports effectsUnknown or status \"timeout\", the top-level stateId may be out of date: observe the root again before acting on it.",
      "A receipt without a top-level stateId means the closing observation failed: call computer_observe before acting.",
    ],
    readOnly: false,
    parameters: Type.Object(
      {
        stateId: STATE_ID_FIELD,
        steps: Type.Array(COMPUTER_RUN_STEP_SCHEMA, {
          minItems: 1,
          maxItems: COMPUTER_RUN_MAX_STEPS,
          description:
            "Steps run in order; each step is at most 16 actions and an optional expect, at least one of the two " +
            `(the whole run allows at most ${COMPUTER_RUN_MAX_STEPS} steps and ${COMPUTER_RUN_MAX_TOTAL_ACTIONS} actions).`,
        }),
        timeoutMs: Type.Optional(RUN_TIMEOUT_FIELD),
      },
      { additionalProperties: false },
    ),
  },
};

export interface ComputerToolContract {
  /** 模型可见英文标题 */
  readonly title: string;
  /** 模型可见英文描述：模型唯一的用法说明来源 */
  readonly description: string;
  /** 系统提示「可用工具」一节的一行摘要；缺了工具就不进那段列表（工单 07） */
  readonly promptSnippet: string;
  /** 系统提示 Guidelines 一节的条目：工具激活时附上，写使用时机与顺序（工单 07） */
  readonly promptGuidelines: readonly string[];
  /** P8 审批的粗粒度钩子：整个工具是否只读 */
  readonly readOnly: boolean;
  /** pi registerTool 用的参数 schema */
  readonly parameters: TSchema;
}

/** 带名字的工具清单：注册（工单 05）与文档都从这里取 */
export const COMPUTER_TOOLS: readonly (ComputerToolContract & { readonly name: ComputerToolName })[] =
  COMPUTER_TOOL_NAMES.map((name) => ({ name, ...COMPUTER_TOOL_CONTRACTS[name] }));
