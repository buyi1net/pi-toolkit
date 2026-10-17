// ACP owner 的数据形状契约（工单 08）：压缩块、引用与 sidecar 的稳定结构。
//
// 本文件只放形状与常量，供实现（engine/sidecar）与后续工单（09 解压搜索、
// 10 高级配置）共同消费；块与状态的本体结构来自 acp-kernel 的
// CompressionBlock / CompressionState（0.0.98），这里登记的是 sidecar 外壳与
// 本仓自己的包装视图，不复制内核字段定义。
//
// 数据形状口径（给工单 09/10）：
// - 压缩块（kernel CompressionBlock，sidecar `state.blocks[]` 原样保存）：
//   { blockId: "b1", runId: "r1", tier: 1|2|3, topic?, summary,
//     directMessageIds: 原始会话 entry id（如 "e12" / "e12#call_3" 的 base），
//     effectiveMessageIds: 直接+继承的原始 id，directBlockIds: 被再压缩的子块，
//     compressedTokens, createdAt, survivedCount, generation, active,
//     startRef/endRef: 覆盖区的首/尾引用（"m00003" 形态） }
// - 引用（sidecar `state.messageRefs`）：{ byRaw: { entryId -> "m00003" },
//   byRef: { "m00003" -> entryId } }；投影时内核给每条可见消息打
//   `<acp tokens="…" type="…">mNNNNN</acp>` 标签，模型用该 ref 圈压缩范围。
// - sidecar 文件：`<sessionFile>.acp.json`，见 AcpSidecarFile。

import type { CompressionState } from "acp-kernel";

/** sidecar 结构版本。缺省版本号的历史文件按 v1 解释（上游 billion-context-pi
 *  的既有 sidecar 同为 v1、同后缀，可互相读取）；高于本版本的文件不解释不重写。 */
export const ACP_SIDECAR_SCHEMA_VERSION = 1;

/** sidecar 后缀：与会话日志 `<file>.jsonl` 同目录同名，追加 `.acp.json` */
export const ACP_SIDECAR_SUFFIX = ".acp.json";

/** sidecar 生产者标识（写盘时登记，读取侧诊断用；不含用户路径） */
export const ACP_SIDECAR_PRODUCER = "pi-toolkit/compression-acp";

/**
 * sidecar 顶层结构（原子写入，tmp+rename）：
 * - `schemaVersion` 每次写入都带；缺失按 v1 解释；
 * - `producer` 标识写入方（本仓为 pi-toolkit/compression-acp）；
 * - `session` 记录写入时的会话身份（id 必填；file 为当时的会话文件绝对/相对路径，
 *   诊断用，不参与匹配——sidecar 归属由文件路径本身决定）；
 * - `config.fingerprint` 写入时刻的 ACP 运行时配置指纹（工单 11 配置代际：读取侧
 *   与当前指纹比较，变更时兼容判定 + 诊断，不重建）；缺省视为旧代 sidecar；
 * - `state` 是 acp-kernel 的 CompressionState 原样落盘（blocks / messageRefs /
 *   tokenSnapshot / nudge / stats / nextBlockId / nextRunId …）。
 */
export interface AcpSidecarFile {
  readonly schemaVersion: number;
  readonly producer: string;
  readonly session: {
    readonly id: string;
    readonly file?: string;
  };
  readonly config?: {
    readonly fingerprint: string;
  };
  readonly state: CompressionState;
}

/** sidecar 读取结果分类（不伪装成功：失败类别必须能进诊断） */
export type AcpSidecarLoadStatus =
  | "ok" // 正常读取（含缺省版本号的 v1 历史文件）
  | "missing" // 文件不存在（新会话正常态，或 sidecar 丢失待重建）
  | "corrupt" // 文件存在但不可解析 / 形状不对（损坏）
  | "newer-schema"; // schemaVersion 高于本实现，不解释不重写（明确失败）

export interface AcpSidecarLoadResult {
  readonly status: AcpSidecarLoadStatus;
  /** status=ok 时存在的状态；missing 时缺席 */
  readonly state?: CompressionState;
  /** status=ok 时 sidecar 登记的写入会话 id（诊断用） */
  readonly sessionId?: string;
  /** status=ok 时 sidecar 登记的配置代际指纹（工单 11；旧代 sidecar 缺席） */
  readonly configFingerprint?: string;
  /** 读到的 schemaVersion（corrupt/newer-schema 诊断用，可能缺席） */
  readonly schemaVersion?: number;
  /** 失败时的机读原因（文件系统错误等） */
  readonly error?: string;
}
