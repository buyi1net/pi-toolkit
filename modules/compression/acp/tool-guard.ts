import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { Translator } from "../../../i18n/index.ts";

export const TOOL_UNAVAILABLE_REASON = "compression_disabled_or_not_acp";

export interface AcpToolUnavailableDetails {
  readonly toolUnavailable: typeof TOOL_UNAVAILABLE_REASON;
}

export interface AcpToolUnavailableResult extends AgentToolResult<AcpToolUnavailableDetails> {

  readonly isError: boolean;
}

export function acpToolUnavailable(t: Translator): AcpToolUnavailableResult {
  return {
    content: [{ type: "text", text: t("module.compression.acp.toolUnavailable") }],
    isError: true,
    details: { toolUnavailable: TOOL_UNAVAILABLE_REASON },
  };
}

export function isAcpToolUnavailableDetails(details: unknown): boolean {
  if (typeof details !== "object" || details === null) return false;
  return (details as { toolUnavailable?: unknown }).toolUnavailable === TOOL_UNAVAILABLE_REASON;
}
