/**
 * herdr 表面 —— IO 原语。语法族判定(shellEscape/sentinelSuffix)由
 * surface.ts 统一分派,本模块只负责对 herdr CLI 的操作。
 *
 * 全部 herdr 交互经 M0 spike 在 Windows 预览版 0.8.2 实证:
 *
 *   herdr pane split --pane <id> --direction right|down --cwd <dir> --no-focus
 *       → 新 pane,JSON 输出 .result.pane.pane_id(--env KEY=VALUE 可叠加)
 *   herdr pane run <pane> <text>
 *       → 向 pane 发送一行文本 + Enter(子代理启动命令 / steer 消息)
 *   herdr pane read <pane> --source recent-unwrapped --lines N
 *       → 读取近期输出(软换行合并,适合日志与对话)
 *   herdr pane close <pane>
 *       → 关闭 pane
 *
 * 有意不使用的 herdr 能力(决策记录,避免后人误判是遗漏):
 *   - agent 命令族(agent start --kind pi / prompt --wait / wait --until):
 *     Windows 预览版的 agent start 内部经 PowerShell Start-Process 启动,
 *     不认 npm 的 .cmd shim,pi 无法启动;且 pi 检测规则(remote/pi.toml)
 *     在 Windows 不生效,agent_status 恒为 unknown。子代理状态由本扩展的
 *     activity 快照文件自持,不依赖 herdr 的生命周期检测(Linux/macOS 下
 *     herdr 可正确识别 pi,herdr 修复 Windows 后可在此切换,不影响上层)。
 *   - pane resize / 布局重排:herdr 无布局重排能力;两表面统一不做全窗口
 *     重排(tmux 的 select-layout 也已弃用),布局契约靠 split 几何规则与
 *     “主 pane 固定一侧、只在 managed 区域内继续切分”(pane-layout.ts)维持。
 *
 * Pane 由 herdr pane id 标识(如 `wR:p7`)。主 pane 稳定占一侧:首次分屏
 * 从主 pane 切出,之后只在子代理区域内选面积最大的 pane 继续切分
 * (chooseSplitTarget),沿更适合的方向(right/down)切分,不抢用户焦点。
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { MIN_PANE_COLS, MIN_PANE_ROWS, rectMeetsBudget, type PaneRect } from "./layout-budget.ts";
import { chooseSplitDirection, chooseSplitTarget, type LayoutPane, type SplitDirection } from "./pane-layout.ts";

const execFileAsync = promisify(execFile);

let herdrAvailable: boolean | null = null;
let herdrCheckedAt = 0;
const HERDR_RETRY_AFTER_MS = 5_000;

// 只记录本扩展创建或恢复接管的 pane,避免把用户自己的 pane 当成布局目标。
const managedPaneIds = new Set<string>();

/** HERDR_ENV=1(pi 在 herdr pane 内)且 herdr CLI 可执行。 */
export function isAvailable(): boolean {
  if (process.env.HERDR_ENV !== "1") return false;
  const now = Date.now();
  if (herdrAvailable === true) return true;
  if (herdrAvailable === false && now - herdrCheckedAt < HERDR_RETRY_AFTER_MS) return false;
  try {
    execFileSync("herdr", ["--version"], { stdio: "ignore" });
    herdrAvailable = true;
  } catch {
    herdrAvailable = false;
  }
  herdrCheckedAt = now;
  return herdrAvailable;
}

export function setupHint(): string {
  return "Start pi inside a herdr pane (herdr, then run pi in a pane).";
}

/**
 * 为子代理创建新 pane:首次从主 pane 切出,之后在子代理区域内继续切分
 * (chooseSplitTarget),不抢焦点。
 * opts.cwd 直接在 split 时指定(等价于上游 tmux 版启动命令里的 cd 前缀);
 * opts.env 的键值经 pane split --env 注入子进程(子代理身份、会话路径等
 * PI_SUBAGENT_* 变量),不拼 shell 前缀。
 * 返回 herdr pane id(如 `wR:p7`)。
 */
export function createSurface(
  name: string,
  opts?: { cwd?: string; env?: Record<string, string> },
): string {
  void name; // herdr pane 靠 terminal title 展示,pane 内 pi 进程自带标题。
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

/** 读取当前 Tab 的完整 pane 布局。 */
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

/**
 * 向 pane 发送一行文本并回车。文本经 execFile 参数直传 herdr,不经过中间
 * shell 解释;pane 内若是 pi TUI 则进入输入框,若是 shell 则作为命令执行。
 */
export function sendCommand(surface: string, text: string): void {
  execFileSync("herdr", ["pane", "run", surface, text], { encoding: "utf8" });
}

/** 读取 pane 近期输出(同步)。recent-unwrapped 把软换行合并为单行。 */
export function readScreen(surface: string, lines = 50): string {
  return execFileSync(
    "herdr",
    ["pane", "read", surface, "--source", "recent-unwrapped", "--lines", String(Math.max(1, lines))],
    { encoding: "utf8" },
  );
}

/** 读取 pane 近期输出(异步)。 */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  const { stdout } = await execFileAsync(
    "herdr",
    ["pane", "read", surface, "--source", "recent-unwrapped", "--lines", String(Math.max(1, lines))],
    { encoding: "utf8" },
  );
  return stdout;
}

/** 查询 pane 是否仍然存在,用于 /reload 恢复时丢弃 stale 记录。 */
export function surfaceExists(surface: string): boolean {
  try {
    execFileSync("herdr", ["pane", "get", surface], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** 重载恢复后，把已有 pane 纳入当前 Tab 的布局目标集合。 */
export function trackSurface(surface: string): void {
  managedPaneIds.add(surface);
}

/** 关闭 pane(其内进程随之终止)。 */
export function closeSurface(surface: string): void {
  execFileSync("herdr", ["pane", "close", surface], { encoding: "utf8" });
  managedPaneIds.delete(surface);
}

/** 给 pane 设置可识别标签(best-effort,失败不致命)。 */
export function labelSurface(surface: string, label: string): void {
  execFileSync("herdr", ["pane", "rename", surface, label], { encoding: "utf8" });
}
