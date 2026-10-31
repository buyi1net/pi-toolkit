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
  type ComputerWindowIdentity,
} from "./contract.ts";
import type { ComputerObservedNode, ComputerRootDescriptor } from "./state.ts";

export const COMPUTER_HELPER_BINARY = process.platform === "win32" ? "pi-computer-helper.exe" : "pi-computer-helper";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export type ComputerHelperPathResolution =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly detail: string };

export interface ComputerHelperPathOptions {

  readonly moduleDir?: string;

  readonly repoRoot?: string;

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

  readonly helperPath?: string;

  readonly launch?: BridgeLaunchSpec;

  readonly callTimeoutMs?: number;
}

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

export function parseObserveResult(value: unknown): ComputerBackendObservation | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.truncated !== "boolean") return undefined;
  const tree = parseObservedNode(value.tree);
  if (tree === undefined) return undefined;
  return { tree, truncated: value.truncated };
}

export function parseProbeResult(value: unknown): boolean | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.found !== "boolean") return undefined;
  return value.found;
}

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

  if (parsed.filter((display) => display.primary).length !== 1) return undefined;
  return parsed;
}

function parseDisplayList(value: unknown): readonly ComputerDisplayInfo[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parsed: ComputerDisplayInfo[] = [];
  for (const entry of value) {
    const display = parseDisplayInfo(entry);
    if (display === undefined) return undefined;
    parsed.push(display);
  }
  if (parsed.length === 0 || parsed.filter((display) => display.primary).length !== 1) return undefined;
  return parsed;
}

