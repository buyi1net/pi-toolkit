import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { renderToolCardCall, renderToolCardResult } from "../../kit/tool-card.ts";
import { Type } from "typebox";
import { deriveSessionShortId } from "../../shared/short-id.ts";
import type { PeerBlockedState, PeersDiscoverySnapshot, PeersSnapshotError } from "./api.ts";
import { peerDisplayStatus, type PeerDisplayStatus } from "./discovery.ts";
import { peersStatusLabel, type PeersTranslate } from "./messages/index.ts";

export interface PeersListToolDeps {

  readonly getSnapshot: () => PeersDiscoverySnapshot;

  readonly refresh: () => Promise<void>;

  readonly getInstanceId: () => string | null;

  readonly label: string;

  readonly t?: PeersTranslate;
}

export interface PeersListEntryView {
  readonly sessionId: string;
  readonly shortId: string | null;

  readonly instanceId: string | null;
  readonly status: PeerDisplayStatus;
  readonly blocked: PeerBlockedState | null;
  readonly name: string | null;
  readonly cwd: string | null;
  readonly sessionFile: string | null;

  readonly self: boolean;

  readonly ownInstance: boolean;

  readonly duplicateShortId: boolean;

  readonly multipleInstances: boolean;
}

export interface PeersListOutput {
  readonly text: string;
  readonly entries: { online: readonly PeersListEntryView[]; offline: readonly PeersListEntryView[] };
  readonly truncated: boolean;
  readonly error: Pick<PeersSnapshotError, "kind" | "detail"> | null;
}

export interface PeersSelfIdentity {
  readonly ownSessionId: string | null;
  readonly ownInstanceId: string | null;
}

function buildEntryViews(
  snapshot: PeersDiscoverySnapshot,
  identity: PeersSelfIdentity,
): { online: PeersListEntryView[]; offline: PeersListEntryView[] } {

  const shortIdSessions = new Map<string, Set<string>>();
  const consider = (sessionId: string, shortId: string | null): void => {
    if (!shortId) return;
    const sessions = shortIdSessions.get(shortId) ?? new Set<string>();
    sessions.add(sessionId);
    shortIdSessions.set(shortId, sessions);
  };
  for (const entry of snapshot.online) consider(entry.sessionId, deriveSessionShortId(entry.sessionId));
  for (const entry of snapshot.offline) consider(entry.sessionId, deriveSessionShortId(entry.sessionId));
  const isDuplicate = (shortId: string | null): boolean =>
    shortId !== null && (shortIdSessions.get(shortId)?.size ?? 0) > 1;

  const liveInstanceCounts = new Map<string, number>();
  for (const entry of snapshot.online) {
    liveInstanceCounts.set(entry.sessionId, (liveInstanceCounts.get(entry.sessionId) ?? 0) + 1);
  }

  const online = snapshot.online.map((entry) => {
    const shortId = deriveSessionShortId(entry.sessionId);
    const self = identity.ownSessionId !== null && entry.sessionId === identity.ownSessionId;
    return {
      sessionId: entry.sessionId,
      shortId,
      instanceId: entry.instanceId,
      status: peerDisplayStatus(entry.liveness, entry.activity, entry.blocked),
      blocked: entry.blocked ?? null,
      name: entry.name,
      cwd: entry.cwd,
      sessionFile: entry.sessionFile,
      self,
      ownInstance: self && identity.ownInstanceId !== null && entry.instanceId === identity.ownInstanceId,
      duplicateShortId: isDuplicate(shortId),
      multipleInstances: (liveInstanceCounts.get(entry.sessionId) ?? 0) > 1,
    };
  });
  const offline = snapshot.offline.map((entry) => {
    const shortId = deriveSessionShortId(entry.sessionId);
    return {
      sessionId: entry.sessionId,
      shortId,
      instanceId: null,
      status: "offline" as const,
      blocked: null,
      name: entry.name,
      cwd: entry.cwd,
      sessionFile: entry.sessionFile,
      self: identity.ownSessionId !== null && entry.sessionId === identity.ownSessionId,
      ownInstance: false,
      duplicateShortId: isDuplicate(shortId),
      multipleInstances: false,
    };
  });
  return { online, offline };
}

