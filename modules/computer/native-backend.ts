// computer 真后端（工单 08 接通 status；工单 09 接上 roots；工单 10 接上 observe；工单 11 接上 act；工单 12 接上 focused 与 activate；工单 29 接上 probe）：把 ComputerBackend 的接缝接到桥与 Rust helper 上。
//
// helper 二进制的查找规则（工单 08 定案；工单 07 按 D6 方案 A 补随包分发）：
// 1. 环境变量 PI_COMPUTER_HELPER 指向的绝对路径，最高优先级；
// 2. 随包二进制：模块目录下的 native-bin/（发布时由 scripts/pi-toolkit/build-release.mjs 按平台带上）；
// 3. 开发期构建产物：runtime/pi-toolkit/native-bin/，由 scripts/pi-toolkit/build-computer-helper.mjs 生成；
// 4. 都没有就报 bridge_unavailable，detail 给两个查找位置与构建/override 指引，不现场编译。

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createComputerBridge, type BridgeLaunchSpec, type ComputerBridge } from "./bridge.ts";
import { isValidImageFrame } from "./coordinates.ts";
import type {
  ComputerBackend,
  ComputerBackendActRequest,
  ComputerBackendObservation,
  ComputerBackendProbeRequest,
  ComputerCaptureRecord,
  ComputerCaptureRequest,
  ComputerCaptureSource,
  ComputerDisplayInfo,
  ComputerFocusSnapshot,
} from "./backend.ts";
import {
  COMPUTER_ROOT_KINDS,
  computerPlatformFromNode,
  unavailableCapabilities,
  type ComputerBounds,
  type ComputerCapabilities,
  type ComputerResult,
  type ComputerRootKind,
  type ComputerStatusData,
} from "./contract.ts";
import type { ComputerObservedNode, ComputerRootDescriptor } from "./state.ts";

/** helper 二进制名；P1 只有 Windows 后端，其余平台留出名字以便构建脚本保持同一套规则 */
export const COMPUTER_HELPER_BINARY = process.platform === "win32" ? "pi-computer-helper.exe" : "pi-computer-helper";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export type ComputerHelperPathResolution =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly detail: string };

/** 查找用的目录与环境来源；默认取真实模块目录与 process.env，测试注入 temp 布局 */
export interface ComputerHelperPathOptions {
  /** 模块目录（默认本文件所在目录）：随包二进制在它下面的 `native-bin/` */
  readonly moduleDir?: string;
  /**
   * 仓库根：默认从模块目录上溯五级得到（extensions/pi-toolkit/source/modules/computer → 仓库根）。
   * 五级是开发期布局的固定深度；装好的包里这个默认值会指到包外，所以它只是回落，优先走随包目录。
   */
  readonly repoRoot?: string;
  /** 读 `PI_COMPUTER_HELPER` 的来源（默认 process.env） */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export function resolveComputerHelperPath(options: ComputerHelperPathOptions = {}): ComputerHelperPathResolution {
  const moduleDir = options.moduleDir ?? MODULE_DIR;
  const repoRoot = options.repoRoot ?? path.resolve(moduleDir, "..", "..", "..", "..", "..");
  const env = options.env ?? process.env;
  const override = env.PI_COMPUTER_HELPER?.trim();
  if (override) {
    return existsSync(override)
      ? { ok: true, path: override }
      : { ok: false, detail: `PI_COMPUTER_HELPER points at a missing file: ${override}` };
  }
  const packagedPath = path.join(moduleDir, "native-bin", COMPUTER_HELPER_BINARY);
  if (existsSync(packagedPath)) return { ok: true, path: packagedPath };
  const devPath = path.join(repoRoot, "runtime", "pi-toolkit", "native-bin", COMPUTER_HELPER_BINARY);
  if (existsSync(devPath)) return { ok: true, path: devPath };
  return {
    ok: false,
    detail:
      `computer helper binary not found (looked in ${packagedPath}, then ${devPath}); ` +
      `in a development checkout build it with "node scripts/pi-toolkit/build-computer-helper.mjs", ` +
      `otherwise point PI_COMPUTER_HELPER at an existing binary`,
  };
}

export interface NativeComputerBackendOptions {
  /** 覆盖 helper 二进制路径；不传时走查找规则（测试与排障用） */
  readonly helperPath?: string;
  /** 覆盖整个启动规格（如用 node 跑桩 helper）；给了就用它，不再走路径查找 */
  readonly launch?: BridgeLaunchSpec;
  /** 桥的单次调用超时；不传用桥的默认值 */
  readonly callTimeoutMs?: number;
}

/**
 * 解析 helper 的 `roots` 载荷（线上边界）：结构不对或取值越界一律 undefined，由调用方按失败上报。
 * 未知字段忽略；契约里 `focused` 是可选字段，缺失按 false。
 */
export function parseRootsResult(value: unknown): readonly ComputerRootDescriptor[] | undefined {
  if (!isRecord(value)) return undefined;
  const roots = value.roots;
  if (!Array.isArray(roots)) return undefined;
  const parsed: ComputerRootDescriptor[] = [];
  for (const entry of roots) {
    if (!isRecord(entry)) return undefined;
    const { key, kind, title, app, focused } = entry;
    if (typeof key !== "string" || key.length === 0) return undefined;
    if (typeof kind !== "string" || !(COMPUTER_ROOT_KINDS as readonly string[]).includes(kind)) return undefined;
    if (typeof title !== "string" || typeof app !== "string") return undefined;
    if (focused !== undefined && typeof focused !== "boolean") return undefined;
    parsed.push({ key, kind: kind as ComputerRootKind, title, app, focused: focused ?? false });
  }
  return parsed;
}

/**
 * 解析 helper 的 `observe` 载荷（线上边界）：tree 与 truncated 的结构、类型、取值域都不对就判 undefined，
 * 由调用方按失败上报。未知字段忽略；缺席的可选字段不补默认值（默认值由状态层掌握，线上边界只转述）。
 */
export function parseObserveResult(value: unknown): ComputerBackendObservation | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.truncated !== "boolean") return undefined;
  const tree = parseObservedNode(value.tree);
  if (tree === undefined) return undefined;
  return { tree, truncated: value.truncated };
}

