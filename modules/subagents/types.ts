import type { SubagentActivityState } from "./activity.ts";
import type { SubagentStatusState } from "./status.ts";
import type { SessionStats } from "./session.ts";
import type { HeadlessChild } from "./headless.ts";

export interface SubagentResult {
  name: string;
  task: string;
  /** 仅用于展示和结果聚合的并行分组标签,不改变生命周期语义。 */
  cohortId?: string;
  summary: string;
  sessionFile?: string;
  sessionId?: string;
  exitCode: number;
  elapsed: number;
  errorMessage?: string;
  stats?: SessionStats;
  /**
   * pane 被外部关闭且无 .exit sidecar(典型:用户直接关掉演示 pane)。
   * 这是稳定的非错误终态分类:不算 provider/agent error(不生成
   * route_exception),依赖注册表按 cancelled settle。
   */
  userClosed?: boolean;
  /**
   * 显式停止(subagent_stop)兑出的取消终态:与意外失败区分,迟到回注
   * 与依赖 settle 都按 cancelled 语义呈现,不报 failed。
   */
  stopped?: boolean;
  /**
   * /reload(module replaced)移交标记:宿主重载后旧模块的 watcher 已把该
   * 子代理移交给运行态记录恢复逻辑(recoverRuntimeSubagents),本结果不是
   * 终态——真实结果由恢复路径在子代理结束后回注。调用方不得把它当作
   * cancelled/failed 处理或再次回注,只能返回明确的 handed-off 说明。
   * 宿主会话关闭(/new、/resume 切走)的 detach 也复用该语义:进程/pane
   * 与 runtime record 全保留,由本会话的恢复路径接管。
   */
  handedOff?: boolean;
}

export type SubagentWaitMode = "hard-barrier" | "interactive" | "member-round" | "recovered";
export type SubagentWaitRelease = "escape" | "timeout";

export interface RunningSubagent {
  id: string;
  name: string;
  task: string;
  /** 仅用于展示和结果聚合的并行分组标签。 */
  cohortId?: string;
  agent?: string;
  /**
   * 解析后的模型 id(含 ":thinking" 后缀;来自显式 params、tier 解析或 agent
   * frontmatter)。route_exception 的 provider/model 拆分来源;旧记录/mock 可缺省。
   */
  model?: string | null;
  /**
   * 本次运行实际生效的思考等级（工单 27）：覆盖链解析结果——任务显式值 >
   * 代理 frontmatter > 档位默认 > 模型自带 ":level" 后缀；无等级为 null。
   * 与 model 一起构成状态行展示的同一口径（显示时剥后缀，等级由此给出）；
   * 降级重试换候选后随新运行态更新。
   */
  thinking?: string | null;
  /**
   * 工单 28：本次运行来自的模型档位与启动时的候选池快照（用量统计的
   * 降级口径——首选=池首，实际不等于首选即降级）。显式 model 运行可能只有
   * tier 没有池；resume 从 loadout 重放 tier、重连只有 tier 记录，两者都没
   * 有候选池快照，降级判定保持未知（null）。
   */
  tier?: string | null;
  modelPool?: readonly string[] | null;
  /** 直接父子代理 run id;顶层子代理为 null。 */
  parentId?: string | null;
  /** 本次硬屏障等待上限;未配置时缺省。 */
  timeoutMs?: number;
  /** 当前运行的等待载体与恢复状态。 */
  waitMode?: SubagentWaitMode;
  /** 主工具等待已被 Escape 或 timeout 解除,但子代理仍在运行。 */
  waitReleased?: SubagentWaitRelease;
  surface: string;
  startTime: number;
  sessionFile: string;
  /**
   * 发起本次运行的宿主会话 id（工单 32）：终态可能落在 /reload 或新会话之后，
   * 用量统计按它归属，不按写入时刻的当前会话。旧记录/测试夹具可缺省。
   */
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
  /**
   * 运行载体:"pane"(herdr/tmux,默认——兼容未带此字段的旧测试 mock 与旧记录)
   * 或 "headless"(独立 pi --mode rpc 后台进程)。
   */
  kind?: "pane" | "headless";
  /** headless 运行的子进程 PID(仅 kind="headless")。 */
  pid?: number;
  /** headless 运行的子进程句柄(仅 kind="headless",运行中存在)。 */
  headlessChild?: HeadlessChild;
  /** 本次 spawn 是否成功写入父侧锚定 loadout;用于 resume 信任链。 */
  anchoredLoadout?: boolean;
  /**
   * 轮次信号在会话文件暂时不可读时的内存保留副本,避免 atomic claim
   * 后因解析竞态静默丢失结果。
   */
  pendingRoundSignal?: { name: string; seq: number; at: number };
  /** 轮次关联连续读失败次数,达到上限后转为明确失败终态。 */
  roundAssociationAttempts?: number;
  /**
   * 本次 spawn 写入父会话 artifactDir/context/ 的任务与系统提示文件
   * (retention 清理用;resume 重启的新 spawn 会记录自己的新文件)。
   */
  contextFiles?: string[];
  /**
   * /reload 恢复后丢失 stdin 时的降级标记:无法再向该子代理 steer/投递
   * ask 回复,只能等进程退出后从 session 文件提取结果。显式降级,不伪称完整恢复。
   */
  stdinLost?: boolean;
  /**
   * 持久团队成员(member: true):headless 常驻进程,不走硬屏障;每轮
   * 经 team_dispatch 派单,.round sidecar 标记轮次结束。强制 headless +
   * preserve + 无 timeoutMs/dependsOn(工具层校验)。
   */
  member?: boolean;
  /** 当前是否有在途轮次(team_dispatch 置位,.round 消费后清除)。 */
  dispatchedRound?: boolean;
  /** 在途轮次的关联 nonce(spawn 首轮与 team_dispatch 各生成一个;与
   *  .round 认领时的会话 marker 检索配合,区分派单轮与自发轮)。 */
  dispatchedRoundId?: string;
  /** 在途轮次开始时的会话行数(轮次结果提取基线)。 */
  roundEntryBaseline?: number;
  /** 父会话 team roster 文件路径(成员状态转换的单一真源,父进程独写)。 */
  rosterFile?: string;
  /**
   * watcher 的终态 promise(subagent_stop 等待停止落定用)。由启动 watcher
   * 的工具路径(spawn/resume)写入;resolve 单次,promise 可被多消费。
   */
  watchPromise?: Promise<SubagentResult>;
  /**
   * 显式停止(subagent_stop)标记:置位后 watcher 把 pane 消失等观察到的
   * 中断一律按显式 cancelled 终态处理,不再误分类为 user_closed。
   */
  stopRequested?: boolean;
}
