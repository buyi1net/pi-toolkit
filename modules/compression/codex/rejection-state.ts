import { createHash } from "node:crypto";
import type { CodexProtocol } from "../api.ts";
import type { ResponsesCompactionProfile } from "./profiles.ts";

export interface CodexRejectionRouteIdentity {
  readonly provider: string;
  readonly modelId: string;
  readonly api: string;
  readonly profile: ResponsesCompactionProfile;
  readonly protocol: CodexProtocol;
  readonly baseUrl?: string;

  readonly endpoint?: string;
}

export function codexRejectionRouteKey(identity: CodexRejectionRouteIdentity): string {
  const normalize = (value: string | undefined): (string | null)[] | undefined => {
    if (!value) return undefined;
    try {
      const url = new URL(value);
      return [
        url.origin,
        url.pathname,
        identity.api === "azure-openai-responses" ? url.searchParams.get("api-version") : null,
      ];
    } catch {
      return undefined;
    }
  };
  const backend = normalize(identity.endpoint);
  return createHash("sha256")
    .update(
      JSON.stringify([
        identity.provider,
        identity.modelId,
        identity.api,
        identity.profile,
        identity.protocol,
        normalize(identity.baseUrl),
        backend,
      ]),
    )
    .digest("hex");
}

export class RejectedRoutes {
  private readonly keys = new Set<string>();
  private readonly observed = new Map<string, string>();

  observe(route: string, backend: string): void {

    if (this.observed.has(route) || (this.keys.has(backend) && this.observed.size < 128))
      this.observed.set(route, backend);
  }

  hasObserved(route: string): boolean {
    const backend = this.observed.get(route);
    return backend !== undefined && this.has(backend);
  }

  has(key: string): boolean {
    return this.keys.has(key);
  }

  add(key: string): void {

    if (this.keys.size < 128) this.keys.add(key);
  }
}
