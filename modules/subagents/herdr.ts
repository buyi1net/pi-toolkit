import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { MIN_PANE_COLS, MIN_PANE_ROWS, rectMeetsBudget, type PaneRect } from "./layout-budget.ts";
import { chooseSplitDirection, chooseSplitTarget, type LayoutPane, type SplitDirection } from "./pane-layout.ts";

const execFileAsync = promisify(execFile);

let herdrAvailable: boolean | null = null;
let herdrCheckedAt = 0;
const HERDR_RETRY_AFTER_MS = 5_000;

const managedPaneIds = new Set<string>();

export function isCliAvailable(): boolean {
  try {
    execFileSync("herdr", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function isAvailable(): boolean {
  if (process.env.HERDR_ENV !== "1") return false;
  const now = Date.now();
  if (herdrAvailable === true) return true;
  if (herdrAvailable === false && now - herdrCheckedAt < HERDR_RETRY_AFTER_MS) return false;
  herdrAvailable = isCliAvailable();
  herdrCheckedAt = now;
  return herdrAvailable;
}

export function setupHint(): string {
  return "Start pi inside a herdr pane (herdr, then run pi in a pane).";
}

export function createSurface(
  name: string,
  opts?: { cwd?: string; env?: Record<string, string> },
): string {
  void name;
  const parentId = process.env.HERDR_PANE_ID;
  if (!parentId) throw new Error("HERDR_PANE_ID is missing; cannot place a subagent pane.");

  const before = queryTabLayout(parentId);
  const target = chooseSplitTarget(before, parentId, managedPaneIds);
  if (!target) {
    throw new Error("Cannot inspect the current Herdr tab layout for a subagent pane.");
  }

  const direction = chooseSplitDirection(target.rect, MIN_PANE_COLS, MIN_PANE_ROWS);
  if (!direction) {
    throw new Error(
      `Terminal too small for another subagent pane (current pane is ${target.rect.width}x${target.rect.height}, ` +
        `need >= ${MIN_PANE_COLS * 2}x${MIN_PANE_ROWS * 2} for another split).`,
    );
  }
  const paneId = splitPane(target.pane_id, direction, opts);
  managedPaneIds.add(paneId);

  const after = queryTabLayout(parentId);
  const relevantIds = new Set([parentId, ...managedPaneIds]);
  const invalidPane = after?.find(
    (pane) => relevantIds.has(pane.pane_id) && !rectMeetsBudget(pane.rect),
  );
  if (!after || invalidPane) {
    managedPaneIds.delete(paneId);
    try { execFileSync("herdr", ["pane", "close", paneId], { encoding: "utf8" }); } catch {}
    const rect = invalidPane?.rect;
    throw new Error(
      `Terminal too small for another subagent pane (got ${rect?.width ?? "?"}x${rect?.height ?? "?"}, ` +
        `need >= ${MIN_PANE_COLS}x${MIN_PANE_ROWS}). Reduce subagents or enlarge the window.`,
    );
  }
  return paneId;
}

function queryTabLayout(paneId: string): LayoutPane[] | null {
  try {
    const parsed = JSON.parse(execFileSync("herdr", ["pane", "layout", "--pane", paneId], { encoding: "utf8" })) as {
      result?: { layout?: { panes?: Array<{ pane_id?: unknown; rect?: { width?: unknown; height?: unknown } }> } };
    };
    return (parsed.result?.layout?.panes ?? []).flatMap((pane) => {
      const paneIdValue = pane.pane_id;
      const width = pane.rect?.width;
      const height = pane.rect?.height;
      return typeof paneIdValue === "string" && typeof width === "number" && typeof height === "number"
        ? [{ pane_id: paneIdValue, rect: { width, height } }]
        : [];
    });
  } catch {
    return null;
  }
}

function splitPane(
  target: string,
  direction: SplitDirection,
  opts?: { cwd?: string; env?: Record<string, string> },
): string {
  const args = ["pane", "split", "--pane", target, "--direction", direction, "--ratio", "0.5", "--no-focus"];
  if (opts?.cwd) args.push("--cwd", opts.cwd);
  for (const [key, value] of Object.entries(opts?.env ?? {})) {
    args.push("--env", `${key}=${value}`);
  }
  const stdout = execFileSync("herdr", args, { encoding: "utf8" });
  const parsed = JSON.parse(stdout);
  const paneId = parsed?.result?.pane?.pane_id;
  if (typeof paneId !== "string" || !paneId) {
    throw new Error(`Unexpected herdr pane split output: ${stdout.slice(0, 200)}`);
  }
  return paneId;
}

export function sendCommand(surface: string, text: string): void {
  execFileSync("herdr", ["pane", "run", surface, text], { encoding: "utf8" });
}

export function readScreen(surface: string, lines = 50): string {
  return execFileSync(
    "herdr",
    ["pane", "read", surface, "--source", "recent-unwrapped", "--lines", String(Math.max(1, lines))],
    { encoding: "utf8" },
  );
}

export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  const { stdout } = await execFileAsync(
    "herdr",
    ["pane", "read", surface, "--source", "recent-unwrapped", "--lines", String(Math.max(1, lines))],
    { encoding: "utf8" },
  );
  return stdout;
}

export function surfaceExists(surface: string): boolean {
  try {
    execFileSync("herdr", ["pane", "get", surface], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function trackSurface(surface: string): void {
  managedPaneIds.add(surface);
}

export function closeSurface(surface: string): void {
  execFileSync("herdr", ["pane", "close", surface], { encoding: "utf8" });
  managedPaneIds.delete(surface);
}

export function labelSurface(surface: string, label: string): void {
  execFileSync("herdr", ["pane", "rename", surface, label], { encoding: "utf8" });
}
