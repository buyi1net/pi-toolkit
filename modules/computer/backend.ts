import {
  computerPlatformFromNode,
  unavailableCapabilities,
  type ComputerAction,
  type ComputerBounds,
  type ComputerCaptureImage,
  type ComputerCaptureRecord,
  type ComputerCaptureSource,
  type ComputerDisplayInfo,
  type ComputerWindowIdentity,
  type ComputerResult,
  type ComputerStatusData,
} from "./contract.ts";
import type { ComputerObservedNode, ComputerRootDescriptor } from "./state.ts";

export type { ComputerCaptureImage, ComputerCaptureRecord, ComputerCaptureSource, ComputerDisplayInfo } from "./contract.ts";

export interface ComputerBackendTarget {
  readonly path: readonly number[];

  readonly role: string;
  readonly name?: string;
}

export interface ComputerBackendAction {
  readonly command: ComputerAction;
  readonly target?: ComputerBackendTarget;
}

export interface ComputerCoordinateSnapshot {
  readonly window: ComputerWindowIdentity & { readonly key: string; readonly bounds: ComputerBounds };

  readonly capture?: {
    readonly image: ComputerCaptureImage;
    readonly region: ComputerBounds;
  };

  readonly displays?: readonly ComputerDisplayInfo[];
}

export interface ComputerBackendActRequest {

  readonly rootKey: string;
  readonly actions: readonly ComputerBackendAction[];

  readonly coordinateSnapshot?: ComputerCoordinateSnapshot;
}

export interface ComputerBackendProbeRequest {
  readonly rootKey: string;

  readonly text: string;

  readonly path?: readonly number[];

  readonly role?: string;
  readonly name?: string;
}

export interface ComputerFocusElement {

  readonly root?: string;
  readonly role: string;
  readonly name?: string;
  readonly value?: string;
  readonly description?: string;
  readonly enabled?: boolean;
  readonly bounds?: ComputerBounds;
}

export interface ComputerFocusSnapshot {
  readonly root: string;
  readonly element?: ComputerFocusElement;
}

export interface ComputerBackend {
  status(): Promise<ComputerResult<ComputerStatusData>>;
  roots(): Promise<ComputerResult<readonly ComputerRootDescriptor[]>>;
  observe(rootKey: string): Promise<ComputerResult<ComputerBackendObservation>>;
  act(request: ComputerBackendActRequest): Promise<ComputerResult<ComputerBackendObservation>>;

  probe(request: ComputerBackendProbeRequest): Promise<ComputerResult<boolean>>;
  focused(): Promise<ComputerResult<ComputerFocusSnapshot>>;
  activate(rootKey: string): Promise<ComputerResult<void>>;
  displays(): Promise<ComputerResult<readonly ComputerDisplayInfo[]>>;
  capture(request: ComputerCaptureRequest): Promise<ComputerResult<ComputerCaptureRecord>>;

  cursor(visible: boolean): Promise<ComputerResult<void>>;
}

export type ComputerCaptureTarget =
  | { readonly kind: "display"; readonly id: number }
  | { readonly kind: "window"; readonly key: string };

export interface ComputerCaptureRequest {
  readonly target: ComputerCaptureTarget;
  readonly path: string;

  readonly maxLongEdge?: number;
}

export interface ComputerBackendObservation {
  readonly tree: ComputerObservedNode;
  readonly truncated: boolean;
}

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
