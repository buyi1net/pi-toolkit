// Codex checkpoint 的会话级投影（工单 04 从上游 checkpoint-projection.ts 提取）。
//
// 上游对应：reference/Pi生态/pi-codex-compact/source/src/checkpoint-projection.ts
// （MIT，来源登记见 ../UPSTREAM.md）。适配点（Pi 1.3.0 事实契约，工单 03 核验）：
// - 上游的 projectedKeptMessages 依赖 buildSessionProjection（Pi 更新版本的
//   接口），Pi 1.3.0 没有这个导出。本仓改用 Pi 1.3.0 自己的
//   buildContextEntries / sessionEntryToContextMessages 推导「压缩后保留的
//   消息」与「回放时刻的规范快照」——两端（压缩时刻 / 回放时刻）走同一个
//   Pi 投影函数，指纹口径自然一致；Pi 1.3.0 没有 context_edit 条目，投影是
//   纯树遍历，两侧结果可比。
// - 上游对旧版本「指纹按原始条目计算」的兼容回退不保留（本仓 v1 起步，
//   没有历史包袱；上游存量 checkpoint 的迁移归工单 14 收口）。
//
// 两个入口：
// - keptMessagesAfterCompaction：压缩时刻计算保留消息指纹（写入 details）；
// - projectSessionCheckpointContext：回放时刻重建规范快照 → 指纹前缀校验 →
//   调 checkpoint.ts 的消息级投影把 marker 注入请求视图。

import {
  buildContextEntries,
  type CompactionEntry,
  type SessionEntry,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import {
  type CodexAgentMessage,
  type CodexCheckpointDetails,
  fingerprintMessage,
  projectCheckpointContext,
} from "./checkpoint.ts";

/** 会话条目 → 规范上下文消息（压缩时刻 / 回放时刻共用同一投影口径） */
function canonicalContextMessages(entries: readonly SessionEntry[]): CodexAgentMessage[] {
  return entries.flatMap(sessionEntryToContextMessages);
}

/**
 * 压缩时刻：计算本次压缩后 Pi 将保留的消息（写入 checkpoint 的
 * keptMessageFingerprints）。做法是在当前分支末尾追加一条假想 compaction
 * 条目（firstKeptEntryId 取 preparation 的切点），用 Pi 自己的
 * buildContextEntries 求「新 compaction 生效后的活动视图」，去掉首条的
 * summary 消息即为保留消息——与压缩完成后宿主重建上下文的算法同源。
 */
export function keptMessagesAfterCompaction(
  branchEntries: readonly SessionEntry[],
  firstKeptEntryId: string,
): CodexAgentMessage[] {
  const leafId = branchEntries.at(-1)?.id ?? null;
  const probe: CompactionEntry = {
    type: "compaction",
    id: "pi-toolkit-compression-probe",
    parentId: leafId,
    timestamp: new Date(0).toISOString(),
    summary: "",
    firstKeptEntryId,
    tokensBefore: 0,
  };
  // 叶子指向探针：路径 = root→…→旧叶→探针，探针即路径上最新的 compaction，
  // buildContextEntries 产出 [探针, 从 firstKept 起的保留区间, 探针后(无)]
  const entries = buildContextEntries([...branchEntries, probe], probe.id);
  const messages = canonicalContextMessages(entries);
  // 首条消息即探针的 summary（空文案），去掉它就是压缩后保留的消息
  if (messages.length > 0 && messages[0].role === "compactionSummary") return messages.slice(1);
  return messages;
}

/**
 * 回放时刻：重建 checkpoint 压缩时的规范保留快照。以 checkpoint 条目的
 * parentId（压缩时刻的叶子）为叶回放 pre-compaction 视图，从
 * firstKeptEntryId 起取保留区间。分支里找不到父条目（日志被裁剪）或切点
 * 不在活动路径上返回 undefined。
 */
function canonicalKeptForCheckpoint(
  entries: readonly SessionEntry[],
  checkpoint: { entry: CompactionEntry; details: CodexCheckpointDetails },
): CodexAgentMessage[] | undefined {
  const { entry } = checkpoint;
  if (entry.parentId !== null && !entries.some((candidate) => candidate.id === entry.parentId)) return undefined;
  const preView = buildContextEntries([...entries], entry.parentId);
  const index = preView.findIndex((candidate) => candidate.id === entry.firstKeptEntryId);
  if (index < 0) return undefined;
  return canonicalContextMessages(preView.slice(index));
}

/**
 * 当前分支的 Pi 视图消息（诊断与测试用）：与宿主 context 事件同源口径
 * （buildContextEntries + 逐条目消息投影）；leafId 为空时返回空。
 */
export function piContextMessages(
  entries: readonly SessionEntry[],
  leafId: string | null,
): CodexAgentMessage[] {
  return canonicalContextMessages(buildContextEntries([...entries], leafId));
}

/**
 * 回放投影（context 事件）：校验 checkpoint 与当前会话分支一致后，把请求
 * 视图里的 compactionSummary + 保留区间替换为 marker 消息。任何校验不过
 * （父条目缺失 / 指纹不符 / 视图对不上）返回 undefined——调用方保持 Pi 的
 * 原视图（降级为 fallback 文案，不注入 opaque 历史）。
 */
export function projectSessionCheckpointContext(
  messages: readonly CodexAgentMessage[],
  entries: readonly SessionEntry[],
  checkpoint: {
    readonly entry: CompactionEntry;
    readonly details: CodexCheckpointDetails;
  },
): CodexAgentMessage[] | undefined {
  const { entry, details } = checkpoint;
  const canonical = canonicalKeptForCheckpoint(entries, checkpoint);
  if (!canonical) return undefined;
  const fingerprints = canonical.map(fingerprintMessage);
  const matches =
    fingerprints.length === details.keptMessageFingerprints.length &&
    fingerprints.every((fingerprint, index) => fingerprint === details.keptMessageFingerprints[index]);
  if (!matches) return undefined;
  return projectCheckpointContext(messages, { ...details, keptMessageFingerprints: fingerprints }, entry.summary);
}
