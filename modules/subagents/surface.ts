import { existsSync, readFileSync, rmSync } from "node:fs";
import * as herdrSurface from "./herdr.ts";
import * as tmuxSurface from "./tmux.ts";
import { debugLog } from "./diagnostics.ts";

const ownedSurfaces = new Set<string>();
let activeSurfaceKind: SurfaceKind | null = null;

export function readExitSidecar(sessionFile: string | undefined): PollResult | null {
  if (!sessionFile) return null;
  try {
    const exitFile = `${sessionFile}.exit`;
    if (existsSync(exitFile)) {
      const data = JSON.parse(readFileSync(exitFile, "utf-8"));
      rmSync(exitFile, { force: true });
      return interpretExitSidecar(data);
    }
  } catch (error) {
    debugLog(`Could not consume exit sidecar for ${sessionFile}`, error);
  }
  return null;
}

export function peekExitSidecar(sessionFile: string | undefined): PollResult | null {
  if (!sessionFile) return null;
  try {
    const exitFile = `${sessionFile}.exit`;
    if (!existsSync(exitFile)) return null;
    return interpretExitSidecar(JSON.parse(readFileSync(exitFile, "utf8")));
  } catch (error) {
    debugLog(`Could not peek exit sidecar for ${sessionFile}`, error);
    return null;
  }
}

export function assertOwned(surface: string): void {
  if (!ownedSurfaces.has(surface)) {
    throw new Error(
      `Refusing to close pane "${surface}": it was not created by this extension. ` +
        "Only panes spawned via createSurface() may be closed.",
    );
  }
}

export type SurfaceKind = "herdr" | "tmux";
export type DisplayContext = "terminal" | "nested" | SurfaceKind;
export type DisplayMode = "auto" | SurfaceKind;
export type ResolvedDisplaySurface = SurfaceKind | "background";
export type ShellSyntax = "powershell" | "posix";

export function resolveDisplaySurface(
  requested: DisplayMode,
  availability: readonly DisplayModeAvailability[],
): ResolvedDisplaySurface {
  const context = detectDisplayContext();
  if (requested === "auto") return "background";
  const selected = availability.find((entry) => entry.mode === requested);
  const contextMatches = context === requested || (context === "nested" && selected?.available === true);
  if (!contextMatches || !selected?.available) return "background";
  return requested;
}

export function explainDisplayFallback(
  requested: DisplayMode,
  availability: readonly DisplayModeAvailability[],
  resolved: ResolvedDisplaySurface,
): string | null {
  if (requested === "auto" || resolved !== "background") return null;
  const selected = availability.find((entry) => entry.mode === requested);
  if (!selected) return `${requested} unavailable: no availability information for that mode`;
  if (!selected.available) return `${requested} unavailable: ${selected.reason ?? "no reason reported"}`;
  return `${requested} unavailable: the current ${detectDisplayContext()} context cannot host it`;
}

export function detectDisplayContext(): DisplayContext {
  if (process.env.HERDR_ENV === "1" && (process.env.TMUX || process.env.TMUX_PANE)) return "nested";
  if (process.env.HERDR_ENV === "1") return "herdr";
  if (process.env.TMUX || process.env.TMUX_PANE) return "tmux";
  return "terminal";
}

export function detectSurface(): SurfaceKind | null {
  const context = detectDisplayContext();
  return context === "herdr" || context === "tmux" ? context : null;
}

export interface DisplayModeAvailability {
  readonly mode: DisplayMode;
  readonly available: boolean;
  readonly reason: string | null;
}

export function detectDisplayModeAvailability(): readonly DisplayModeAvailability[] {
  const herdrCli = herdrSurface.isCliAvailable();
  const tmuxCli = tmuxSurface.isCliAvailable();
  return [
    { mode: "auto", available: true, reason: null },
    { mode: "herdr", available: herdrCli && process.env.HERDR_ENV === "1", reason: herdrCli ? (process.env.HERDR_ENV === "1" ? null : "HERDR_ENV is not set") : "herdr CLI is unavailable" },
    { mode: "tmux", available: tmuxCli && !!(process.env.TMUX || process.env.TMUX_PANE), reason: tmuxCli ? ((process.env.TMUX || process.env.TMUX_PANE) ? null : "TMUX is not set") : "tmux CLI is unavailable" },
  ];
}