function formatEntryLine(entry: PeersListEntryView, truncated: boolean): string {

  const file = entry.sessionFile ?? (
    entry.status === "offline"
      ? (truncated ? "(not in scan window)" : "(session file missing)")
      : "(session file unavailable; active session)"
  );
  const segments = [
    `short ${entry.shortId !== null ? `#${entry.shortId}` : "(none)"}`,
    `session ${entry.sessionId}`,
    entry.instanceId !== null ? `instance ${entry.instanceId}` : "instance (none)",
    `status ${entry.status}`,
    `name ${entry.name !== null && entry.name !== "" ? entry.name : "(none)"}`,
    `cwd ${entry.cwd !== null && entry.cwd !== "" ? entry.cwd : "(unknown)"}`,
    `file ${file}`,
  ];
  if (entry.blocked !== null) segments.push(`waitingFor ${entry.blocked.waitingFor}`);
  if (entry.ownInstance) segments.push("you (self-delivery not supported)");
  else if (entry.self) segments.push("you (another instance of this session)");
  if (entry.shortId === null) segments.push("no valid short id");
  if (entry.duplicateShortId) segments.push("duplicate short id");
  if (entry.multipleInstances) segments.push("multiple instances");
  return `• ${segments.join(" | ")}`;
}

function entrySegments(entry: PeersListEntryView, t?: PeersTranslate): (string | null)[] {
  return [
    entry.shortId !== null ? `#${entry.shortId}` : null,
    entry.name !== null && entry.name !== "" ? entry.name : (t?.("module.peers.list.unnamed") ?? "unnamed"),
    peersStatusLabel(entry.status, t),
  ];
}

function entryLine(entry: PeersListEntryView, t?: PeersTranslate): string {
  const segments = entrySegments(entry, t);
  if (entry.ownInstance) segments.push(t?.("module.peers.list.self") ?? "this session");
  else if (entry.self) segments.push(t?.("module.peers.list.selfOtherInstance") ?? "another instance of this session");
  if (entry.duplicateShortId) segments.push(t?.("module.peers.list.duplicateShortId") ?? "duplicate short id");
  if (entry.multipleInstances) segments.push(t?.("module.peers.list.multipleInstances") ?? "multiple instances");
  return segments.filter((segment): segment is string => segment !== null).join(" · ");
}

function entrySupplementLine(entry: PeersListEntryView, t?: PeersTranslate): string | null {
  if (!entry.duplicateShortId && !entry.multipleInstances) return null;
  const parts: string[] = [];
  if (entry.duplicateShortId) {
    parts.push(t?.("module.peers.list.detailSession", { id: entry.sessionId }) ?? `session ${entry.sessionId}`);
  }
  if (entry.multipleInstances && entry.instanceId !== null) {
    parts.push(t?.("module.peers.list.detailInstance", { id: entry.instanceId }) ?? `instance ${entry.instanceId}`);
  }
  if (entry.cwd !== null && entry.cwd !== "") parts.push(entry.cwd);
  return parts.length > 0 ? `  ${parts.join(" · ")}` : null;
}

export function peersListDetailLines(output: PeersListOutput | undefined, t?: PeersTranslate): string[] {
  if (output === undefined) return [];
  const lines: string[] = [];
  if (output.error !== null) {
    lines.push(t?.("module.peers.tool.list.result.stale") ?? "Snapshot problem; showing the last successful scan");
  }
  const { online, offline } = output.entries;
  if (online.length === 0 && offline.length === 0) {
    if (output.error === null) lines.push(t?.("module.peers.list.empty") ?? "No peer sessions found");
    return lines;
  }
  const section = (label: string, entries: readonly PeersListEntryView[]): void => {
    lines.push(label);
    for (const entry of entries) {
      lines.push(entryLine(entry, t));
      const supplement = entrySupplementLine(entry, t);
      if (supplement !== null) lines.push(supplement);
    }
  };
  section(t?.("module.peers.list.onlineSection", { count: online.length }) ?? `Online (${online.length})`, online);
  section(t?.("module.peers.list.offlineSection", { count: offline.length }) ?? `Offline (${offline.length})`, offline);
  if (output.truncated) lines.push(t?.("module.peers.list.truncated") ?? "List truncated; older entries hidden");
  return lines;
}

