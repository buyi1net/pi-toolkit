import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { join } from "node:path";
import { debugLog } from "./diagnostics.ts";

const SUBAGENT_ENV_PREFIX = "PI_SUBAGENT_";
const PROPAGATED_SUBAGENT_ENV = "PI_SUBAGENT_PI_ENTRY";

function isLifecycleSubagentEnvKey(key: string): boolean {
  const normalized = key.toUpperCase();
  return normalized.startsWith(SUBAGENT_ENV_PREFIX) && normalized !== PROPAGATED_SUBAGENT_ENV;
}

export function createSubagentLaunchEnv(
  overrides: Record<string, string> = {},
): Record<string, string> {
  const cleared: Record<string, string> = {};
  for (const key of Object.keys(process.env)) {
    if (isLifecycleSubagentEnvKey(key)) cleared[key] = "";
  }
  return { ...cleared, ...overrides };
}

export function buildSubagentProcessEnv(
  overrides: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const inherited: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(inherited)) {
    if (isLifecycleSubagentEnvKey(key)) delete inherited[key];
  }
  return { ...inherited, ...overrides };
}

export function attachJsonlReader(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  stream.on("data", (chunk: string | Buffer) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index === -1) return;
      let line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      onLine(line);
    }
  });
  stream.on("end", () => {
    buffer += decoder.end();
    if (buffer.length > 0) {
      onLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
      buffer = "";
    }
  });
}

export function serializeJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export function resolvePiEntry(): string | null {
  const override = process.env.PI_SUBAGENT_PI_ENTRY?.trim();
  if (override) return override;
  const self = process.argv[1];
  if (!self || !existsSync(self)) return null;
  if (/\.(c|m)?js$/i.test(self)) return self;

  let real: string;
  try {
    real = realpathSync(self);
  } catch {
    return null;
  }
  return /\.(c|m)?js$/i.test(real) && existsSync(real) ? real : null;
}

export const HEADLESS_SURFACE_PREFIX = "headless:";

export function formatHeadlessSurface(pid: number): string {
  return `${HEADLESS_SURFACE_PREFIX}${pid}`;
}

export function parseHeadlessSurface(surface: string): number | null {
  if (!surface.startsWith(HEADLESS_SURFACE_PREFIX)) return null;
  const pid = Number.parseInt(surface.slice(HEADLESS_SURFACE_PREFIX.length), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

export function killHeadlessProcessTree(
  child: ChildProcess,
  pid: number | undefined,
  treeKill: (pid: number) => void = terminateHeadlessProcess,
): void {
  if (pid != null && process.platform === "win32") treeKill(pid);
  try {
    child.kill();
  } catch (error) {
    debugLog(`Could not kill headless child ${pid ?? "unknown"}`, error);
  }
}

export function terminateHeadlessProcess(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0 || !isPidAlive(pid)) return;
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
    const taskkillPath = join(systemRoot, "System32", "taskkill.exe");
    try {
      const killer = spawn(taskkillPath, ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("error", (error) => {
        debugLog(`Could not taskkill headless process ${pid}`, error);
      });
      killer.unref();
    } catch (error) {
      debugLog(`Could not start taskkill for headless process ${pid}`, error);
    }
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (error: any) {
    if (error?.code !== "ESRCH") debugLog(`Could not terminate headless process ${pid}`, error);
  }
}

export interface HeadlessSpawnOptions {

  args: string[];
  cwd?: string;

  env?: Record<string, string>;

  entry?: string;
}

export interface HeadlessExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export class HeadlessChild {
  readonly child: ChildProcess;
  readonly pid: number | undefined;
  exited = false;
  exitInfo: HeadlessExitInfo | null = null;

  promptError: string | null = null;

  readonly exitPromise: Promise<HeadlessExitInfo>;

  private droppedWrites = 0;
  private stderrBytes = 0;
  private readonly onEvent: ((event: Record<string, unknown>) => void) | undefined;
  private static readonly STDERR_LOG_LIMIT = 8 * 1024;

  constructor(
    options: HeadlessSpawnOptions & { entry: string },
    onEvent?: (event: Record<string, unknown>) => void,
  ) {
    this.onEvent = onEvent;
    this.child = spawn(process.execPath, [options.entry, ...options.args], {
      cwd: options.cwd,
      env: buildSubagentProcessEnv(options.env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.pid = this.child.pid;

    attachJsonlReader(this.child.stdout!, (line) => {
      if (!line.trim()) return;
      if (!this.onEvent) return;
      try {
        this.onEvent(JSON.parse(line) as Record<string, unknown>);
      } catch (error) {

        debugLog(`headless pid=${this.pid}: unparseable stdout line`, error);
      }
    });

    this.child.stderr!.on("data", (chunk: string | Buffer) => {
      this.stderrBytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
      if (this.stderrBytes <= HeadlessChild.STDERR_LOG_LIMIT) {
        debugLog(`headless pid=${this.pid} stderr`, String(chunk).slice(0, 500));
      }
    });

    this.exitPromise = new Promise<HeadlessExitInfo>((resolve) => {
      this.child.once("exit", (code, signal) => {
        this.exited = true;
        this.exitInfo = { code, signal };
        resolve(this.exitInfo);
      });
      this.child.once("error", (error) => {

        if (!this.exited) {
          debugLog(`headless spawn error (entry=${options.entry})`, error);
          this.exited = true;
          this.exitInfo = { code: -1, signal: null };
          resolve(this.exitInfo);
        }
      });

      this.child.stdin?.on("error", () => {
        this.droppedWrites += 1;
      });
    });
  }

  send(command: Record<string, unknown>): void {
    if (this.exited || !this.child.stdin?.writable) {
      this.droppedWrites += 1;
      return;
    }
    this.child.stdin.write(serializeJsonLine(command));
  }

  steer(message: string): void {
    this.send({ type: "prompt", message, streamingBehavior: "steer" });
  }

  abort(): void {
    this.send({ type: "abort" });
  }

  kill(): void {
    if (this.exited) return;
    const pid = this.pid;
    try {
      this.child.stdin?.end();
    } catch {}
    killHeadlessProcessTree(this.child, pid);
  }

  get droppedWriteCount(): number {
    return this.droppedWrites;
  }
}

export function spawnHeadlessPi(
  options: HeadlessSpawnOptions,
  onEvent?: (event: Record<string, unknown>) => void,
): HeadlessChild {
  const entry = options.entry ?? resolvePiEntry();
  if (!entry) {
    throw new Error(
      "Cannot resolve the pi entry script for headless sub-agents. " +
        "Set PI_SUBAGENT_PI_ENTRY to the pi cli .js path.",
    );
  }
  return new HeadlessChild({ ...options, entry }, onEvent);
}
