import type { SubagentActivityState } from "./activity.ts";
import type { SubagentStatusState } from "./status.ts";
import type { SessionStats } from "./session.ts";
import type { LoadoutRoutingSnapshot } from "./routing-snapshot.ts";
import type { HeadlessChild } from "./headless.ts";
import type { SubagentLaunchPlanMetadata, SubagentProtocol } from "./protocol.ts";

export interface SubagentResult {
  name: string;
  task: string;
  cohortId?: string;

  protocol?: SubagentProtocol;
  launchPlan?: SubagentLaunchPlanMetadata;
  summary: string;
  sessionFile?: string;
  sessionId?: string;
  exitCode: number;
  elapsed: number;
  errorMessage?: string;
  stats?: SessionStats;

  userClosed?: boolean;

  interruptedRound?: boolean;

  stopped?: boolean;

  handedOff?: boolean;
}

export type SubagentWaitMode = "hard-barrier" | "interactive" | "member-round" | "recovered";
export type SubagentWaitRelease = "escape" | "timeout";

export interface RunningSubagent {
  id: string;
  name: string;
  task: string;
  cohortId?: string;

  protocol?: SubagentProtocol;
  launchPlan?: SubagentLaunchPlanMetadata;
  agent?: string;

  model?: string | null;

  modelIdentity?: { provider: string; id: string; api: string; baseUrl: string } | null;

  thinking?: string | null;

  tier?: string | null;
  modelPool?: readonly string[] | null;

  modelRouting?: LoadoutRoutingSnapshot | null;

  canonicalTaskName?: string;
  parentCanonicalTaskName?: string | null;
  publicStatus?: "starting" | "running" | "waiting" | "completed" | "failed" | "interrupted" | "handed_off";
  closed?: boolean;
  parentId?: string | null;

  timeoutMs?: number;

  waitMode?: SubagentWaitMode;

  waitReleased?: SubagentWaitRelease;
  surface: string;

  surfaceKind?: "herdr" | "tmux";
  startTime: number;
  sessionFile: string;

  hostSessionId?: string | null;
  activityFile?: string;
  activity?: SubagentActivityState;
  activityRead?: {
    ok: boolean;
    reason?: "missing" | "invalid" | "wrong-id";
    error?: string;
  };
  abortController?: AbortController;
  statusState: SubagentStatusState;
  interactive: boolean;
  sentinelToken: string;
  runtimeFile: string;

  kind?: "pane" | "headless";

  pid?: number;

  headlessChild?: HeadlessChild;

  anchoredLoadout?: boolean;

  pendingRoundSignal?: { name: string; seq: number; at: number };

  roundAssociationAttempts?: number;

  contextFiles?: string[];

  stdinLost?: boolean;

  member?: boolean;

  dispatchedRound?: boolean;

  dispatchedRoundId?: string;

  roundEntryBaseline?: number;

  rosterFile?: string;

  interruptRequested?: boolean;

  watchPromise?: Promise<SubagentResult>;

  stopRequested?: boolean;
}
