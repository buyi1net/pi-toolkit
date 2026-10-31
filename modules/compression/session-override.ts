import {
  DEFAULT_SESSION_COMPRESSION_OVERRIDE,
  SESSION_COMPRESSION_OVERRIDES,
  type SessionCompressionOverride,
} from "./api.ts";

export function isSessionCompressionOverride(value: unknown): value is SessionCompressionOverride {
  return (
    typeof value === "string" && (SESSION_COMPRESSION_OVERRIDES as readonly string[]).includes(value)
  );
}

let current: SessionCompressionOverride = DEFAULT_SESSION_COMPRESSION_OVERRIDE;

export const sessionCompressionOverride = {
  get(): SessionCompressionOverride {
    return current;
  },
  set(next: SessionCompressionOverride): void {
    current = next;
  },

  reset(): void {
    current = DEFAULT_SESSION_COMPRESSION_OVERRIDE;
  },
};
