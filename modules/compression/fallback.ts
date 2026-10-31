import type { CompressionFallbackRecord } from "./status.ts";

export interface CompressionFallbackLedger {

  read(): CompressionFallbackRecord | undefined;

  record(record: CompressionFallbackRecord): void;

  clear(): void;

  reset(): void;
}

export function createCompressionFallbackLedger(): CompressionFallbackLedger {
  let current: CompressionFallbackRecord | undefined;
  return {
    read: () => current,
    record: (record) => {
      const reason = record.reason.trim();
      if (reason === "") return;
      current = { from: record.from, reason };
    },
    clear: () => {
      current = undefined;
    },
    reset: () => {
      current = undefined;
    },
  };
}
