/**
 * headless 表面 —— 独立进程 IO 原语。自动(auto-exit)子代理作为独立
 * `pi --mode rpc` 进程后台运行,不在 herdr/tmux 创建 pane/tab。
 *
 * 与 pane 表面(herdr.ts/tmux.ts,读屏 + sentinel)不同,headless 的
 * 生命周期信号全部来自 RPC 协议与进程状态:
 *   - prompt/steer:stdin JSONL 命令(`prompt` + streamingBehavior:"steer"
 *     同时覆盖运行中排队与空闲新 run 两种状态,见 pi docs/rpc.md);
 *   - 终态:进程退出。subagent-done.ts 的 auto-exit(agent_end → ctx.shutdown())
 *     在 RPC 模式会置 shutdownRequested 并 process.exit;ask_question 等待
 *     与等待孙代理结果时 shutdown 被抑制,进程保持存活,与 pane 语义对齐;
 *   - 错误路径:仍复用 `${sessionFile}.exit` sidecar(subagent-done 写入);
 *   - ask_question:仍复用 `${sessionFile}.ask` sidecar(与表面无关)。
 *
 * Windows 注意:直接 spawn("pi") 会 ENOENT、spawn("pi.cmd") 因 CVE-2024-27980
 * 修复抛 EINVAL,因此与官方 RpcClient 一致,用 `spawn(process.execPath, [entry])`
 * 直接以 node 执行 pi 入口脚本;入口默认取宿主 pi 进程自身的 process.argv[1]
 * (子代理与宿主 pi 同版本同入口),允许 PI_SUBAGENT_PI_ENTRY 显式覆盖。
 *
 * RPC stdout 是严格 LF JSONL:不能用 readline(它按 U+2028/U+2029 也分帧,
 * 会撕裂 JSON 字符串),帧解析用下方 attachJsonlReader(语义对齐官方
 * dist/modes/rpc/jsonl.js)。stdout/stderr 全程持续消费,防止 pipe 背压
 * 阻塞子进程。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { join } from "node:path";
import { debugLog } from "./diagnostics.ts";

const SUBAGENT_ENV_PREFIX = "PI_SUBAGENT_";
const PROPAGATED_SUBAGENT_ENV = "PI_SUBAGENT_PI_ENTRY";

function isLifecycleSubagentEnvKey(key: string): boolean {
  const normalized = key.toUpperCase();
  return normalized.startsWith(SUBAGENT_ENV_PREFIX) && normalized !== PROPAGATED_SUBAGENT_ENV;
}

/**
 * 为新子代理构造表面注入环境。
 *
 * pane 的 shell 会先继承父进程环境,因此不能只在“需要时”设置标志;
 * 先把父子生命周期、团队授权和身份变量显式清空,再叠加本次启动值。
 * `PI_SUBAGENT_PI_ENTRY` 是唯一有意向下传播的变量,用于嵌套 spawn 继续
 * 使用同一个 pi 入口(测试 stub 也依赖此路径)。
 */
export function createSubagentLaunchEnv(
  overrides: Record<string, string> = {},
): Record<string, string> {
  const cleared: Record<string, string> = {};
  for (const key of Object.keys(process.env)) {
    if (isLifecycleSubagentEnvKey(key)) cleared[key] = "";
  }
  return { ...cleared, ...overrides };
}

/**
 * 为 headless 子进程构造真正的环境。
 * 与 pane 不同,这里可以直接从继承基线删除生命周期变量,避免空值变量
 * 被孙代理当成父代理授予的 member/team 权限。
 */
export function buildSubagentProcessEnv(
  overrides: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const inherited: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(inherited)) {
    if (isLifecycleSubagentEnvKey(key)) delete inherited[key];
  }
  return { ...inherited, ...overrides };
}

/** 严格 LF 分帧的 JSONL 读取器。接受可选 \r\n;不按 Unicode 分隔符分帧。 */
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

/** 序列化单条 JSONL 记录(写入方保证 LF 结尾;JSON.stringify 不产生裸 LF)。 */
export function serializeJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/**
 * 解析 pi 入口脚本路径。优先级:
 *   1. PI_SUBAGENT_PI_ENTRY(显式覆盖,测试注入 stub 也走这里);
 *   2. 宿主 pi 进程自身的 process.argv[1](子代理与宿主同版本同入口,
 *      且恰好绕开 Windows 上 .cmd shim 不可 spawn 的问题);
 * 找不到时返回 null,由调用方报错——不做 PATH 里 spawn "pi" 的尝试,
 * 那在 Windows 上不可靠(ENOENT/EINVAL)。
 */
export function resolvePiEntry(): string | null {
  const override = process.env.PI_SUBAGENT_PI_ENTRY?.trim();
  if (override) return override;
  const self = process.argv[1];
  if (self && /\.(c|m)?js$/i.test(self) && existsSync(self)) return self;
  return null;
}

/**
 * headless 运行记录存放在 RunningSubagent.surface 的形式:`headless:<pid>`。
 * pane 记录仍是 herdr/tmux 的 pane id,两种前缀天然区分。
 */
export const HEADLESS_SURFACE_PREFIX = "headless:";

export function formatHeadlessSurface(pid: number): string {
  return `${HEADLESS_SURFACE_PREFIX}${pid}`;
}

