import { Type, type Static, type TSchema } from "typebox";

export const COMPUTER_ROOT_REF_PREFIX = "@r";

export const COMPUTER_ELEMENT_REF_PREFIX = "@e";

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

export function parseComputerRef(value: unknown): ComputerRefParts | undefined {
  if (typeof value !== "string") return undefined;
  const matched = COMPUTER_REF_PATTERN.exec(value);
  if (!matched) return undefined;
  const index = Number(matched[2]);
  if (!Number.isSafeInteger(index)) return undefined;
  const kind: ComputerRefKind = matched[1] === "r" ? "root" : "element";
  return { kind, index, ref: value as ComputerRef };
}

export function formatComputerRef(kind: ComputerRefKind, index: number): ComputerRef {
  if (!Number.isSafeInteger(index) || index < 1) {
    throw new RangeError(`引用序号必须是正整数：${String(index)}`);
  }
  const prefix = kind === "root" ? COMPUTER_ROOT_REF_PREFIX : COMPUTER_ELEMENT_REF_PREFIX;
  return `${prefix}${index}`;
}

export type ComputerStateId = string;

export interface ComputerBounds {

  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ComputerStateChange {
  readonly kind: "added" | "updated" | "removed";
  readonly ref: ComputerRef;
  readonly summary: string;
}

export const COMPUTER_PLATFORMS = ["windows", "macos", "linux", "unsupported"] as const;
export type ComputerPlatform = (typeof COMPUTER_PLATFORMS)[number];

export const COORDINATE_MODES = ["screenshot_pixels", "global_desktop"] as const;
export type ComputerCoordinateMode = (typeof COORDINATE_MODES)[number];

export const BACKGROUND_INPUT_LEVELS = ["none", "partial", "full"] as const;
export type ComputerBackgroundInput = (typeof BACKGROUND_INPUT_LEVELS)[number];

export const COMPUTER_PERMISSIONS = ["accessibility", "screen_recording", "input_control"] as const;
export type ComputerPermission = (typeof COMPUTER_PERMISSIONS)[number];

export const PERMISSION_STATES = ["granted", "denied", "unknown", "not_required"] as const;
export type ComputerPermissionState = (typeof PERMISSION_STATES)[number];

export interface ComputerCapabilities {
  readonly platform: ComputerPlatform;

  readonly accessibility: boolean;
  readonly capture: boolean;
  readonly input: boolean;
  readonly coordinateMode: ComputerCoordinateMode;

  readonly backgroundInput: ComputerBackgroundInput;

  readonly backgroundPointer: ComputerBackgroundInput;

  readonly backgroundPointerLimits?: ComputerBackgroundPointerLimits;
  readonly permissions: Readonly<Record<ComputerPermission, ComputerPermissionState>>;

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

export function unavailableCapabilities(platform: ComputerPlatform): ComputerCapabilities {
  return {
    platform,
    accessibility: false,
    capture: false,
    input: false,

    coordinateMode: "screenshot_pixels",
    backgroundInput: "none",
    backgroundPointer: "none",
    permissions: {
      accessibility: "unknown",
      screen_recording: "unknown",
      input_control: "unknown",
    },
    limits: [],
  };
}

export const BACKGROUND_POINTER_WINDOW_TYPES = [
  "appkit_window", // 原生 AppKit 窗口（含标题栏与边框 chrome）
  "chromium_content", // Chromium/Electron 渲染层内容（DOM 事件到达）
  "canvas_webgl", // 网页 canvas / WebGL 内容层
  "floating_panel", // 悬浮面板（NSPanel，不属普通窗口层）
  "modal_sheet", // 模态 sheet
  "menu_owned_window", // 菜单或弹层所属窗口
] as const;
export type ComputerBackgroundPointerWindowType = (typeof BACKGROUND_POINTER_WINDOW_TYPES)[number];

export const BACKGROUND_POINTER_EVENT_TYPES = [
  "move",
  "click",
  "doubleClick",
  "rightClick",
  "middleClick",
  "drag",
  "wheel",
  "wheelHorizontal",
] as const;
export type ComputerBackgroundPointerEventType = (typeof BACKGROUND_POINTER_EVENT_TYPES)[number];

export const BACKGROUND_POINTER_COORDINATE_CASES = [
  "single_display_primary", // 单屏、主屏原点、Quartz 屏幕点
  "retina_scale_2", // Retina 缩放
  "multi_display", // 多屏
  "mixed_dpi", // 混合 DPI
  "negative_origin", // 副屏在主屏左侧或上方，坐标为负
  "window_moved", // 窗口移动或缩放后重新观察
] as const;
export type ComputerBackgroundPointerCoordinateCase = (typeof BACKGROUND_POINTER_COORDINATE_CASES)[number];

export const BACKGROUND_POINTER_COORDINATE_CONDITIONS = ["window_frame_relative"] as const;
export type ComputerBackgroundPointerCoordinateCondition =
  (typeof BACKGROUND_POINTER_COORDINATE_CONDITIONS)[number];

export const BACKGROUND_POINTER_TARGET_KINDS = ["application", "fixture"] as const;
export type ComputerBackgroundPointerTargetKind = (typeof BACKGROUND_POINTER_TARGET_KINDS)[number];

export interface ComputerBackgroundPointerApp {