/**
 * 解析 helper 的 `probe` 载荷（线上边界）：found 必须是布尔，其余判 undefined，
 * 由调用方按失败上报。未知字段忽略；probe 的回执就这一个字段，载荷畸形说明线上有东西在乱写。
 */
export function parseProbeResult(value: unknown): boolean | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.found !== "boolean") return undefined;
  return value.found;
}

/**
 * 解析 helper 的 `focused` 载荷（线上边界）：root 必填非空字符串，element 可选；
 * element 出现时 role 必填非空，其余可选字段类型不对就判 undefined，由调用方按失败上报。
 * 未知字段忽略；缺席的可选字段不补默认值（与 observe 同一套「缺失不是空值」口径）。
 */
export function parseFocusResult(value: unknown): ComputerFocusSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const { root, element } = value;
  if (typeof root !== "string" || root.length === 0) return undefined;
  if (element === undefined) return { root };
  if (!isRecord(element)) return undefined;
  const { root: elementRoot, role, name, value: elementValue, description, enabled, bounds } = element;
  if (elementRoot !== undefined && (typeof elementRoot !== "string" || elementRoot.length === 0)) return undefined;
  if (typeof role !== "string" || role.length === 0) return undefined;
  if (name !== undefined && typeof name !== "string") return undefined;
  if (elementValue !== undefined && typeof elementValue !== "string") return undefined;
  if (description !== undefined && typeof description !== "string") return undefined;
  if (enabled !== undefined && typeof enabled !== "boolean") return undefined;
  let parsedBounds: ComputerBounds | undefined;
  if (bounds !== undefined) {
    parsedBounds = parseComputerBounds(bounds);
    if (parsedBounds === undefined) return undefined;
  }
  return {
    root,
    element: {
      ...(elementRoot !== undefined ? { root: elementRoot } : {}),
      role,
      ...(name !== undefined ? { name } : {}),
      ...(elementValue !== undefined ? { value: elementValue } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
      ...(parsedBounds !== undefined ? { bounds: parsedBounds } : {}),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 解析 helper 的 `displays` 载荷（线上边界）：数组里每一项都必须是形状完整的显示器，
 * 有一项不规则就整份判 undefined，由调用方按失败上报；不知道的字段忽略。
 */
export function parseDisplaysResult(value: unknown): readonly ComputerDisplayInfo[] | undefined {
  if (!isRecord(value)) return undefined;
  const displays = value.displays;
  if (!Array.isArray(displays)) return undefined;
  const parsed: ComputerDisplayInfo[] = [];
  for (const entry of displays) {
    const display = parseDisplayInfo(entry);
    if (display === undefined) return undefined;
    parsed.push(display);
  }
  // 桥协议要求真机恰好一台主屏；一份清单里 0 台或 2 台主屏都说明载荷不可信
  if (parsed.filter((display) => display.primary).length !== 1) return undefined;
  return parsed;
}

/** 单个显示器条目：id 与几何是非负/正整数，scaleFactor 为正数，primary 是布尔 */
function parseDisplayInfo(value: unknown): ComputerDisplayInfo | undefined {
  if (!isRecord(value)) return undefined;
  const { id, device, originX, originY, width, height, scaleFactor, primary } = value;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 0) return undefined;
  if (typeof device !== "string") return undefined;
  if (typeof originX !== "number" || !Number.isSafeInteger(originX)) return undefined;
  if (typeof originY !== "number" || !Number.isSafeInteger(originY)) return undefined;
  if (typeof width !== "number" || !Number.isSafeInteger(width) || width <= 0) return undefined;
  if (typeof height !== "number" || !Number.isSafeInteger(height) || height <= 0) return undefined;
  if (typeof scaleFactor !== "number" || !Number.isFinite(scaleFactor) || scaleFactor <= 0) return undefined;
  if (typeof primary !== "boolean") return undefined;
  return { id, device, originX, originY, width, height, scaleFactor, primary };
}

/**
 * 解析 helper 的 `capture` 载荷（线上边界）：path、image、region 必填，display 可选；
 * 任何一处形状或取值不对就整份判 undefined，由调用方按失败上报。
 */
export function parseCaptureResult(value: unknown): ComputerCaptureRecord | undefined {
  if (!isRecord(value)) return undefined;
  const {
    path: capturedPath,
    image,
    region,
    display,
    window: capturedWindow,
    source,
    mayBeObscured,
  } = value;
  if (typeof capturedPath !== "string" || capturedPath.length === 0) return undefined;
  if (!isRecord(image)) return undefined;
  const { width, height, bytes, format, scale } = image;
  if (typeof width !== "number" || !Number.isSafeInteger(width) || width <= 0) return undefined;
  if (typeof height !== "number" || !Number.isSafeInteger(height) || height <= 0) return undefined;
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) return undefined;
  if (typeof format !== "string" || format.length === 0) return undefined;
  if (typeof scale !== "number" || !Number.isFinite(scale)) return undefined;
  const parsedRegion = parseComputerBounds(region);
  if (parsedRegion === undefined) return undefined;
  // 图面坐标系是坐标换算的唯一依据（工单 17）：区域有正面积、scale 与图像宽/区域宽一致，否则判载荷畸形
  if (!isValidImageFrame(parsedRegion, { width, height, scale })) return undefined;
  let parsedDisplay: ComputerDisplayInfo | undefined;
  if (display !== undefined) {
    parsedDisplay = parseDisplayInfo(display);
    if (parsedDisplay === undefined) return undefined;
  }
  // 窗口采集的字段成组出现且与 display 互斥：window 在就必须有合法的 source 与 mayBeObscured
  let windowFields: Pick<ComputerCaptureRecord, "window" | "source" | "mayBeObscured"> = {};
  if (capturedWindow !== undefined) {
    if (!isRecord(capturedWindow)) return undefined;
    const key = capturedWindow.key;
    if (typeof key !== "string" || key.length === 0) return undefined;
    if (source !== "print_window" && source !== "screen_region" && source !== "quartz_window") return undefined;
    if (typeof mayBeObscured !== "boolean") return undefined;
    // 协议不变量：回退屏幕区域就是可能被遮挡，PrintWindow 就是没有
    if (mayBeObscured !== (source === "screen_region")) return undefined;
    if (parsedDisplay !== undefined) return undefined;
    windowFields = {
      window: { key },
      source: source as ComputerCaptureSource,
      mayBeObscured,
    };
  } else if (source !== undefined || mayBeObscured !== undefined) {
    // 显示器回执不带来源字段；塞进来的一律判畸形，不静默忽略
    return undefined;
  }
  return {
    path: capturedPath,
    image: { width, height, bytes, format, scale },
    region: parsedRegion,
    ...(parsedDisplay !== undefined ? { display: parsedDisplay } : {}),
    ...windowFields,
  };
}

/** bounds 的线上形状：四个有限数字；「缺失」与「畸形」的区分由调用方掌握 */
function parseComputerBounds(value: unknown): ComputerBounds | undefined {
  if (!isRecord(value)) return undefined;
  const { x, y, width, height } = value;
  if (typeof x !== "number" || typeof y !== "number" || typeof width !== "number" || typeof height !== "number") {
    return undefined;
  }
  if (![x, y, width, height].every(Number.isFinite)) return undefined;
  return { x, y, width, height };
}

function parseObservedNode(value: unknown): ComputerObservedNode | undefined {
  if (!isRecord(value)) return undefined;
  const { role, name, value: nodeValue, description, enabled, focused, bounds, actions, text, children } = value;
  if (typeof role !== "string" || role.length === 0) return undefined;
  if (name !== undefined && typeof name !== "string") return undefined;
  if (nodeValue !== undefined && typeof nodeValue !== "string") return undefined;
  if (description !== undefined && typeof description !== "string") return undefined;
  if (enabled !== undefined && typeof enabled !== "boolean") return undefined;
  if (focused !== undefined && typeof focused !== "boolean") return undefined;
  if (text !== undefined && typeof text !== "string") return undefined;

  let parsedBounds: ComputerBounds | undefined;
  if (bounds !== undefined) {
    parsedBounds = parseComputerBounds(bounds);
    if (parsedBounds === undefined) return undefined;
  }

  let parsedActions: readonly string[] | undefined;
  if (actions !== undefined) {
    if (!Array.isArray(actions) || !actions.every((action) => typeof action === "string")) return undefined;
    parsedActions = actions as readonly string[];
  }

  let parsedChildren: readonly ComputerObservedNode[] | undefined;
  if (children !== undefined) {
    if (!Array.isArray(children)) return undefined;
    const list: ComputerObservedNode[] = [];
    for (const child of children) {
      const parsedChild = parseObservedNode(child);
      if (parsedChild === undefined) return undefined;
      list.push(parsedChild);
    }
    parsedChildren = list;
  }

  return {
    role,
    ...(name !== undefined ? { name } : {}),
    ...(nodeValue !== undefined ? { value: nodeValue } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
    ...(focused !== undefined ? { focused } : {}),
    ...(parsedBounds !== undefined ? { bounds: parsedBounds } : {}),
    ...(parsedActions !== undefined ? { actions: parsedActions } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(parsedChildren !== undefined ? { children: parsedChildren } : {}),
  };
}

export function createNativeComputerBackend(options: NativeComputerBackendOptions = {}): ComputerBackend {
  const platform = computerPlatformFromNode(process.platform);
  let bridge: ComputerBridge | undefined;

  const ensureBridge = (): ComputerResult<ComputerBridge> => {
    if (bridge !== undefined) return { ok: true, data: bridge };
    let launchSpec: BridgeLaunchSpec;
    if (options.launch !== undefined) {
      launchSpec = options.launch;
    } else {
      const resolution: ComputerHelperPathResolution =
        options.helperPath === undefined ? resolveComputerHelperPath() : { ok: true, path: options.helperPath };
      if (!resolution.ok) return { ok: false, error: { code: "bridge_unavailable", detail: resolution.detail } };
      launchSpec = { command: resolution.path };
    }
    bridge = createComputerBridge(
      options.callTimeoutMs === undefined
        ? { launch: launchSpec }
        : { launch: launchSpec, callTimeoutMs: options.callTimeoutMs },
    );
    return { ok: true, data: bridge };
  };

  /** 业务方法共用的前置：桥可用、握手完成，才算走到业务调用这一步 */
  const readyBridge = async (): Promise<ComputerResult<ComputerBridge>> => {
    const connected = ensureBridge();
    if (!connected.ok) return connected;
    const ready = await connected.data.ensureReady();
    return ready.ok ? connected : ready;
  };

  /** 桥不可用时的状态：能力按未知上报，把不可用的原因挂进 limits，模型看得见为什么 */
  const notReadyStatus = (detail: string): ComputerStatusData => ({
    capabilities: { ...unavailableCapabilities(platform), limits: [detail] },
    bridge: { protocolVersion: null, ready: false },
  });

  return {
    async status(): Promise<ComputerResult<ComputerStatusData>> {
      const connected = await readyBridge();
      if (!connected.ok) return { ok: true, data: notReadyStatus(connected.error.detail ?? connected.error.code) };
      const capabilities: ComputerCapabilities = connected.data.handshake?.capabilities ?? unavailableCapabilities(platform);
      return {
        ok: true,
        data: {
          capabilities,
          bridge: { protocolVersion: connected.data.protocolVersion, ready: connected.data.ready },
        },
      };
    },

    async roots(): Promise<ComputerResult<readonly ComputerRootDescriptor[]>> {
      const connected = await readyBridge();
      if (!connected.ok) return connected;
      const response = await connected.data.call<unknown>("roots", {});
      if (!response.ok) return response;
      const roots = parseRootsResult(response.data);
      if (roots === undefined) {
        // 这里通道已经通了（握手过了），坏的是业务载荷：按执行失败上报，不报「helper 未运行」
        return { ok: false, error: { code: "action_failed", detail: "helper 的 roots 载荷不合法" } };
      }
      return { ok: true, data: roots };
    },

    async observe(rootKey: string): Promise<ComputerResult<ComputerBackendObservation>> {
      const connected = await readyBridge();
      if (!connected.ok) return connected;
      const response = await connected.data.call<unknown>("observe", { key: rootKey });
      if (!response.ok) return response;
      const parsed = parseObserveResult(response.data);
      if (parsed === undefined) {
        // 通道已握手成功，坏的是业务载荷：按执行失败上报，不报「helper 未运行」
        return { ok: false, error: { code: "action_failed", detail: "helper 的 observe 载荷不合法" } };
      }
      return { ok: true, data: parsed };
    },

    async act(request: ComputerBackendActRequest): Promise<ComputerResult<ComputerBackendObservation>> {
      const connected = await readyBridge();
      if (!connected.ok) return connected;
      const response = await connected.data.call<unknown>("act", actPayload(request));
      if (!response.ok) return response;
      // act 的回执与 observe 同一形状（树 + 原生截断标记），解析与报错口径也一致
      const parsed = parseObserveResult(response.data);
      if (parsed === undefined) {
        // 通道已握手成功，坏的是业务载荷：按执行失败上报，不报「helper 未运行」
        return { ok: false, error: { code: "action_failed", detail: "helper 的 act 载荷不合法" } };
      }
      return { ok: true, data: parsed };
    },

    async probe(request: ComputerBackendProbeRequest): Promise<ComputerResult<boolean>> {
      const connected = await readyBridge();
      if (!connected.ok) return connected;
      const response = await connected.data.call<unknown>("probe", {
        key: request.rootKey,
        text: request.text,
        ...(request.path !== undefined ? { path: [...request.path] } : {}),
        ...(request.role !== undefined ? { role: request.role } : {}),
        ...(request.name !== undefined ? { name: request.name } : {}),
      });
      if (!response.ok) return response;
      const found = parseProbeResult(response.data);
      if (found === undefined) {
        // 通道已握手成功，坏的是业务载荷：按执行失败上报，不报「helper 未运行」
        return { ok: false, error: { code: "action_failed", detail: "helper 的 probe 载荷不合法" } };
      }
      return { ok: true, data: found };
    },

    async focused(): Promise<ComputerResult<ComputerFocusSnapshot>> {
      const connected = await readyBridge();
      if (!connected.ok) return connected;
      const response = await connected.data.call<unknown>("focused", {});
      if (!response.ok) return response;
      const parsed = parseFocusResult(response.data);
      if (parsed === undefined) {
        // 通道已握手成功，坏的是业务载荷：按执行失败上报，不报「helper 未运行」
        return { ok: false, error: { code: "action_failed", detail: "helper 的 focused 载荷不合法" } };
      }
      return { ok: true, data: parsed };
    },

    async activate(rootKey: string): Promise<ComputerResult<void>> {
      const connected = await readyBridge();
      if (!connected.ok) return connected;
      // 成功时 helper 已核对过目标确实是新的前台窗口，回空 result；失败原因原样透传
      const response = await connected.data.call<unknown>("activate", { key: rootKey });
      if (!response.ok) return response;
      return { ok: true, data: undefined };
    },

    async displays(): Promise<ComputerResult<readonly ComputerDisplayInfo[]>> {
      const connected = await readyBridge();
      if (!connected.ok) return connected;
      const response = await connected.data.call<unknown>("displays", {});
      if (!response.ok) return response;
      const displays = parseDisplaysResult(response.data);
      if (displays === undefined) {
        // 通道已握手成功，坏的是业务载荷：按执行失败上报，不报「helper 未运行」
        return { ok: false, error: { code: "action_failed", detail: "helper 的 displays 载荷不合法" } };
      }
      return { ok: true, data: displays };
    },

    async capture(request: ComputerCaptureRequest): Promise<ComputerResult<ComputerCaptureRecord>> {
      const connected = await readyBridge();
      if (!connected.ok) return connected;
      const response = await connected.data.call<unknown>("capture", {
        target:
          request.target.kind === "display"
            ? { kind: "display", id: request.target.id }
            : { kind: "window", key: request.target.key },
        path: request.path,
        ...(request.maxLongEdge !== undefined ? { maxLongEdge: request.maxLongEdge } : {}),
      });
      if (!response.ok) return response;
      const record = parseCaptureResult(response.data);
      if (record === undefined) {
        // 通道已握手成功，坏的是业务载荷：按执行失败上报，不报「helper 未运行」
        return { ok: false, error: { code: "action_failed", detail: "helper 的 capture 载荷不合法" } };
      }
      // 回执路径必须与请求一致：路径由调用方指定，helper 只能原样回；不一致说明线上有东西在乱写
      if (record.path !== request.path) {
        return { ok: false, error: { code: "action_failed", detail: "helper 回执的图片路径与请求不一致" } };
      }
      return { ok: true, data: record };
    },

    async cursor(visible: boolean): Promise<ComputerResult<void>> {
      // 隐藏是 turn_end 的例行收尾（工单 24）：桥还没创建过时直接成功，不为没碰过指针的会话
      // 拉起 helper 进程（覆盖层从没显示过，无可隐藏）
      if (!visible && bridge === undefined) return { ok: true, data: undefined };
      const connected = await readyBridge();
      if (!connected.ok) return connected;
      const response = await connected.data.call<unknown>("cursor", { visible });
      if (!response.ok) return response;
      return { ok: true, data: undefined };
    },
  };
}

/**
 * 接缝动作 → 桥的 act args（线上形状按桥协议登记）：只发 helper 需要的字段——动作名、
 * setText/typeText 的文本、keypress 的键名序列、坐标与滚轮步进（工具层已把图面像素换成虚拟桌面
 * 物理像素）、坐标点击的 button/count、结构路径与观察时的身份；契约动作里的 ref 供工具层解析目标，不出线。
 */
function actPayload(request: ComputerBackendActRequest): Record<string, unknown> {
  return {
    key: request.rootKey,
    actions: request.actions.map((entry) => ({
      action: entry.command.action,
      ...(entry.command.delivery !== undefined ? { delivery: entry.command.delivery } : {}),
      ...(entry.command.text !== undefined ? { text: entry.command.text } : {}),
      ...(entry.command.keys !== undefined ? { keys: [...entry.command.keys] } : {}),
      ...(entry.command.x !== undefined ? { x: entry.command.x } : {}),
      ...(entry.command.y !== undefined ? { y: entry.command.y } : {}),
      ...(entry.command.toX !== undefined ? { toX: entry.command.toX } : {}),
      ...(entry.command.toY !== undefined ? { toY: entry.command.toY } : {}),
      ...(entry.command.deltaX !== undefined ? { deltaX: entry.command.deltaX } : {}),
      ...(entry.command.deltaY !== undefined ? { deltaY: entry.command.deltaY } : {}),
      ...(entry.command.button !== undefined ? { button: entry.command.button } : {}),
      ...(entry.command.count !== undefined ? { count: entry.command.count } : {}),
      ...(entry.target !== undefined
        ? {
            target: {
              path: [...entry.target.path],
              role: entry.target.role,
              ...(entry.target.name !== undefined ? { name: entry.target.name } : {}),
            },
          }
        : {}),
    })),
  };
}
