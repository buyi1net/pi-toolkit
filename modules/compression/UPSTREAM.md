# 压缩模块上游来源与许可证登记

本文件登记 `modules/compression/` 实现所依据的上游来源、固定提交与许可证（规格场景 24）。
codex / acp 的实现已移植接入（工单 04–09），`acp-kernel` 已按运行时依赖规则引入
（工单 08/09 接入）；后续升级版本时按本文件核对并更新。

## 登记条目

| 来源 | 固定版本 | 许可证 | 用途 |
|---|---|---|---|
| [`@narumitw/pi-codex-compact`](https://www.npmjs.com/package/@narumitw/pi-codex-compact) | npm `0.56.1`；仓库快照 [narumiruna/pi-extensions](https://github.com/narumiruna/pi-extensions/tree/f1d7498fa87873920e6e4e0033f87ac12c3048ef/packages/pi-codex-compact) 的 `packages/pi-codex-compact`，固定提交 `f1d7498fa87873920e6e4e0033f87ac12c3048ef`（2026-10-17 核验） | MIT（包内 `LICENSE` 要求保留版权与许可文本） | Codex Responses 压缩实现的研究与移植来源（Remote V2、`responses/compact`、Context Management、opaque checkpoint） |
| [`billion-context-pi`](https://github.com/ranxianglei/billion-context-pi) | `0.1.83`，固定提交 `f9dc71398100bf1a5b1eca45ec7b482dda47e16d`（`master`，2026-10-04 核验） | MIT | ACP 客户端压缩实现的研究与移植来源（压缩块、引用、sidecar、按需恢复；评审修复 F1 追加：messages.ts 的内核正文改写语义、reasoning-drop.ts 的 thinking 丢弃、surface.ts 的工具提示面覆写机制、strip-images 的历史图片剥离语义）。仅作实现来源，产品模式名用 `acp`，配置与菜单不出现上游项目名 |
| `acp-kernel` | npm `0.0.98`（2026-10-17 核验：可安装、MIT、作者 ranxianglei、零传递依赖，仓库 [ranxianglei/acp-kernel](https://github.com/ranxianglei/acp-kernel)） | MIT | ACP 底层运行时依赖：压缩块/引用/投影引擎（`createCore` / `processTurn` / `applyCompression` / `rebuildCompressionState` / `parseCompressArgs` / `defaultConfig` / `defaultCountTokens` / `renderNudgeText`，工单 08 接入；解压与搜索原语 `parseBlockIdArg` / `collectBlockContent` / `markBlockRestoredInline` / `searchBlocks` / `blockDocs` / `messageDocs`，保护判定 `protectedTools` / `preserveRecent*` Config 字段，工单 09 接入）。依赖实体按项目运行时依赖规则放 `runtime/pi-toolkit/node_modules`（`scripts/pi-toolkit/prepare-runtime.mjs` 从源码包 dependencies 生成清单并安装），源码 package.json 只声明版本 |

## 本地参考副本

- pi-codex-compact：`reference/Pi生态/pi-codex-compact/`（固定提交快照 + 参考说明，只读）
- billion-context-pi：`reference/Pi生态/billion-context-pi/`（参考说明；源码快照按参考区规则拉取，只读）
- 核验记录见各目录的参考说明（固定提交、许可证与核验日期；本表登记与之一致）

## 引入边界

- MIT 来源在把代码或实质性代码片段并入本项目时，交付前保留相应版权与许可声明，
  并重新核对上游版本与实际差异；未获用户要求不对上游仓库做写操作。
- `acp-kernel` 的依赖实体按项目运行时依赖规则放 `runtime/`，不进插件源码目录的实体依赖树；
  已按上表落地（源码包 dependencies 声明 `0.0.98`，实体在 runtime 区，目录联接经
  prepare-runtime 脚本建联并探测）。升级版本时重新核验许可证与 API 差异。
- 上游固定提交是唯一对照基准：进入版本对照或集成评估时按固定提交重新取得副本，
  同步更新本表与 `reference/` 侧登记，不跟随浮动分支。

## 已发生的提取（实质性代码并入）

### 工单 04：Codex owner / checkpoint 核心 / 能力预检（2026-10-17）

从 `@narumitw/pi-codex-compact` 0.56.1（固定提交 `f1d7498`，MIT）提取进
`modules/compression/codex/`，逐文件对应与适配说明见
[docs/研发推进/pi-compression/codex-owner与checkpoint核心.md](../../../../../docs/研发推进/pi-compression/codex-owner与checkpoint核心.md)：

| 本仓文件 | 上游来源（`packages/pi-codex-compact/src/`） | 提取内容与主要适配 |
|---|---|---|
| `codex/protocol.ts` | `protocol.ts` | opaque item 校验、marker 改写、compaction_trigger 追加；SSE 收集归工单 05/06 |
| `codex/profiles.ts` | `model-api.ts` | API→profile 推导与一致性；全局资格判断不进入（白名单先行） |
| `codex/checkpoint.ts` | `checkpoint.ts` | 创建/解析/指纹/marker/replacement history/消息级投影；kind 换本仓标识 v1 |
| `codex/checkpoint-projection.ts` | `checkpoint-projection.ts` | `buildSessionProjection` 缺席，改用 `buildContextEntries` 同口径推导 |
| `codex/remote.ts` | `remote.ts` + `remote-types.ts` | 协议接缝改成可注入 adapter 表；类型从 pi-coding-agent 公开导出推导 |
| `codex/preflight.ts` | `model-api.ts`（资格判断部分） | 规格口径的确定性预检；适配器缺席也是失败 |
| `codex/owner.ts` | `codex-compact.ts` | 主干保留；白名单资格、失败回退按规格保守实现；recovery/continuation/拒绝路由归后续工单 |

- 上游 MIT 许可文本保留在参考副本内（`reference/Pi生态/pi-codex-compact/source/`）；
  本仓提取代码在工单 04 起作为项目自有实现维护，后续对齐上游时以固定提交 diff 对照。
- 上游 `test/checkpoint*.test.ts`、`compaction-ownership.test.ts`、`model-api.test.ts` 的
  用例思路被 `tests/pi-toolkit/compression-codex.test.ts` 吸收（fake transport、指纹校验、
  身份不兼容、claim 保护）。

### 工单 05：Codex Remote V2 / 拒绝路由 / 摘要恢复（2026-10-17）

从 `@narumitw/pi-codex-compact` 0.56.1（固定提交 `f1d7498`，MIT）提取进
`modules/compression/codex/`，逐文件对应与适配说明见
[docs/研发推进/pi-compression/codex-remote-v2.md](../../../../../docs/研发推进/pi-compression/codex-remote-v2.md)：

| 本仓文件 | 上游来源（`packages/pi-codex-compact/src/`） | 提取内容与主要适配 |
|---|---|---|
| `codex/remote-v2.ts` | `remote-v2.ts` + `protocol.ts`（SSE 收集） | Remote V2 适配器（provider.stream + onPayload 展开 + fetch 边界 tee 收集「恰好一个」item）；上游 codex-compact.ts 的 fetch 边界拒绝观察折进适配器 |
| `codex/remote-shared.ts` | `remote-shared.ts` + `remote-types.ts` | usage 收集 / payload 校验 / SSE 预算；Pi 1.3.0 起直接用官方 `normalizeContext` 折 TranscriptContext（providerTranscriptContext） |
| `codex/compaction-failure.ts` | `compaction-failure.ts` + `terminal.ts` | OAuth 操作拒绝识别与有界观察；新增带标签错误类（owner 专用文案用）；redact/通知措辞未提取 |
| `codex/rejection-state.ts` | `rejection-state.ts` | 拒绝路由键（身份改白名单字段）与暂停状态机（容量/观察语义原样） |
| `codex/checkpoint-recovery.ts` | `checkpoint-recovery.ts` | opaque checkpoint → 明文续接摘要的推理请求；终端观察从 onProviderStreamEvent 移到 fetch 边界（依赖版本无该回调） |

- 上游 `test/remote.test.ts`、`rejection-recovery.test.ts`、`checkpoint-recovery.test.ts`
  的用例思路被 `tests/pi-toolkit/compression-codex-remote-v2.test.ts` 吸收（fake
  provider / fake relay SSE、拒绝暂停矩阵、恢复的终端冲突与资源释放）。
### 工单 07：Context Management adapter（2026-10-17）

从同一固定提交 `f1d7498` 的 `context-management.ts`、`remote-context-management.ts` 与
相关测试提取协议形状，改为本仓 `CodexRemoteCompactionAdapter` 接缝；实现位于
`modules/compression/codex/context-management.ts` 与
`modules/compression/codex/remote-context-management.ts`：

| 本仓文件 | 上游来源 | 提取内容与主要适配 |
|---|---|---|
| `codex/context-management.ts` | `src/context-management.ts` | maintenance 文案、checkpoint-first history 校验、encrypted reasoning 校验与有序 SSE collector；错误收敛为本仓 `ContextManagementProtocolError` |
| `codex/remote-context-management.ts` | `src/remote-context-management.ts` | `onPayload` 维护字段、prior checkpoint 展开、Context Management SSE 请求与 fetch 注入；适配当前 Pi provider 接缝，并通过 fetch tee 兼容没有 raw event callback 的 Pi 版本 |
| `tests/pi-toolkit/compression-codex-context-management.test.ts` | `test/context-management*.test.ts` | fake relay 的成功、能力不足、非法 checkpoint、非法 reasoning、取消、模型切换与协议隔离矩阵 |

上游 Context Management 的 MIT 许可和版权文本继续由本表登记的固定参考副本承载；本仓
实现没有引入新的运行时依赖。工单 07 只导出 adapter 工厂，不改 `mod.ts` 的装配表，由
协调者在集成阶段显式注入。
### 工单 06：Codex responses/compact 协议适配器（2026-10-17）

从 `@narumitw/pi-codex-compact` 0.56.1（固定提交 `f1d7498`，MIT）提取
`packages/pi-codex-compact/src/remote-compact.ts`（含其依赖的 `remote-types.ts` /
`remote-shared.ts` 相关导出）进 `modules/compression/codex/remote-compact.ts`：

| 本仓内容 | 上游来源 | 提取内容与主要适配 |
|---|---|---|
| `responsesCompactUrl` | `remote-compact.ts` | 同源 compact endpoint 推导（`/responses` → `/responses/compact`，origin 不漂移） |
| `compactPayload` | `remote-compact.ts` | 请求字段按 profile 过滤（codex-responses-v1 / openai-responses-v1 字段表），不支持字段不静默发送 |
| `validatedUsage` / `validatedCompactOutput` | `protocol.ts`（`validateCompactedResponse` 部分） | JSON 响应（非 SSE）的 usage 与「恰好一个 compaction item」校验；SSE 收集不在本工单 |
| `createResponsesCompactAdapter` | `remote-compact.ts`（`requestResponsesCompact`） | 适配到工单 04 的 `CodexRemoteCompactionAdapter` 接缝（注入 protocolAdapters 表）；成功结果交给 owner 的 checkpoint 核心 |

- Pi 1.3.0 起与上游同源：压缩请求上下文经 remote-shared.ts 的官方 `normalizeContext`
  折成 TranscriptContext 后再交 `provider.stream`（上游接缝一致）。
- 上游用 `collectCompactResponse` 读 JSON body 再合成 SSE；本仓同款（`readJsonObject` +
  合成 SSE），provider 从 done 事件取 usage。
- 上游 `test/remote-compact.test.ts` 的 fixture（成功 / 错误响应 / 非法 usage / 多结果 /
  取消）被 `tests/pi-toolkit/compression-codex-remote-compact.test.ts` 吸收（fake relay +
  fake provider，零真实网络）。
- 适配器的三语诊断复用 `module.compression.codex.*` 既有键（prepare.failed / outcome.
  * / checkpoint.*），本工单不新增三语键。
