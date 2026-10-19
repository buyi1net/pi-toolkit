// Codex checkpoint 的会话级投影（工单 04 从上游 checkpoint-projection.ts 提取；
// 工单 09 统一宿主实际投影；升级工单 02 同边界收口）。
//
// 上游对应：reference/Pi生态/pi-codex-compact/source/src/checkpoint-projection.ts
// （MIT，来源登记见 ../UPSTREAM.md）。适配点：
// - 上游的 projectedKeptMessages 依赖 buildSessionProjection（Pi 1.3.0 起的导出）。
//   工单 09 起本仓不自行推导，改经 host-projection 接缝取宿主实际投影；
//   升级工单 02（升级规格批次 B）删除旧版 baseline 与运行期探测后，该接缝只余
//   Pi 1.3.0 buildSessionProjection 一种语义：所有有效 context_edit 先应用到
//   entries，再产出 canonical context messages / retained entries / 指纹。
// - 上游对旧版本「指纹按原始条目计算」的兼容回退不保留（本仓 v1 起步，
//   没有历史包袱；上游存量 checkpoint 的迁移归工单 14 收口）。
//
// 两个入口：
// - keptMessagesAfterCompaction：压缩时刻计算保留消息指纹（写入 details）；
// - projectSessionCheckpointContext：回放时刻重建规范快照 → 指纹前缀校验 →
//   调 checkpoint.ts 的消息级投影把 marker 注入请求视图。
//
// 升级工单 02 口径：两个入口共用同一条 synthetic compaction boundary
// （syntheticCompactionKept）。回放侧不再投影到没有 compaction boundary 的
// pre-compaction parent——否则保留区间的 system 消息剔除、older compaction
// 抑制等宿主规则两侧不一致，指纹对不上（官方 Pi 1.3.0 实跑证据：
// probeKept roles: toolResult,user,assistant / canonical roles:
// toolResult,system,user,assistant / MATCH: false）。synthetic boundary 沿用
// 真实 checkpoint 的 parentId 与 firstKeptEntryId，不放宽指纹、不忽略首差异、
// 不任意删除消息；匹配失败仍由调用方进入保护路径。

import type { CompactionEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  type CodexAgentMessage,
  type CodexCheckpointDetails,
  fingerprintMessage,
  projectCheckpointContext,
} from "./checkpoint.ts";
import type { SessionProjectionFn } from "./host-projection.ts";

/** synthetic compaction boundary 探针条目的 id（仅内存探针，绝不落盘） */
const SYNTHETIC_BOUNDARY_ID = "pi-toolkit-compression-probe";

/**
 * 同一条 synthetic compaction boundary：在 leafId（压缩时刻的叶子）后追加一条
 * 合成 compaction 条目（firstKeptEntryId 取真实切点），用宿主投影求「compaction
 * 生效后的活动视图」，去掉首条 summary 消息即为保留区间——与宿主重建上下文
 * 同源（context_edit 已应用、保留区间剔除 system 消息、older compaction 抑制，
 * 全部由同一份宿主规则决定）。首条不是 summary 时返回 undefined：边界不可
 * 验证，调用方按探针失败/回放保护处理，不得猜测保留区间。
 */
function syntheticCompactionKept(
  projection: SessionProjectionFn,
  entries: readonly SessionEntry[],
  leafId: string | null,
  firstKeptEntryId: string,
): CodexAgentMessage[] | undefined {
  const probe: CompactionEntry = {
    type: "compaction",
    id: SYNTHETIC_BOUNDARY_ID,
    parentId: leafId,
    timestamp: new Date(0).toISOString(),
    summary: "",
    firstKeptEntryId,
    tokensBefore: 0,
  };
  // 叶子指向探针：路径 = root→…→旧叶→探针，探针即路径上最新的 compaction，
  // 宿主投影产出 [探针 summary, 从 firstKept 起的保留区间（编辑已应用）]
  const messages = [...projection([...entries, probe], probe.id).messages];
  if (messages.length === 0 || messages[0].role !== "compactionSummary") return undefined;
  return messages.slice(1);
}