export interface DisplayContextSnapshot {
  readonly context: DisplayContext;
  readonly herdrEnv: boolean;
  readonly tmuxEnv: boolean;
  readonly herdrCli: boolean;
  readonly tmuxCli: boolean;
}

export function detectDisplayContextSnapshot(): DisplayContextSnapshot {
  const herdrEnv = process.env.HERDR_ENV === "1";
  const tmuxEnv = !!(process.env.TMUX || process.env.TMUX_PANE);
  return {
    context: detectDisplayContext(),
    herdrEnv,
    tmuxEnv,
    herdrCli: herdrSurface.isCliAvailable(),
    tmuxCli: tmuxSurface.isCliAvailable(),
  };
}

export function shellSyntax(): ShellSyntax {
  switch (detectSurface()) {
    case "herdr":
      return process.platform === "win32" ? "powershell" : "posix";
    case "tmux":
      return "posix";
    default:
      return process.platform === "win32" ? "powershell" : "posix";
  }
}

export function isMuxAvailable(): boolean {
  switch (activeSurfaceKind ?? detectSurface()) {
    case "herdr":
      return herdrSurface.isAvailable();
    case "tmux":
      return tmuxSurface.isAvailable();
    default:
      return herdrSurface.isAvailable() || tmuxSurface.isAvailable();
  }
}

export function muxSetupHint(): string {
  switch (detectSurface()) {
    case "herdr":
      return herdrSurface.setupHint();
    case "tmux":
      return tmuxSurface.setupHint();
    default:
      return "Start pi inside tmux (`tmux new -A -s pi 'pi'`) or inside a herdr pane.";
  }
}

