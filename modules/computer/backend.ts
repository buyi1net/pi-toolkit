// computer 模块原生层接缝（工单 05；工单 12 补焦点与窗口管理）：工具层需要后端做的六件事。
//
// 这是 P0 定下的窄边界，两份实现共用它：mock（tests/pi-toolkit/computer-harness.ts）
// 与 P1 起的真后端（桥 + 原生 helper）。边界之上只走契约形数据：
// - 根用 ComputerRootDescriptor 的稳定 key 表示；@rN/@eN 编号、快照、陈旧判定全在状态层，
//   后端不认识引用，也不产生引用（state.ts 是唯一语义）；
// - 动作的目标由工具层按当前快照解析成「结构路径 + 观察时看到的身份」，后端执行前核对身份：
//   对不上说明界面在观察之后变了，报 stale_ref，而不是把动作落到那个位置上的新元素。

import {
  computerPlatformFromNode,
  unavailableCapabilities,
  type ComputerAction,
  type ComputerBounds,
  type ComputerCaptureImage,
  type ComputerCaptureRecord,
  type ComputerCaptureSource,
  type ComputerDisplayInfo,
  type ComputerResult,
  type ComputerStatusData,
} from "./contract.ts";
import type { ComputerObservedNode, ComputerRootDescriptor } from "./state.ts";

// 采集记录的载荷类型定义在 contract.ts（工单 17：状态层也要用它绑定坐标口径）；这里转出，保持既有导入路径可用
export type { ComputerCaptureImage, ComputerCaptureRecord, ComputerCaptureSource, ComputerDisplayInfo } from "./contract.ts";

/**
 * 动作目标：工具层从当前快照解析出的定位。
 * path 是从根节点起的子节点下标链，空数组表示根本身（键盘输入发给窗口时用）。
 */
export interface ComputerBackendTarget {
  readonly path: readonly number[];
  /** 观察时该节点的角色与名字；后端执行前核对，对不上按 stale_ref 拒绝 */
  readonly role: string;
  readonly name?: string;
}

/**
 * 一条待执行动作：契约动作原样带过（含 ref，供日志排查），
 * 后端执行只看 target；坐标类动作没有 target。
 */
export interface ComputerBackendAction {
  readonly command: ComputerAction;
  readonly target?: ComputerBackendTarget;
}

export interface ComputerBackendActRequest {
  /** 目标根的稳定 key（工具层从当前快照的作用域取） */
  readonly rootKey: string;
  readonly actions: readonly ComputerBackendAction[];
}

/**
 * 一次原生文本探测的请求（工单 29）：等待轮询的 text 条件优先走它，helper 内命中即停，
 * 不把整棵语义树搬回工具层。path/role/name 限定子树（与动作目标的定位同构）：
 * 路径落空或身份对不上都算「子树不存在」，按 found=false 回，不报错。
 */
export interface ComputerBackendProbeRequest {
  readonly rootKey: string;
  /** 非空子串；大小写不敏感，比 name/value/description/text（与文本评分同口径） */
  readonly text: string;
  /** 子节点下标链（从根起）；缺省表示全树但不含根本身（与无范围文本匹配同口径） */
  readonly path?: readonly number[];
  /** 观察时该节点的角色与名字；helper 在路径终点核对，对不上按子树不存在处理 */
  readonly role?: string;
  readonly name?: string;
}

/**
 * 一次焦点快照的焦点元素：字段口径与观察节点一致（空名字按没读到处理，值读到空串也如实带上）。
 * 没有 ref / path：焦点是当前时刻的读数，要动作就重新观察拿引用。
 */
export interface ComputerFocusElement {
  /** 焦点元素所属根的 key（与 roots 的 key 同口径）；读不到时不写 */
  readonly root?: string;
  readonly role: string;
  readonly name?: string;
  readonly value?: string;
  readonly description?: string;
  readonly enabled?: boolean;
  readonly bounds?: ComputerBounds;
}

/**
 * 一次焦点快照：前台窗口的根 key（与 roots 的 key 同口径）与当前键盘焦点元素。
 * element 缺席是「没读到」：前台判定不依赖 UIA，UIA 不可用时 root 照报。
 */
export interface ComputerFocusSnapshot {
  readonly root: string;
  readonly element?: ComputerFocusElement;
}