/**
 * 压缩时刻：计算本次压缩后宿主将保留的消息（写入 checkpoint 的
 * keptMessageFingerprints）。与回放侧共用 syntheticCompactionKept；探针边界
 * 无法验证时抛错（调用方取消压缩，不写入无法对齐的指纹）。
 */
export function keptMessagesAfterCompaction(
  projection: SessionProjectionFn,
  branchEntries: readonly SessionEntry[],
  firstKeptEntryId: string,
): CodexAgentMessage[] {
  const leafId = branchEntries.at(-1)?.id ?? null;
  const kept = syntheticCompactionKept(projection, branchEntries, leafId, firstKeptEntryId);
  if (!kept) {
    throw new Error("Synthetic compaction boundary did not produce a leading summary message");
  }
  return kept;
}

/**
 * 回放时刻：重建 checkpoint 压缩时的规范保留快照。与压缩时刻共用同一条
 * synthetic compaction boundary（工单 02）：在 checkpoint 的 parentId（压缩
 * 时刻的叶子）上追加同参数的合成 compaction，用宿主投影重建「checkpoint
 * 生效后的保留区间」——system 消息的剔除与 older compaction 的抑制由同一份
 * 宿主规则决定，不在回放侧另写过滤。分支里找不到父条目（日志被裁剪）或
 * 边界不可验证时返回 undefined。
 */
function canonicalKeptForCheckpoint(
  projection: SessionProjectionFn,
  entries: readonly SessionEntry[],
  checkpoint: { entry: CompactionEntry; details: CodexCheckpointDetails },
): CodexAgentMessage[] | undefined {
  const { entry } = checkpoint;
  if (entry.parentId !== null && !entries.some((candidate) => candidate.id === entry.parentId)) return undefined;
  // 探针 parentId = 压缩时刻的真实叶子（entry.parentId），投影路径沿 parentId
  // 链回溯：checkpoint 之后追加的条目不在路径上，天然被排除
  return syntheticCompactionKept(projection, entries, entry.parentId, entry.firstKeptEntryId);
}

/**
 * 当前分支的宿主视图消息（诊断与测试用）：与宿主 context 事件同源口径；
 * leafId 为空时返回空。
 */
export function piContextMessages(
  projection: SessionProjectionFn,
  entries: readonly SessionEntry[],
  leafId: string | null,
): CodexAgentMessage[] {
  return [...projection([...entries], leafId).messages];
}

/**
 * 回放投影（context 事件）：校验 checkpoint 与当前会话分支一致后，把请求
 * 视图里的 compactionSummary + 保留区间替换为 marker 消息。任何校验不过
 * （父条目缺失 / 指纹不符 / 视图对不上）返回 undefined——调用方保持宿主的
 * 原视图（降级为 fallback 文案，不注入 opaque 历史）。
 */
export function projectSessionCheckpointContext(
  projection: SessionProjectionFn,
  messages: readonly CodexAgentMessage[],
  entries: readonly SessionEntry[],
  checkpoint: {
    readonly entry: CompactionEntry;
    readonly details: CodexCheckpointDetails;
  },
): CodexAgentMessage[] | undefined {
  const { entry, details } = checkpoint;
  const canonical = canonicalKeptForCheckpoint(projection, entries, checkpoint);
  if (!canonical) return undefined;
  const fingerprints = canonical.map(fingerprintMessage);
  const matches =
    fingerprints.length === details.keptMessageFingerprints.length &&
    fingerprints.every((fingerprint, index) => fingerprint === details.keptMessageFingerprints[index]);
  if (!matches) return undefined;
  return projectCheckpointContext(messages, { ...details, keptMessageFingerprints: fingerprints }, entry.summary);
}
