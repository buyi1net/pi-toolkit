/**
 * 表面层统一入口 —— index.ts 只依赖本文件,不直接依赖具体复用器。
 *
 * 检测规则(按 pi 实际运行的位置,天然互斥):
 *   HERDR_ENV=1 → herdr 表面(pi 跑在 herdr pane 内)
 *   TMUX 设置   → tmux 表面(pi 跑在 tmux pane 内)
 *   都没有      → 无可用表面(报错提示用户进入其中之一)
 *
 * shell 语法跟表面走:
 *   herdr:pane 默认 shell 跟随宿主(Windows=PowerShell,Linux/macOS=POSIX)
 *   tmux: 恒为 POSIX shell(tmux 无 Windows 原生支持)
 *
 * pollForExit 与两个表面无关(读屏经 readScreenAsync 抽象,sidecar 文件
 * 机制是纯文件协议),集中在本文件。
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import * as herdrSurface from "./herdr.ts";
import * as tmuxSurface from "./tmux.ts";
import { debugLog } from "./diagnostics.ts";

// ── 归属护栏 ──
// 只允许关闭本扩展自己创建的 pane。任何关闭路径(含未来新增功能)都必须
// 经由 closeSurface → assertOwned 这道闸,防止误关用户或其它 agent 的
// pane(事故预防:曾发生过把外部 pane 当测试残留误关的事故)。
const ownedSurfaces = new Set<string>();

/**
 * 读取并消费 `.exit` sidecar(原子性由写入方 tmp+rename 保证)。
 * pane 与 headless 两条 watcher 共用:pane 在轮询与读屏失败兜底时读,
 * headless 在进程退出后读。
 */
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
/**
 * 只读查看 `.exit` sidecar(不消费)。跨 turn dependsOn 判定用:判定方
 * 不是该 sidecar 的生命周期所有者,删除式读取会破坏后续判定(文件被消费
 * 后,同一失败上游在下一个 turn/进程里会被误判为 completed)。消费式
 * 读取仍由 watcher 路径(readExitSidecar)负责——它是唯一有权消费的一方。
 */
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

/** 校验 pane 归属;非本扩展创建的 pane 抛错拒绝。 */
export function assertOwned(surface: string): void {
  if (!ownedSurfaces.has(surface)) {
    throw new Error(
      `Refusing to close pane "${surface}": it was not created by this extension. ` +
        "Only panes spawned via createSurface() may be closed.",
    );
  }
}

export type SurfaceKind = "herdr" | "tmux";
export type ShellSyntax = "powershell" | "posix";

/** 当前应使用的表面;无可用表面时返回 null。 */
export function detectSurface(): SurfaceKind | null {
  if (process.env.HERDR_ENV === "1") return "herdr";
  if (process.env.TMUX) return "tmux";
  return null;
}

/** 当前表面内 shell 的语法族。无表面时按宿主平台推断(供纯函数测试等场景)。 */
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