  readonly id: string;

  readonly version: string;
  readonly kind: ComputerBackgroundPointerTargetKind;

  readonly windowTypes: readonly ComputerBackgroundPointerWindowType[];

  readonly eventTypes: readonly ComputerBackgroundPointerEventType[];

  readonly verifiedBy: string;
}

export interface ComputerBackgroundPointerCoordinate {

  readonly condition: ComputerBackgroundPointerCoordinateCondition;

  readonly requiresSnapshot: boolean;
  readonly verifiedCases: readonly ComputerBackgroundPointerCoordinateCase[];
  readonly unverifiedCases: readonly ComputerBackgroundPointerCoordinateCase[];
}

export interface ComputerBackgroundPointerLimits {

  readonly evidenceVersion: string;

  readonly evidenceDate: string;

  readonly mechanism: string;

  readonly apps: readonly ComputerBackgroundPointerApp[];

  readonly windowTypes: {
    readonly verified: readonly ComputerBackgroundPointerWindowType[];
    readonly unverified: readonly ComputerBackgroundPointerWindowType[];
  };

  readonly eventTypes: {
    readonly verified: readonly ComputerBackgroundPointerEventType[];
    readonly unverified: readonly ComputerBackgroundPointerEventType[];
  };
  readonly coordinate: ComputerBackgroundPointerCoordinate;

  readonly degradations: readonly string[];
}

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

  readonly detail?: string;
}

export type ComputerResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: ComputerError };

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

export const COMPUTER_ACTION_DELIVERIES = ["semantic", "background", "foreground"] as const;
export type ComputerActionDelivery = (typeof COMPUTER_ACTION_DELIVERIES)[number];

export const COMPUTER_ACTION_FIELDS = ["ref", "point", "to", "text", "keys", "delta", "button", "count"] as const;
export type ComputerActionField = (typeof COMPUTER_ACTION_FIELDS)[number];

export const COMPUTER_ACTION_TARGETS = ["element", "element_or_point", "point", "window"] as const;
export type ComputerActionTarget = (typeof COMPUTER_ACTION_TARGETS)[number];

export interface ComputerActionContract {

  readonly readOnly: boolean;
  readonly target: ComputerActionTarget;
  readonly requires: readonly ComputerActionField[];
}

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

    readonly protocolVersion: string | null;
    readonly ready: boolean;
  };
}

export interface ComputerRootsData {
  readonly roots: readonly ComputerRootSummary[];
}

export interface ComputerDisplayInfo {
  readonly id: number;
  readonly device: string;

  readonly originX: number;
  readonly originY: number;
  readonly width: number;
  readonly height: number;

  readonly scaleFactor: number;
  readonly primary: boolean;
}

export interface ComputerCaptureImage {
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly format: string;
  readonly scale: number;
}

export type ComputerCaptureSource = "print_window" | "screen_region" | "quartz_window";

export interface ComputerWindowIdentity {
  readonly key: string;

  readonly pid?: number;
  readonly startIdentity?: { readonly seconds: number; readonly microseconds: number };
  readonly windowId?: number;
  readonly app?: string;
  readonly bounds?: ComputerBounds;
}

export interface ComputerCaptureRecord {
  readonly path: string;
  readonly image: ComputerCaptureImage;
  readonly region: ComputerBounds;
  readonly display?: ComputerDisplayInfo;
  readonly displays?: readonly ComputerDisplayInfo[];
  readonly window?: ComputerWindowIdentity;
  readonly source?: ComputerCaptureSource;

  readonly mayBeObscured?: boolean;
}

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

  readonly previousStateId?: ComputerStateId;
  readonly changes: readonly ComputerStateChange[];

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

  readonly total: number;
}

export interface ComputerNodeInspection extends ComputerNodeSummary {
  readonly description?: string;
  readonly enabled: boolean;
  readonly focused: boolean;
  readonly bounds?: ComputerBounds;

  readonly actions: readonly string[];
}

export interface ComputerInspectData {
  readonly node: ComputerNodeInspection;

  readonly outline: string;

  readonly nodeCount: number;

  readonly truncated: boolean;
}

export interface ComputerActData {

  readonly stateId: ComputerStateId;
  readonly changes: readonly ComputerStateChange[];
}

export interface ComputerReadData {
  readonly text: string;
  readonly truncated: boolean;

  readonly nextOffset?: number;
}

export const COMPUTER_WAIT_UNTIL = ["present", "absent"] as const;
export type ComputerWaitUntil = (typeof COMPUTER_WAIT_UNTIL)[number];

export interface ComputerWaitData {
  readonly met: boolean;
  readonly elapsedMs: number;

  readonly stateId?: ComputerStateId;
}