/**
 * 原生层接缝。十个方法都返回 ComputerResult：
 * - status：能力与桥状态；原生层未接入时如实上报不支持，不假装支持
 * - roots：当前可操作根；引用由状态层按 key 分配
 * - observe：观察一个根的语义树（不含引用），带原生层的结构性截断标记
 * - act：执行动作并回执执行后同一根的最新语义树；回执与 observe 同一形状（含截断标记），
 *   树是动作之后重新读的界面，setText 的 value 来自回读
 * - focused：读当前前台窗口与焦点元素；前台判定不依赖 UIA，元素读不到时 element 缺席
 * - activate：把指定根带到前台；系统不允许时如实报错，不假装成功
 * - displays：列出显示器（原点/尺寸/缩放/主屏），采集与坐标换算（工单 15/17）的几何来源
 * - capture：按目标采集一张图落盘，交回图像元数据与采集区域；路径由调用方给定
 * - cursor：显示/隐藏 AI 光标覆盖层（工单 24）；turn_end 收尾隐藏与生命周期管理用它
 * - probe：在语义树里探测文本（工单 29）；helper 内命中即停、回执只有 found 布尔，
 *   等待轮询的 text 条件优先走它，长等待期间不再整树搬运
 */
export interface ComputerBackend {
  status(): Promise<ComputerResult<ComputerStatusData>>;
  roots(): Promise<ComputerResult<readonly ComputerRootDescriptor[]>>;
  observe(rootKey: string): Promise<ComputerResult<ComputerBackendObservation>>;
  act(request: ComputerBackendActRequest): Promise<ComputerResult<ComputerBackendObservation>>;
  /** 在一个根的语义树里探测文本；found=false 涵盖「没命中」与「子树不存在」，不报错区分 */
  probe(request: ComputerBackendProbeRequest): Promise<ComputerResult<boolean>>;
  focused(): Promise<ComputerResult<ComputerFocusSnapshot>>;
  activate(rootKey: string): Promise<ComputerResult<void>>;
  displays(): Promise<ComputerResult<readonly ComputerDisplayInfo[]>>;
  capture(request: ComputerCaptureRequest): Promise<ComputerResult<ComputerCaptureRecord>>;
  /**
   * 显示或隐藏 AI 光标覆盖层（工单 24）。隐藏是 turn_end 的例行收尾：
   * 桥从未创建过（还没拉起 helper）时直接成功，不为隐藏启动进程。
   */
  cursor(visible: boolean): Promise<ComputerResult<void>>;
}

/** 采集目标：显示器（displays 的 id）或窗口（roots 的根 key，与工具层的作用域同口径） */
export type ComputerCaptureTarget =
  | { readonly kind: "display"; readonly id: number }
  | { readonly kind: "window"; readonly key: string };

/** 一次采集请求；path 必须是绝对路径，由工具层生成，绝不接受模型传入的路径 */
export interface ComputerCaptureRequest {
  readonly target: ComputerCaptureTarget;
  readonly path: string;
  /** 长边上限（像素）；不传按原尺寸。helper 只缩不放，实际缩放比在回执的 image.scale */
  readonly maxLongEdge?: number;
}

/**
 * 一次观察的结果：语义树与结构性截断标记。
 * truncated 为 true 表示原生层的深度或节点数上限挡短了树，模型可见回执要如实带上。
 */
export interface ComputerBackendObservation {
  readonly tree: ComputerObservedNode;
  readonly truncated: boolean;
}

/**
 * P0 默认后端：还没有原生层，一切如实上报不支持。
 * status 返回未探测的能力快照；其余调用判 bridge_unavailable，不假装成功。
 */
export function createUnavailableComputerBackend(): ComputerBackend {
  const platform = computerPlatformFromNode(process.platform);
  const bridgeDown = <T>(what: string): ComputerResult<T> => ({
    ok: false,
    error: { code: "bridge_unavailable", detail: `no native backend is wired up yet (${what})` },
  });
  return {
    status: async () => ({
      ok: true,
      data: {
        capabilities: unavailableCapabilities(platform),
        bridge: { protocolVersion: null, ready: false },
      },
    }),
    roots: async () => bridgeDown("roots"),
    observe: async () => bridgeDown("observe"),
    act: async () => bridgeDown("act"),
    probe: async () => bridgeDown("probe"),
    focused: async () => bridgeDown("focused"),
    activate: async () => bridgeDown("activate"),
    displays: async () => bridgeDown("displays"),
    capture: async () => bridgeDown("capture"),
    cursor: async () => bridgeDown("cursor"),
  };
}