export function shellEscape(s: string): string {
  return shellSyntax() === "posix"
    ? "'" + s.replace(/'/g, "'\\''") + "'"
    : "'" + s.replace(/'/g, "''") + "'";
}

export function sentinelSuffix(token = "__SUBAGENT_DONE"): string {
  return shellSyntax() === "posix"
    ? `; echo '${token}_'$?'__'`
    : `; echo "${token}_\${LASTEXITCODE}__"`;
}

export function createSurface(
  name: string,
  opts?: { cwd?: string; env?: Record<string, string> },
): string {
  const id = requireSurface().createSurface(name, opts);
  ownedSurfaces.add(id);

  try {
    requireSurface().labelSurface?.(id, `[pi-sub] ${name}`);
  } catch (error) {
    debugLog(`Could not label pane ${id}`, error);
  }
  return id;
}

export function setActiveSurfaceKind(kind: SurfaceKind | null): void {
  activeSurfaceKind = kind;
}

export function createSurfaceFor(
  kind: SurfaceKind,
  name: string,
  opts?: { cwd?: string; env?: Record<string, string> },
): string {
  const surface = kind === "herdr"
    ? herdrSurface.createSurface(name, opts)
    : tmuxSurface.createSurface(name, opts);
  activeSurfaceKind = kind;
  ownedSurfaces.add(surface);
  try {
    (kind === "herdr" ? herdrSurface : tmuxSurface).labelSurface?.(surface, `[pi-sub] ${name}`);
  } catch (error) {
    debugLog(`Could not label pane ${surface}`, error);
  }
  return surface;
}

export function sendCommand(surface: string, text: string): void {
  requireSurface().sendCommand(surface, text);
}

export function sendCommandFor(kind: SurfaceKind, surface: string, text: string): void {
  (kind === "herdr" ? herdrSurface : tmuxSurface).sendCommand(surface, text);
}

export function closeSurfaceFor(kind: SurfaceKind, surface: string): void {
  (kind === "herdr" ? herdrSurface : tmuxSurface).closeSurface(surface);
  ownedSurfaces.delete(surface);
}

export function readScreen(surface: string, lines = 50): string {
  return requireSurface().readScreen(surface, lines);
}

export function readScreenAsync(surface: string, lines = 50): Promise<string> {
  return requireSurface().readScreenAsync(surface, lines);
}

export function closeSurface(surface: string): void {
  assertOwned(surface);
  requireSurface().closeSurface(surface);
  ownedSurfaces.delete(surface);
}

export function adoptSurface(surface: string): boolean {
  if (!surface.trim()) return false;
  return adoptWith(requireSurface(), surface);
}

export function adoptSurfaceFor(kind: SurfaceKind, surface: string): boolean {
  if (!surface.trim()) return false;
  return adoptWith(kind === "herdr" ? herdrSurface : tmuxSurface, surface);
}

function adoptWith(module: SurfaceModule, surface: string): boolean {
  const exists = module.surfaceExists?.(surface);
  if (exists === false) return false;
  module.trackSurface?.(surface);
  ownedSurfaces.add(surface);
  return true;
}

export function probeSurface(surface: string): boolean | null {
  if (!surface.trim() || !(activeSurfaceKind ?? detectSurface())) return null;
  try {
    const check = requireSurface().surfaceExists;
    return check ? check(surface) : null;
  } catch (error) {
    debugLog(`Could not probe subagent surface ${surface}`, error);
    return null;
  }
}

function requireSurface(): SurfaceModule {
  const kind = activeSurfaceKind ?? detectSurface();
  if (kind === "herdr") return herdrSurface;
  if (kind === "tmux") return tmuxSurface;
  throw new Error(`No terminal multiplexer detected. ${muxSetupHint()}`);
}

interface SurfaceModule {
  isAvailable(): boolean;
  setupHint(): string;
  createSurface(name: string, opts?: { cwd?: string; env?: Record<string, string> }): string;
  sendCommand(surface: string, text: string): void;
  readScreen(surface: string, lines?: number): string;
  readScreenAsync(surface: string, lines?: number): Promise<string>;
  closeSurface(surface: string): void;
  surfaceExists?(surface: string): boolean;

  trackSurface?(surface: string): void;

  labelSurface?(surface: string, label: string): void;
}

export interface PollResult {

  reason: "done" | "sentinel" | "error" | "user_closed";

  exitCode: number;

  errorMessage?: string;
}

export interface ExitSidecar {
  type?: unknown;
  errorMessage?: unknown;
}

export function interpretExitSidecar(data: ExitSidecar): PollResult {
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

export const __pollForExitTest__ = { interpretExitSidecar, isMissingSurfaceError, paneGoneResult };

function isMissingSurfaceError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? (error as { code?: unknown }).code : undefined;
  return code === "ENOENT";
}

export function paneGoneResult(detail: string): PollResult {
  return {
    reason: "user_closed",
    exitCode: 1,
    errorMessage:
      `Subagent pane is gone (${detail}) and no .exit sidecar was found. ` +
      `The pane was most likely closed directly (by the user or the multiplexer); ` +
      `this is not a provider or agent error.`,
  };
}

export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;

    sentinelToken?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();
  let readFailures = 0;
  const MAX_READ_FAILURES = 15;

  const readExitFile = (): PollResult | null => readExitSidecar(options.sessionFile);

  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    const sidecar = readExitFile();
    if (sidecar) return sidecar;

    try {
      const screen = await readScreenAsync(surface, 15);
      readFailures = 0;
      const token = options.sentinelToken ?? "__SUBAGENT_DONE";
      const escapedToken = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = screen.match(new RegExp(`${escapedToken}_(\\d+)__`));
      if (match) {
        return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
      }
    } catch (error) {

      const late = readExitFile();
      if (late) return late;
      if (isMissingSurfaceError(error)) {
        return paneGoneResult("surface command unavailable — herdr/tmux may have exited or been removed");
      }
      readFailures += 1;

      if (readFailures >= MAX_READ_FAILURES) {
        return paneGoneResult(`closed externally; gave up after ${MAX_READ_FAILURES} consecutive read failures`);
      }
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