/** 表面可用性(环境检测 + CLI 二进制存在)。 */
export function isMuxAvailable(): boolean {
  switch (detectSurface()) {
    case "herdr":
      return herdrSurface.isAvailable();
    case "tmux":
      return tmuxSurface.isAvailable();
    default:
      return false;
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

/**
 * 单引号字面量转义,按当前表面 shell 语法分派。
 */
export function shellEscape(s: string): string {
  return shellSyntax() === "posix"
    ? "'" + s.replace(/'/g, "'\\''") + "'"
    : "'" + s.replace(/'/g, "''") + "'";
}

/**
 * 启动命令后缀:pi 退出后 echo 带退出码的 sentinel。
 * PowerShell:$LASTEXITCODE(花括号防止尾部下划线并进变量名);
 * POSIX:$?(文字部分单引号包裹,$? 裸露求值拼接)。
 */
export function sentinelSuffix(token = "__SUBAGENT_DONE"): string {
  return shellSyntax() === "posix"
    ? `; echo '${token}_'$?'__'`
    : `; echo "${token}_\${LASTEXITCODE}__"`;
}

/** 为子代理创建新 pane。opts.cwd 直接指定工作目录,opts.env 注入环境变量。 */
export function createSurface(
  name: string,
  opts?: { cwd?: string; env?: Record<string, string> },
): string {
  const id = requireSurface().createSurface(name, opts);
  ownedSurfaces.add(id);
  // best-effort 标记:让 pane 在复用器 UI 里一眼可辨归属
  try {
    requireSurface().labelSurface?.(id, `[pi-sub] ${name}`);
  } catch (error) {
    debugLog(`Could not label pane ${id}`, error);
  }
  return id;
}

/** 向 pane 发送一行文本并回车(子代理启动命令 / steer 消息)。 */
export function sendCommand(surface: string, text: string): void {
  requireSurface().sendCommand(surface, text);
}

/** 读取 pane 近期输出(同步)。 */
export function readScreen(surface: string, lines = 50): string {
  return requireSurface().readScreen(surface, lines);
}

/** 读取 pane 近期输出(异步)。 */
export function readScreenAsync(surface: string, lines = 50): Promise<string> {
  return requireSurface().readScreenAsync(surface, lines);
}

/** 关闭 pane(其内进程随之终止)。仅限本扩展创建的 pane,否则拒绝。 */
export function closeSurface(surface: string): void {
  assertOwned(surface);
  requireSurface().closeSurface(surface);
  ownedSurfaces.delete(surface);
}

/**
 * 重载后恢复本扩展此前持有的 pane，使 watcher 可以继续接管生命周期。
 * 返回 false 表示运行态记录指向的 pane 已经不存在。
 */
export function adoptSurface(surface: string): boolean {
  if (!surface.trim()) return false;
  const exists = requireSurface().surfaceExists?.(surface);
  if (exists === false) return false;
  requireSurface().trackSurface?.(surface);
  ownedSurfaces.add(surface);
  return true;
}

/**
 * 只读探测 pane 是否仍存在。没有可用复用器或表面不支持探测时返回
 * null，调用方不得把未知状态当成已退出。
 */
export function probeSurface(surface: string): boolean | null {
  if (!surface.trim() || !detectSurface()) return null;
  try {
    const check = requireSurface().surfaceExists;
    return check ? check(surface) : null;
  } catch (error) {
    debugLog(`Could not probe subagent surface ${surface}`, error);
    return null;
  }
}

function requireSurface(): SurfaceModule {
  const kind = detectSurface();
  if (kind === "herdr") return herdrSurface;
  if (kind === "tmux") return tmuxSurface;
  throw new Error(`No terminal multiplexer detected. ${muxSetupHint()}`);
}

/** 两个表面模块必须实现的统一原语集。 */
interface SurfaceModule {
  isAvailable(): boolean;
  setupHint(): string;
  createSurface(name: string, opts?: { cwd?: string; env?: Record<string, string> }): string;
  sendCommand(surface: string, text: string): void;
  readScreen(surface: string, lines?: number): string;
  readScreenAsync(surface: string, lines?: number): Promise<string>;
  closeSurface(surface: string): void;
  surfaceExists?(surface: string): boolean;
  /** 恢复后把已有 pane 纳入表面层的布局目标集合。 */
  trackSurface?(surface: string): void;
  /** best-effort,表面可不实现 */
  labelSurface?(surface: string, label: string): void;
}

// ── 退出轮询(与表面无关)──

export interface PollResult {
  /**
   * 子代理如何退出。"user_closed":pane 被外部关闭且无 .exit sidecar
   * (典型:用户直接关掉演示 pane)——稳定分类,不进 provider/agent error。
   */
  reason: "done" | "sentinel" | "error" | "user_closed";
  /** shell 退出码(来自 sentinel)。文件路径的退出为 0。 */
  exitCode: number;
  /** reason 为 "error" 时的错误信息(自动重试耗尽、供应商过载等) */
  errorMessage?: string;
}

/**
 * 解析 `.exit` sidecar 内容(subagent-done.ts 的错误路径写入)。
 * 集中在此让 pollForExit 的快慢两条路径与 headless watcher 用同一套解码。
 * 正常完成不写 sidecar,headless 路径靠进程退出 + 本文件兜底判定。
 * 注意:ask_question 不写 .exit —— 会话保持打开,经独立的 .ask 文件
 * 通知父会话(见 index.ts 的 deliverPendingQuestion)。
 */
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

/** pane 消失且无 .exit sidecar 时的稳定分类:用户关闭,不是 provider 错误。 */
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

/**
 * 轮询直至子代理退出。先查 `.exit` sidecar 文件(错误路径), 
 * 再读 pane 屏幕匹配完成 sentinel(正常完成与崩溃检测)。
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    /** 当前运行专属 token，避免普通输出伪造完成标记。 */
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
      // pane 可能已被销毁 —— 补查一次 sidecar,避免丢掉刚落盘的退出信息
      const late = readExitFile();
      if (late) return late;
      if (isMissingSurfaceError(error)) {
        return paneGoneResult("surface command unavailable — herdr/tmux may have exited or been removed");
      }
      readFailures += 1;
      // 连续读取失败且无 sidecar:pane 大概率已被外部关闭(herdr/tmux 读屏均
      // 走这条路径),终止轮询并归为稳定的 user_closed 终态——不是 provider
      // 错误,不生成 route_exception;避免 watcher/运行记录/widget 永久卡死。
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
