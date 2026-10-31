import type { CompressionState } from "acp-kernel";

export const ACP_SIDECAR_SCHEMA_VERSION = 1;

export const ACP_SIDECAR_SUFFIX = ".acp.json";

export const ACP_SIDECAR_PRODUCER = "pi-toolkit/compression-acp";

export interface AcpSidecarFile {
  readonly schemaVersion: number;
  readonly producer: string;
  readonly session: {
    readonly id: string;
    readonly file?: string;
  };
  readonly config?: {
    readonly fingerprint: string;
  };
  readonly state: CompressionState;
}

export type AcpSidecarLoadStatus =
  | "ok"
  | "missing"
  | "corrupt"
  | "newer-schema";

export interface AcpSidecarLoadResult {
  readonly status: AcpSidecarLoadStatus;

  readonly state?: CompressionState;

  readonly sessionId?: string;

  readonly configFingerprint?: string;

  readonly schemaVersion?: number;

  readonly error?: string;
}