function parseWindowIdentity(value: Record<string, unknown>): ComputerWindowIdentity | undefined {
  const key = value.key;
  if (typeof key !== "string" || key.length === 0) return undefined;
  let parsed: ComputerWindowIdentity = { key };
  if (value.pid !== undefined) {
    if (typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0) return undefined;
    parsed = { ...parsed, pid: value.pid };
  }
  if (value.startIdentity !== undefined) {
    if (!isRecord(value.startIdentity)) return undefined;
    const { seconds, microseconds } = value.startIdentity;
    if (
      typeof seconds !== "number" ||
      typeof microseconds !== "number" ||
      !Number.isSafeInteger(seconds) ||
      !Number.isSafeInteger(microseconds) ||
      seconds < 0 ||
      microseconds < 0
    ) return undefined;
    parsed = { ...parsed, startIdentity: { seconds, microseconds } };
  }
  if (value.windowId !== undefined) {
    if (typeof value.windowId !== "number" || !Number.isSafeInteger(value.windowId) || value.windowId < 0) return undefined;
    parsed = { ...parsed, windowId: value.windowId };
  }
  if (value.app !== undefined && (typeof value.app !== "string" || value.app.length === 0)) return undefined;
  if (value.app !== undefined) parsed = { ...parsed, app: value.app };
  if (value.bounds !== undefined) {
    const bounds = parseComputerBounds(value.bounds);
    if (bounds === undefined || bounds.width <= 0 || bounds.height <= 0) return undefined;
    parsed = { ...parsed, bounds };
  }
  return parsed;
}

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
    displays,
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

  if (!isValidImageFrame(parsedRegion, { width, height, scale })) return undefined;
  let parsedDisplay: ComputerDisplayInfo | undefined;
  if (display !== undefined) {
    parsedDisplay = parseDisplayInfo(display);
    if (parsedDisplay === undefined) return undefined;
  }
  let parsedDisplays: readonly ComputerDisplayInfo[] | undefined;
  if (displays !== undefined) {
    parsedDisplays = parseDisplayList(displays);
    if (parsedDisplays === undefined) return undefined;
  }

  let windowFields: Pick<ComputerCaptureRecord, "window" | "source" | "mayBeObscured"> = {};
  if (capturedWindow !== undefined) {
    if (!isRecord(capturedWindow)) return undefined;
    const key = capturedWindow.key;
    if (typeof key !== "string" || key.length === 0) return undefined;
    const parsedWindow = parseWindowIdentity(capturedWindow);
    if (parsedWindow === undefined) return undefined;
    if (source !== "print_window" && source !== "screen_region" && source !== "quartz_window") return undefined;
    if (typeof mayBeObscured !== "boolean") return undefined;

    if (mayBeObscured !== (source === "screen_region")) return undefined;
    if (parsedDisplay !== undefined) return undefined;
    windowFields = {
      window: parsedWindow,
      source: source as ComputerCaptureSource,
      mayBeObscured,
    };
  } else if (source !== undefined || mayBeObscured !== undefined) {

    return undefined;
  }
  return {
    path: capturedPath,
    image: { width, height, bytes, format, scale },
    region: parsedRegion,
    ...(parsedDisplay !== undefined ? { display: parsedDisplay } : {}),
    ...(parsedDisplays !== undefined ? { displays: parsedDisplays } : {}),
    ...windowFields,
  };
}

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

  const readyBridge = async (): Promise<ComputerResult<ComputerBridge>> => {
    const connected = ensureBridge();
    if (!connected.ok) return connected;
    const ready = await connected.data.ensureReady();
    return ready.ok ? connected : ready;
  };

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

        return { ok: false, error: { code: "action_failed", detail: "helper 的 observe 载荷不合法" } };
      }
      return { ok: true, data: parsed };
    },

    async act(request: ComputerBackendActRequest): Promise<ComputerResult<ComputerBackendObservation>> {
      const connected = await readyBridge();
      if (!connected.ok) return connected;
      const response = await connected.data.call<unknown>("act", actPayload(request));
      if (!response.ok) return response;

      const parsed = parseObserveResult(response.data);
      if (parsed === undefined) {

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

        return { ok: false, error: { code: "action_failed", detail: "helper 的 focused 载荷不合法" } };
      }
      return { ok: true, data: parsed };
    },

    async activate(rootKey: string): Promise<ComputerResult<void>> {
      const connected = await readyBridge();
      if (!connected.ok) return connected;

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

        return { ok: false, error: { code: "action_failed", detail: "helper 的 capture 载荷不合法" } };
      }

      if (record.path !== request.path) {
        return { ok: false, error: { code: "action_failed", detail: "helper 回执的图片路径与请求不一致" } };
      }
      return { ok: true, data: record };
    },

    async cursor(visible: boolean): Promise<ComputerResult<void>> {

      if (!visible && bridge === undefined) return { ok: true, data: undefined };
      const connected = await readyBridge();
      if (!connected.ok) return connected;
      const response = await connected.data.call<unknown>("cursor", { visible });
      if (!response.ok) return response;
      return { ok: true, data: undefined };
    },
  };
}

function actPayload(request: ComputerBackendActRequest): Record<string, unknown> {
  return {
    key: request.rootKey,
    ...(request.coordinateSnapshot !== undefined
      ? {
          coordinateSnapshot: {
            window: {
              key: request.coordinateSnapshot.window.key,
              bounds: { ...request.coordinateSnapshot.window.bounds },
              ...(request.coordinateSnapshot.window.pid !== undefined ? { pid: request.coordinateSnapshot.window.pid } : {}),
              ...(request.coordinateSnapshot.window.startIdentity !== undefined
                ? { startIdentity: { ...request.coordinateSnapshot.window.startIdentity } }
                : {}),
              ...(request.coordinateSnapshot.window.windowId !== undefined ? { windowId: request.coordinateSnapshot.window.windowId } : {}),
              ...(request.coordinateSnapshot.window.app !== undefined ? { app: request.coordinateSnapshot.window.app } : {}),
            },
            ...(request.coordinateSnapshot.capture !== undefined
              ? {
                  capture: {
                    image: { ...request.coordinateSnapshot.capture.image },
                    region: { ...request.coordinateSnapshot.capture.region },
                  },
                }
              : {}),
            ...(request.coordinateSnapshot.displays !== undefined
              ? { displays: request.coordinateSnapshot.displays.map((display) => ({ ...display })) }
              : {}),
          },
        }
      : {}),
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