export function parseHeadlessSurface(surface: string): number | null {
  if (!surface.startsWith(HEADLESS_SURFACE_PREFIX)) return null;
  const pid = Number.parseInt(surface.slice(HEADLESS_SURFACE_PREFIX.length), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * PID 存在性探测。ESRCH → 不存在;EPERM → 存在但无权发信号(仍算活着);
 * Windows 上 process.kill(pid, 0) 走 OpenProcess 探测,同样可用。
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

/**
 * 终止一个 headless 子进程:Windows 上先 taskkill /T(树杀,覆盖 RPC 孙进程),
 * 再 direct kill(兑底确保根进程死透)。顺序不能反:direct kill 先杀 node 根
 * 会切断进程树,taskkill /T 随后枚举不到孙进程,留下孤儿 RPC 进程。
 * 非 Windows 只做 direct kill(SIGTERM);treeKill 参数仅供测试注入观察顺序。
 */
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

/**
 * Terminate a recovered headless process when its original ChildProcess
 * handle is unavailable (for example after /reload). On Windows `child.kill`
 * only targets the direct node process, so use the official taskkill tree
 * operation as well to avoid leaving RPC descendants behind.
 */
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
  /** pi 的 argv(不含入口脚本本身,如 ["--mode","rpc","--session",...]),纯 argv 直传,不经 shell。 */
  args: string[];
  cwd?: string;
  /** 叠加在 process.env 之上的环境变量(PI_SUBAGENT_* 等)。 */
  env?: Record<string, string>;
  /** 覆盖 pi 入口(默认 resolvePiEntry())。 */
  entry?: string;
}

export interface HeadlessExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * 一个独立 pi --mode rpc 子进程的受控句柄。
 * stdout 持续分帧消费(onEvent 可为空,事件仍被读取丢弃,防背压);
 * stderr 持续消费(限量 debugLog);stdin 写入在进程死后静默丢弃
 * (竞态窗口:调用方在收到 exit 前发的命令)。
 */
export class HeadlessChild {
  readonly child: ChildProcess;
  readonly pid: number | undefined;
  exited = false;
  exitInfo: HeadlessExitInfo | null = null;
  /** 初始 prompt 被 RPC 侧拒绝时的错误(preflight 失败,如无可用模型/凭据)。 */
  promptError: string | null = null;
  /** 进程退出(或 spawn 失败)时 resolve。 */
  readonly exitPromise: Promise<HeadlessExitInfo>;
  /** stdin 已断(子进程提前退出)后收到的写入计数,仅供诊断。 */
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

    // stdout 必须持续消费:即使调用方不关心事件,也不能让 pipe 满阻塞子进程。
    attachJsonlReader(this.child.stdout!, (line) => {
      if (!line.trim()) return;
      if (!this.onEvent) return;
      try {
        this.onEvent(JSON.parse(line) as Record<string, unknown>);
      } catch (error) {
        // 非 JSON 行(理论不应出现)不致命,记录后继续读。
        debugLog(`headless pid=${this.pid}: unparseable stdout line`, error);
      }
    });

    // stderr 同理必须持续消费,只限量记日志,防止背压死锁。
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
        // spawn 失败(如入口不存在):按 exit 兑现,exitInfo.code 置 -1 供上层报错。
        if (!this.exited) {
          debugLog(`headless spawn error (entry=${options.entry})`, error);
          this.exited = true;
          this.exitInfo = { code: -1, signal: null };
          resolve(this.exitInfo);
        }
      });
      // 子进程退出与写入的竞态会产生 EPIPE(标志位更新前发送的命令);
      // 吞掉异步 error 事件,避免它变成未捕获异常——真实场景中子代理刚
      // 结束时 steer 也会撞上这个窗口。
      this.child.stdin?.on("error", () => {
        this.droppedWrites += 1;
      });
    });
  }

  /** 写一条 RPC 命令到 stdin。进程已退出时丢弃并计数,不抛错。 */
  send(command: Record<string, unknown>): void {
    if (this.exited || !this.child.stdin?.writable) {
      this.droppedWrites += 1;
      return;
    }
    this.child.stdin.write(serializeJsonLine(command));
  }

  /**
   * 向子代理投递一条消息:运行中排队为 steering,空闲时开启新 run。
   * 用 `prompt` + streamingBehavior:"steer" 而非裸 `steer` 命令,因为后者
   * 只入队不触发,空闲(如等待 ask 回复)时消息会滞留到下一次 prompt。
   */
  steer(message: string): void {
    this.send({ type: "prompt", message, streamingBehavior: "steer" });
  }

  /** 请求中止当前 agent run(best-effort;真正终止由调用方决定是否 kill)。 */
  abort(): void {
    this.send({ type: "abort" });
  }

  /** 关闭 stdin 并终止进程。用于取消与会话关闭;对已退出进程是 no-op。 */
  kill(): void {
    if (this.exited) return;
    const pid = this.pid;
    try {
      this.child.stdin?.end();
    } catch {}
    killHeadlessProcessTree(this.child, pid);
  }

  /** 诊断:被丢弃的 stdin 写入数。 */
  get droppedWriteCount(): number {
    return this.droppedWrites;
  }
}

/** 启动一个 headless pi 子进程。入口解析失败直接抛错(不在 PATH 上碰运气)。 */
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