export function buildPeersListOutput(snapshot: PeersDiscoverySnapshot, identity: PeersSelfIdentity): PeersListOutput {
  const { online, offline } = buildEntryViews(snapshot, identity);
  const lines: string[] = [];
  if (snapshot.error !== null) {
    lines.push(
      `PEER DISCOVERY PROBLEM (${snapshot.error.kind}): ${snapshot.error.detail} — the list below is the last successful scan and may be stale.`,
    );
  }

  if ([...online, ...offline].some((entry) => entry.duplicateShortId)) {
    lines.push(
      "DUPLICATE SHORT IDS: a target that matches both live and offline sessions resolves to the live instance; only multiple live instances are ambiguous.",
    );
  }
  if (online.length === 0 && offline.length === 0 && snapshot.error === null) {
    lines.push("No peer sessions found on this machine.");
  } else {
    lines.push(`ACTIVE SESSIONS (${online.length}):`);
    lines.push(...online.map((entry) => formatEntryLine(entry, snapshot.truncated)));
    lines.push(`OFFLINE SESSIONS (${offline.length}):`);
    lines.push(...offline.map((entry) => formatEntryLine(entry, snapshot.truncated)));
  }
  if (snapshot.truncated) {
    lines.push("LIST TRUNCATED: older entries are hidden (entry limit reached).");
  }
  return {
    text: lines.join("\n"),
    entries: { online, offline },
    truncated: snapshot.truncated,
    error: snapshot.error !== null ? { kind: snapshot.error.kind, detail: snapshot.error.detail } : null,
  };
}

export function registerPeersListTool(pi: ExtensionAPI, deps: PeersListToolDeps): void {
  pi.registerTool({
    name: "peers_list",
    label: deps.label,
    description:
      "List peer pi sessions on this machine (same agent directory). " +
      "Two sections: ACTIVE sessions (running instances, with liveness/activity status) and OFFLINE sessions (recently exited, discovered from session files). " +
      "Each entry carries: 6-char short id (like #62nvbt), full session id, instance id (empty for offline), name, working directory, session file path and status. " +
      "Status values: working means a run is in progress and the message is read between tool calls; idle means no run is active and a message starts a new turn; " +
      "blocked means the session is waiting on a user-facing prompt and cannot act until the user answers (waitingFor names the prompt kind); sluggish means the heartbeat is stale and the session may be gone; offline means no live instance. " +
      "Entries are annotated for: yourself, multiple instances of one session, duplicate short ids, missing session files, and list truncation. " +
      "The entry marked you is informational and cannot be used as a peers_send target. " +
      "An offline entry never makes a target ambiguous: a target matching both live and offline sessions resolves to the live instance, and only multiple live instances refuse as ambiguous-address. ",
    promptSnippet:
      "List local peer pi sessions (active/offline) with short id, session id, instance id, name, cwd, file path and status",
    parameters: Type.Object({}),
    renderShell: "self",
    renderCall(_args, theme, context) {
      return renderToolCardCall({ title: deps.t?.("module.peers.tool.list.display") ?? "List local sessions" }, theme, context);
    },
    renderResult(result, options, theme, context) {
      const details = result.details as PeersListOutput | undefined;
      const online = details?.entries.online.length ?? 0;
      const offline = details?.entries.offline.length ?? 0;
      const stale = details?.error != null;
      const summary = deps.t?.("module.peers.tool.list.result.summary", { online, offline }) ?? `${online} online · ${offline} offline`;
      const status = stale
        ? `${summary} · ${deps.t?.("module.peers.tool.list.result.stale") ?? "Snapshot problem; showing the last successful scan"}`
        : summary;
      const renderContext = stale && context?.isError !== true ? { ...context, isError: true } : context;
      return renderToolCardResult(
        {
          title: deps.t?.("module.peers.tool.list.display") ?? "List local sessions",
          status,
          details: options.expanded ? peersListDetailLines(details, deps.t) : [],
        },
        theme,
        options,
        renderContext,
      );
    },

    async execute(
      _toolCallId: string,
      _params: Record<string, never>,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext | undefined,
    ): Promise<{
      content: { type: "text"; text: string }[];
      details: PeersListOutput;
      isError?: boolean;
    }> {

      try {
        await deps.refresh();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const output: PeersListOutput = {
          text: `PEER DISCOVERY PROBLEM (scan-failed): ${detail}`,
          entries: { online: [], offline: [] },
          truncated: false,
          error: { kind: "scan-failed", detail },
        };
        return { content: [{ type: "text", text: output.text }], details: output, isError: true };
      }
      const snapshot = deps.getSnapshot();
      const ownSessionId = ctx?.sessionManager?.getSessionId?.() ?? null;
      const output = buildPeersListOutput(snapshot, {
        ownSessionId,
        ownInstanceId: deps.getInstanceId(),
      });
      return { content: [{ type: "text", text: output.text }], details: output };
    },
  });
}
