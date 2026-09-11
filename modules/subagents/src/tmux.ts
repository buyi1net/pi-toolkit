/**
 * tmux 表面 —— IO 原语。语法族判定(shellEscape/sentinelSuffix)由
 * surface.ts 统一分派(tmux 恒为 POSIX),本模块只负责对 tmux CLI 的操作。
 *
 * 实现源自上游 amosblomqvist/pi-interactive-subagents 的 tmux.ts,接口
 * 对齐到统一表面签名(cwd/env 经 split-window 的 -c / -e 传入,tmux
 * 3.2+ 支持,替代上游的 cd 前缀 + 环境变量前缀拼装)。
 *
 * Panes are identified by tmux pane ids (e.g. `%12`). The parent pane keeps
 * one fixed side: only the first subagent pane is split off the parent, and
 * later splits subdivide the managed side only (see pane-layout.ts). The
 * user's focus is never stolen.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { MIN_PANE_COLS, MIN_PANE_ROWS, rectMeetsBudget, type PaneRect } from "./layout-budget.ts";
import { chooseSplitDirection, chooseSplitTarget, type LayoutPane, type SplitDirection } from "./pane-layout.ts";

const execFileAsync = promisify(execFile);

// ── Availability ──

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

/**
 * True when running inside tmux with the tmux binary on PATH.
 * `TMUX` is set by tmux in every process it spawns (shell or pane).
 */
export function isAvailable(): boolean {
  return !!process.env.TMUX && hasCommand("tmux");
}

export function setupHint(): string {
  return "Start pi inside tmux (`tmux new -A -s pi 'pi'`).";
}

// ── Pane layout ──

const managedPaneIds = new Set<string>();

// 有意不使用 tmux select-layout(如 tiled)重排:全窗口重排会把主 pane 从
// 固定侧挪走或挤小,违背“主 pane 稳定占一侧”的布局契约;split 按 50% 均分
// 目标 pane,几何可预期,pane 关闭后 tmux 自动把空间归还相邻 pane,无需重排。

// ── Surface primitives ──

/**
 * Create a new pane in the parent's window. Split target selection lives in
 * pane-layout.ts:首次从主 pane 切出,之后只在 managed 区域内继续切分;
 * split 沿能保住最小尺寸的轴进行。
 * opts.cwd → split-window -c;opts.env → split-window -e(tmux 3.2+)。
 * Returns the new pane id (e.g. `%12`).
 */
export function createSurface(
  name: string,
  opts?: { cwd?: string; env?: Record<string, string> },
): string {
  void name; // tmux panes are not named; the pi process inside shows its own title.

  const parentId = process.env.TMUX_PANE;
  if (!parentId) throw new Error("TMUX_PANE is missing; cannot place a subagent pane.");

  const before = queryWindowLayout(parentId);
  const target = chooseSplitTarget(before, parentId, managedPaneIds);
  if (!target) {
    throw new Error("Cannot inspect the current tmux window layout for a subagent pane.");
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

  const after = queryWindowLayout(parentId);
  const relevantIds = new Set([parentId, ...managedPaneIds]);
  const invalidPane = after?.find(
    (pane) => relevantIds.has(pane.pane_id) && !rectMeetsBudget(pane.rect),
  );
  if (!after || invalidPane) {
    managedPaneIds.delete(paneId);
    try { execFileSync("tmux", ["kill-pane", "-t", paneId], { encoding: "utf8" }); } catch {}
    const rect = invalidPane?.rect;
    throw new Error(
      `Terminal too small for another subagent pane (got ${rect?.width ?? "?"}x${rect?.height ?? "?"}, ` +
        `need >= ${MIN_PANE_COLS}x${MIN_PANE_ROWS}). Reduce subagents or enlarge the window.`,
    );
  }
  return paneId;
}

function splitPane(
  target: string,
  direction: SplitDirection,
  opts?: { cwd?: string; env?: Record<string, string> },
): string {
  const args = ["split-window", "-d", direction === "right" ? "-h" : "-v", "-t", target, "-p", "50"];
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

/** 查询当前 window 的 pane 布局。 */
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

/**
 * Send a command string to a pane and execute it.
 * Typed literally (`-l`) so special characters are not interpreted as keys,
 * then submitted with Enter.
 */
export function sendCommand(surface: string, command: string): void {
  execFileSync("tmux", ["send-keys", "-t", surface, "-l", command], { encoding: "utf8" });
  execFileSync("tmux", ["send-keys", "-t", surface, "Enter"], { encoding: "utf8" });
}

/** Read the screen contents of a pane (sync). */
export function readScreen(surface: string, lines = 50): string {
  return execFileSync(
    "tmux",
    ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
    {
      encoding: "utf8",
    },
  );
}

/** Read the screen contents of a pane (async). */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  const { stdout } = await execFileAsync(
    "tmux",
    ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
    { encoding: "utf8" },
  );
  return stdout;
}

/** 重载恢复后，把已有 pane 纳入当前 window 的布局目标集合。 */
export function trackSurface(surface: string): void {
  managedPaneIds.add(surface);
}

/** 查询 pane 是否仍然存在,用于 /reload 恢复时丢弃 stale 记录。 */
export function surfaceExists(surface: string): boolean {
  try {
    execFileSync("tmux", ["display-message", "-p", "-t", surface, "#{pane_id}"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Close a pane. tmux 自动把空间归还相邻 pane,无需重排。 */
export function closeSurface(surface: string): void {
  execFileSync("tmux", ["kill-pane", "-t", surface], { encoding: "utf8" });
  managedPaneIds.delete(surface);
}

/** 给 pane 设置可识别标签(best-effort,失败不致命)。 */
export function labelSurface(surface: string, label: string): void {
  execFileSync("tmux", ["select-pane", "-t", surface, "-T", label], { encoding: "utf8" });
}
