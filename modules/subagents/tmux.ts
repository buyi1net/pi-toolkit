import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { chooseSplitTarget, type LayoutPane, type SplitDirection } from "./pane-layout.ts";

const execFileAsync = promisify(execFile);

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }

  let available = false;
  try {
    execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
    available = true;
  } catch {
    available = false;
  }

  commandAvailability.set(command, available);
  return available;
}

export function isCliAvailable(): boolean {
  return hasCommand("tmux");
}

export function isAvailable(): boolean {
  return !!process.env.TMUX && isCliAvailable();
}

export function setupHint(): string {
  return "Start pi inside tmux (`tmux new -A -s pi 'pi'`).";
}

const managedPaneIds = new Set<string>();

export function createSurface(
  name: string,
  opts?: { cwd?: string; env?: Record<string, string> },
): string {
  void name;

  const parentId = process.env.TMUX_PANE;
  if (!parentId) throw new Error("TMUX_PANE is missing; cannot place a subagent pane.");

  const before = queryWindowLayout(parentId);
  const target = chooseSplitTarget(before, parentId, managedPaneIds);
  if (!target) {
    throw new Error("Cannot inspect the current tmux window layout for a subagent pane.");
  }

  const direction: SplitDirection = target.rect.width >= target.rect.height ? "right" : "down";
  const paneId = splitPane(target.pane_id, direction, opts);
  managedPaneIds.add(paneId);
  return paneId;
}

function splitPane(
  target: string,
  direction: SplitDirection,
  opts?: { cwd?: string; env?: Record<string, string> },
): string {
  const args = ["split-window", "-d", direction === "right" ? "-h" : "-v", "-t", target];
  if (opts?.cwd) {
    args.push("-c", opts.cwd);
  }
  for (const [key, value] of Object.entries(opts?.env ?? {})) {
    args.push("-e", `${key}=${value}`);
  }
  args.push("-P", "-F", "#{pane_id}");

  const pane = execFileSync("tmux", args, { encoding: "utf8" }).trim();
  if (!pane.startsWith("%")) {
    throw new Error(`Unexpected tmux split-window output: ${pane}`);
  }
  return pane;
}

function queryWindowLayout(paneId: string): LayoutPane[] | null {
  try {
    const output = execFileSync(
      "tmux",
      ["list-panes", "-t", paneId, "-F", "#{pane_id} #{pane_width} #{pane_height}"],
      { encoding: "utf8" },
    );
    return output.split(/\r?\n/).flatMap((line) => {
      const [id, widthText, heightText] = line.trim().split(/\s+/);
      const width = Number(widthText);
      const height = Number(heightText);
      return id && Number.isFinite(width) && Number.isFinite(height)
        ? [{ pane_id: id, rect: { width, height } }]
        : [];
    });
  } catch {
    return null;
  }
}

export function sendCommand(surface: string, command: string): void {
  execFileSync("tmux", ["send-keys", "-t", surface, "-l", command], { encoding: "utf8" });
  execFileSync("tmux", ["send-keys", "-t", surface, "Enter"], { encoding: "utf8" });
}

export function readScreen(surface: string, lines = 50): string {
  return execFileSync(
    "tmux",
    ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
    {
      encoding: "utf8",
    },
  );
}

export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  const { stdout } = await execFileAsync(
    "tmux",
    ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
    { encoding: "utf8" },
  );
  return stdout;
}

export function trackSurface(surface: string): void {
  managedPaneIds.add(surface);
}

export function surfaceExists(surface: string): boolean {
  try {
    execFileSync("tmux", ["display-message", "-p", "-t", surface, "#{pane_id}"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function closeSurface(surface: string): void {
  execFileSync("tmux", ["kill-pane", "-t", surface], { encoding: "utf8" });
  managedPaneIds.delete(surface);
}

export function labelSurface(surface: string, label: string): void {
  execFileSync("tmux", ["select-pane", "-t", surface, "-T", label], { encoding: "utf8" });
}
