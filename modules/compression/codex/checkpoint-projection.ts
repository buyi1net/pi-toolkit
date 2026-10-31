import type { CompactionEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  type CodexAgentMessage,
  type CodexCheckpointDetails,
  fingerprintMessage,
  projectCheckpointContext,
} from "./checkpoint.ts";
import type { SessionProjectionFn } from "./host-projection.ts";

const SYNTHETIC_BOUNDARY_ID = "pi-toolkit-compression-probe";

function syntheticCompactionKept(
  projection: SessionProjectionFn,
  entries: readonly SessionEntry[],
  leafId: string | null,
  firstKeptEntryId: string,
): CodexAgentMessage[] | undefined {
  const probe: CompactionEntry = {
    type: "compaction",
    id: SYNTHETIC_BOUNDARY_ID,
    parentId: leafId,
    timestamp: new Date(0).toISOString(),
    summary: "",
    firstKeptEntryId,
    tokensBefore: 0,
  };

  const messages = [...projection([...entries, probe], probe.id).messages];
  if (messages.length === 0 || messages[0].role !== "compactionSummary") return undefined;
  return messages.slice(1);
}

export function keptMessagesAfterCompaction(
  projection: SessionProjectionFn,
  branchEntries: readonly SessionEntry[],
  firstKeptEntryId: string,
): CodexAgentMessage[] {
  const leafId = branchEntries.at(-1)?.id ?? null;
  const kept = syntheticCompactionKept(projection, branchEntries, leafId, firstKeptEntryId);
  if (!kept) {
    throw new Error("Synthetic compaction boundary did not produce a leading summary message");
  }
  return kept;
}

function canonicalKeptForCheckpoint(
  projection: SessionProjectionFn,
  entries: readonly SessionEntry[],
  checkpoint: { entry: CompactionEntry; details: CodexCheckpointDetails },
): CodexAgentMessage[] | undefined {
  const { entry } = checkpoint;
  if (entry.parentId !== null && !entries.some((candidate) => candidate.id === entry.parentId)) return undefined;

  return syntheticCompactionKept(projection, entries, entry.parentId, entry.firstKeptEntryId);
}

export function piContextMessages(
  projection: SessionProjectionFn,
  entries: readonly SessionEntry[],
  leafId: string | null,
): CodexAgentMessage[] {
  return [...projection([...entries], leafId).messages];
}

export function projectSessionCheckpointContext(
  projection: SessionProjectionFn,
  messages: readonly CodexAgentMessage[],
  entries: readonly SessionEntry[],
  checkpoint: {
    readonly entry: CompactionEntry;
    readonly details: CodexCheckpointDetails;
  },
): CodexAgentMessage[] | undefined {
  const { entry, details } = checkpoint;
  const canonical = canonicalKeptForCheckpoint(projection, entries, checkpoint);
  if (!canonical) return undefined;
  const fingerprints = canonical.map(fingerprintMessage);
  const matches =
    fingerprints.length === details.keptMessageFingerprints.length &&
    fingerprints.every((fingerprint, index) => fingerprint === details.keptMessageFingerprints[index]);
  if (!matches) return undefined;
  return projectCheckpointContext(messages, { ...details, keptMessageFingerprints: fingerprints }, entry.summary);
}