export interface ComputerRunStepResult {
  readonly ok: boolean;
  readonly error?: ComputerError;
}

export type ComputerRunStatus = "completed" | "failed" | "timeout";

export interface ComputerRunData {

  readonly stateId?: ComputerStateId;
  readonly status: ComputerRunStatus;

  readonly completed: number;
  readonly steps: readonly ComputerRunStepResult[];

  readonly failedStep?: number;

  readonly effectsUnknown: boolean;
}

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

export const COMPUTER_TEXT_BUDGET = 8000;

export const COMPUTER_OUTLINE_BUDGET = COMPUTER_TEXT_BUDGET - 512;

export const COMPUTER_READ_DEFAULT_CHARS = 4000;

export const COMPUTER_READ_MAX_CHARS = 20000;

export const COMPUTER_SEARCH_DEFAULT_LIMIT = 20;

export const COMPUTER_SEARCH_MAX_LIMIT = 200;

export const COMPUTER_CAPTURE_LONG_EDGE = 1600;

export const COMPUTER_CAPTURE_MIN_LONG_EDGE = 320;

export const COMPUTER_IMAGE_BASE64_BUDGET = 4.5 * 1024 * 1024;

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

const ACTION_REF_FIELD = Type.String({
  pattern: "^@[re][1-9][0-9]*$",
  description:
    "Target reference from the observed state: @eN for an element, @rN for the target window of keyboard input. " +
    "Refs from a previous state id are rejected instead of acting on whatever occupies that place now.",
});

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

export const COMPUTER_WAIT_MAX_TEXT_LENGTH = 500;

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

export const COMPUTER_WAIT_DEFAULT_TIMEOUT_MS = 30_000;
export const COMPUTER_WAIT_MIN_TIMEOUT_MS = 50;
export const COMPUTER_WAIT_MAX_TIMEOUT_MS = 3_600_000;

export const COMPUTER_WAIT_MAX_DELAY_MS = 3_600_000;

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

export const COMPUTER_MOUSE_BUTTONS = ["left", "middle", "right"] as const;
export type ComputerMouseButton = (typeof COMPUTER_MOUSE_BUTTONS)[number];

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

export interface ComputerAction {
  action: ComputerActionName;
  delivery?: ComputerActionDelivery;
  ref?: string;
  x?: number;
  y?: number;
  toX?: number;
  toY?: number;
  deltaX?: number;
  deltaY?: number;
  text?: string;
  keys?: string[];
  button?: ComputerMouseButton;
  count?: ComputerClickCount;
}

const RUN_TIMEOUT_FIELD = Type.Integer({
  minimum: COMPUTER_WAIT_MIN_TIMEOUT_MS,
  maximum: COMPUTER_WAIT_MAX_TIMEOUT_MS,
  description: `Overall budget for the whole run in milliseconds; when it runs out the run stops and reports status "timeout" (default ${COMPUTER_RUN_DEFAULT_TIMEOUT_MS}).`,
});

const RUN_EXPECT_TIMEOUT_FIELD = Type.Integer({
  minimum: COMPUTER_WAIT_MIN_TIMEOUT_MS,
  maximum: COMPUTER_WAIT_MAX_TIMEOUT_MS,
  description: `Maximum time to wait for this expectation before the step fails (default ${COMPUTER_RUN_EXPECT_DEFAULT_TIMEOUT_MS}).`,
});

const COMPUTER_EXPECTATION_SCHEMA = Type.Object(
  {
    ...WAIT_CONDITION_PROPERTIES,

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
      "background keyboard and pointer input separately, permission states and the platform's known limits, plus whether the native helper is ready. " +
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
      "On macOS, coordinate pointer batches default to background delivery. Judge this dispatch against the structure computer_status reports: outside the verified scope the batch fails with the background_unavailable: prefix — report the limitation instead of retrying.",
      "On macOS, moving the real cursor needs an explicit delivery: \"foreground\" and a target window that is already frontmost; the helper does not activate windows or take focus.",
      "A background failure is never automatically retried as foreground; pass delivery: \"foreground\" explicitly and only when moving the real cursor is acceptable.",
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
      "On macOS, coordinate pointer actions inside a step default to background delivery. Judge them against the structure computer_status reports: outside the verified scope the action is not dispatched, the run stops with the background_unavailable: prefix, effectsUnknown stays false, and the limitation should be reported instead of retried.",
      "A background failure inside a run never falls back to foreground; pass delivery: \"foreground\" on the action, and only when moving the real cursor is acceptable.",
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

  readonly title: string;

  readonly description: string;

  readonly promptSnippet: string;

  readonly promptGuidelines: readonly string[];

  readonly readOnly: boolean;

  readonly parameters: TSchema;
}

export const COMPUTER_TOOLS: readonly (ComputerToolContract & { readonly name: ComputerToolName })[] =
  COMPUTER_TOOL_NAMES.map((name) => ({ name, ...COMPUTER_TOOL_CONTRACTS[name] }));
