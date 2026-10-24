// 压缩模块实现入口（工单 01 骨架 + 02 策略解析 + 03 统一压缩调度器 + 04 Codex owner + 08 ACP owner + 09 解压/搜索/恢复）。
//
// 装配职责：
// - 解析本模块配置节，配置问题经会话启动提示逐项呈现（工单 01 口径不变）；
// - 注册统一压缩调度器的 session_before_compact handler（工单 03 起模块内唯一的
//   压缩 owner 入口）：压缩准备开始时按当前模型解析策略——native 全部交回
//   Pi，Codex / ACP 由对应 owner 接管；
// - 工单 04 起 Codex owner 注入调度器（owners）：白名单命中的模型由
//   owner 按 resolve→preflight→prepare→commit→event result→projection→
//   finalize 状态机处置；同时注册 owner 自己的投影接缝（context /
//   before_provider_request）——只在当前模型命中 codex 白名单且存在兼容
//   checkpoint 时才修改请求视图，未命中模型零行为；三条远程协议适配器
//   （Remote V2 / responses/compact / Context Management，工单 05/06/07）
//   已全部接线注入，preflight 阶段仍会在任何远程请求之前拦截「协议不可用」
//   等确定性失败，按 onUnsupported 策略回退或报错；
// - 配置里存在 ACP 可能性（显式 acp 规则或 acpAutoDetect 开启）时，装配工单 08
//   的 ACP owner 并注入调度器 owners：ACP 命中的会话由 owner 接管（自动与手动
//   压缩一律取消，压缩经 context 投影 + compress 工具管理）；同时注册
//   - context handler：ACP 命中当前模型时生成 ACP 请求视图（引用标签 + 块剪枝
//     + 最小 nudge），未命中时原样放行；
//   - session_shutdown handler：释放 ACP 运行态（sidecar 落盘保留）；
//   - compress / decompress / search_context 工具：模型驱动的压缩、解压与
//     搜索执行入口（工单 01：注册期无条件注册，引擎经 Lazy 代理按需创建；
//     模块关闭或会话未命中 ACP 时返回标准拒绝结果）。
//   native-only 配置（无任何 ACP 可能性）不会创建 ACP 引擎，不产生任何第三方
//   上下文修改（工单 03 锁定口径不变）；唯一例外是当前会话覆盖选了 ACP（工单 05），
//   那时引擎按需创建，否则覆盖只是显示层的假动作。
//
// 常驻壳口径（工单 01）：模块声明 alwaysAssemble，关闭时 register 照常执行，
// 但所有运行期接缝先读 enabled 再决定是否旁路——scheduler 取消调度、context 与
// before_provider_request 原样放行，Pi 原生压缩照常可用；关闭态下探测到活动私态
// （Codex checkpoint / ACP sidecar）时由调度器的关闭态接缝最小安全处置。
//
// 跨模式保护与 fallback 清除总线（工单 06）：
// - 三路成功接缝共用一条幂等清除总线（fallback.ts）：Pi session_compact 原生压缩
//   成功（status.ts 的 noteCompaction）、Codex owner 进入 finalize、ACP compress
//   工具建块且 sidecar 原子落盘完成；重复清除不递增 revision；
// - 降级记录只有两个写方：Codex owner 的运行期资格复核（模型声明官方地址、auth
//   实际指向中转时不接管）与 ACP owner 的宿主接缝缺失回退；model_select 与
//   session_start / session_shutdown 复位降级记录（它们不代替会话覆盖的复位）；
// - session_shutdown 只要本会话生命周期内创建过引擎，就把「内存里有、磁盘上没有」
//   的私态补写落盘再释放（与当前模式无关：关闭模块、切到 codex、覆盖切走都在内）。
//
// 状态段口径（工单 04）：装配期向服务注册表注册 `compression.status` 只读句柄
// （启用与关闭态都注册），tui 状态栏从它取压缩标签与变更序号；快照是派生结果，
// session_start / model_select 只更新会话模型身份，session_compact 只分离原生与
// 扩展压缩两条记账路径。
//
// 呈现口径：装配失败由装配器收进 toolkit.problems；本模块配置节的字段级问题在
// session_start 的 ctx.ui.notify 呈现（与 peers 的 init 诊断同款路径），同一份问题
// 只提示一次，配置修好后再引入新问题才会再次提示；压缩调度的运行期诊断（取消、
// owner 未实现、内部异常、Codex 各阶段失败）由调度器与 owner 自己在事件现场
// 呈现并去重；ACP 侧诊断（接管、sidecar 重建/损坏/版本不兼容、投影失败）由
// 引擎/owner 在事件现场经 ui.notify 呈现，mod.ts 按诊断键去重（同一情形每会话
// 提示一次，新会话清空）。工单 11 起 ACP 的压缩 / 恢复状态优先走扩展消息
// （display 接缝：对话编辑框上方的 custom 条目，不进模型上下文）：扩展消息接缝
// 就位的会话里，接管 / 失败 / 受保护反馈与 sidecar 恢复类内部诊断不再逐条进
// 对话通知，也不写状态栏常驻提示；无接缝的宿主保持原去重通知 + 状态栏兜底。
//
// 事件契约注：Pi 1.3.0 提供 context_with_system（可改 system prompt），本模块刻意
// 只注册 `context`——压缩只改 conversation messages，不动 system prompt 与工具
// 声明（工单 04/08 口径）；规格里的「context_with_system 阶段」按 `context` 事件
// 适配。若后续需要改 system 面，按单向升级流程重新评估，不做运行期探测。

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ENABLED_FIELD, type ModuleContext } from "../../kit/module.ts";
import { COMPRESSION_STATUS_SERVICE_NAME, type CompressionMode, type ModelIdentity } from "./api.ts";
import { createCodexOwnerModule } from "./codex/owner.ts";
import { createRemoteV2CompactionAdapter } from "./codex/remote-v2.ts";
import { createResponsesCompactAdapter } from "./codex/remote-compact.ts";
import { createContextManagementAdapter } from "./codex/remote-context-management.ts";
import { readCompressionSettings } from "./config.ts";
import { createCompressionFallbackLedger } from "./fallback.ts";
import { createAcpEngine, type AcpCompressionEngine } from "./acp/engine.ts";
import { createAcpOwner } from "./acp/owner.ts";
import {
  COMPRESSION_DISPLAY_ENTRY_TYPE,
  createDisplayPresentation,
  createDisplayReporter,
  type CompressionDisplayEntryData,
  type CompressionDisplayReporter,
} from "./display.ts";
import { readAcpSidecarBlockCount } from "./acp/sidecar.ts";
import { makeAcpCompressTool } from "./acp/compress-tool.ts";
import { makeAcpDecompressTool } from "./acp/decompress-tool.ts";
import { makeAcpSearchTool } from "./acp/search-tool.ts";
import { formatCompressionProblem } from "./messages/index.ts";
import { createCompressionScheduler } from "./scheduler.ts";
import { modelIdentityFromModel } from "./rules-editor.ts";
import { sessionCompressionOverride } from "./session-override.ts";
import { createCompressionStatusService } from "./status.ts";
import { resolveCompressionStrategy } from "./strategy.ts";

/** 当前配置下是否存在 ACP 可能性（显式规则、自动检测开关或默认模式即 acp） */
function acpPossibleInSettings(section: unknown): boolean {
  const { settings } = readCompressionSettings(section);
  return (
    settings.defaultMode === "acp" || settings.acpAutoDetect || settings.modelRules.some((rule) => rule.mode === "acp")
  );
}

/** 当前会话模型是否命中 ACP 策略（context 投影与 compress 工具的每次调用判定） */
function sessionResolvesAcp(context: ModuleContext, ctx: ExtensionContext): boolean {
  return resolveModeFor(context, ctx.model) === "acp";
}

/** 模型身份 → 当前配置下的压缩模式（无模型时 undefined；展示收束判定共用） */
function resolveModeFor(context: ModuleContext, model: ExtensionContext["model"]): CompressionMode | undefined {
  if (!model) return undefined;
  const { settings } = readCompressionSettings(context.getConfig());
  return resolveCompressionStrategy(modelIdentityFromModel(model), settings, sessionCompressionOverride.get()).mode;
}

export function registerCompression(context: ModuleContext): void {
  // 工单 05：宿主重置（reload 重新装配扩展）也是会话边界，重新装配即复位会话覆盖，
  // 上一个会话的内存选择不得被新装配沿用
  sessionCompressionOverride.reset();
  /** 模块总开关（实时读配置：设置页可在会话中途打开/关闭） */
  const compressionEnabled = (): boolean => context.getConfig()[ENABLED_FIELD] !== false;

  /** 本会话是否走 ACP：模块启用且当前模型命中 ACP 策略——工具的 ACP 可用性判定 */
  const acpActive = (ctx: ExtensionContext): boolean => compressionEnabled() && sessionResolvesAcp(context, ctx);

  /** 当前会话模型身份（session_start / model_select 更新，session_shutdown 清空） */
  let sessionModel: ModelIdentity | undefined;

  // 降级记账（工单 06）：状态服务的读口、Codex owner 与 ACP owner / 工具的写口
  // 共用同一份记录，接口只有「记一次」「幂等清除」「边界复位」（fallback.ts）
  const fallbackLedger = createCompressionFallbackLedger();

  // 压缩状态服务（工单 04）：tui 状态段从 compression.status 句柄读标签与变更序号。
  // 关闭态同样注册（alwaysAssemble 下 register 照常执行），快照如实报 disabled。
  // 快照是派生结果（status.ts）：revision 在读快照时按内容比较维护，所以下面的
  // 事件接线只需把新模型交给派生口，下一次读（tui 心跳/渲染）就得到新内容与新序号。
  const statusService = createCompressionStatusService({
    isEnabled: compressionEnabled,
    readSettings: () => readCompressionSettings(context.getConfig()).settings,
    readModel: () => sessionModel,
    // 工单 05：快照的来源与生效模式跟面板、策略解析同源（内存覆盖也参与解析）
    readSessionOverride: () => sessionCompressionOverride.get(),
    // 工单 06：降级标记（运行期复核不通过等）经总线读写，三路成功接缝统一清除
    readFallback: () => fallbackLedger.read(),
    clearFallback: () => fallbackLedger.clear(),
  });
  context.services.register(COMPRESSION_STATUS_SERVICE_NAME, statusService);

  // ACP 诊断通道：引擎在事件现场产出（带 ctx），这里按键去重后 ui.notify；
  // 新会话（session_start / session_shutdown）清空。
  // 工单 11：sidecar / 恢复类内部诊断不逐条进对话——有扩展消息接缝的会话里，
  // 恢复生命周期（recovering / recovery-succeeded / recovery-failed）承载用户可见
  // 状态；sidecar-config-generation 是纯内部信息（配置代际变化，无需用户行动），
  // 直接静默。projection-unavailable 与恢复失败同根因（状态缺席），由恢复失败
  // 消息覆盖不重复告知。无扩展消息接缝的会话保持原去重通知兜底
  const acpDiagSeen = new Set<string>();
  const RECOVERY_ROUTED_DIAGNOSTICS = new Set([
    "sidecar-mismatch",
    "sidecar-corrupt",
    "sidecar-newer",
    "sidecar-rebuilt",
    "sidecar-rebuild-failed",
    "sidecar-config-generation",
    "projection-unavailable",
  ]);

  // 展示 owner 仲裁与扩展消息接缝（工单 08）：展示 owner 与压缩 owner 同源（同一
  // 套五级优先级，由策略解析推出），扩展压缩状态用不进模型上下文的 custom 条目承载。
  // 渲染器注册一次（只显示同一展示 owner 的最新条目，旧条目保留用于恢复与审计）。
  const displayPresentation = createDisplayPresentation();
  displayPresentation.registerRenderer(context.pi, context.t);
  // 展示上报接缝（owner / compress 工具消费）：把状态推进经 controller 转成宿主
  // custom 条目（plain custom 被 sessionEntryToContextMessages 忽略，不进模型上下文）。
  // appendCustomEntry 需 sessionManager，按 ctx 惰性构造；无 UI 或缺接缝时不展示。
  function displayFor(ctx: ExtensionContext): CompressionDisplayReporter | undefined {
    if (!ctx.hasUI) return undefined;
    const sessionManager = ctx.sessionManager as {
      appendCustomEntry?: (customType: string, data?: unknown) => string;
    };
    if (typeof sessionManager.appendCustomEntry !== "function") return undefined;
    return createDisplayReporter(
      displayPresentation,
      (data: CompressionDisplayEntryData) => sessionManager.appendCustomEntry!(COMPRESSION_DISPLAY_ENTRY_TYPE, data),
    );
  }

  // Lazy engine 代理（工单 01）：关闭或配置已无 ACP 可能性时不创建引擎（彻底旁路，
  // 不读不写 sidecar）；启用且存在 ACP 可能性时在装配期创建一次（保持既有 ACP 会话
  // 行为），之后由 ACP 接管、context 投影与三个工具共用同一个实例
  let engine: AcpCompressionEngine | undefined;
  const engineFor = (): AcpCompressionEngine | undefined => {
    if (engine) return engine;
    if (!compressionEnabled()) return undefined;
    // 工单 05：会话覆盖选 ACP 时，即便全局配置里没有 ACP 可能性也要能建引擎——
    // 否则覆盖只是显示层假动作，面板/状态说是 ACP 而压缩实际走 native
    if (!acpPossibleInSettings(context.getConfig()) && sessionCompressionOverride.get() !== "acp") {
      return undefined;
    }
    engine = createAcpEngine({
      t: context.t,
      diagnostics: (key, level, message, ctx) => {
        // 工单 11：恢复类内部诊断不逐条进对话（扩展消息承载；无接缝时兜底通知）
        if (displayFor(ctx) && RECOVERY_ROUTED_DIAGNOSTICS.has(key)) return;
        if (acpDiagSeen.has(key)) return;
        acpDiagSeen.add(key);
        if (ctx.hasUI) ctx.ui.notify(message, level);
      },
      // 工单 11：sidecar 恢复生命周期 → 扩展消息（恢复中 / 恢复成功 / 恢复失败）
      recoveryEvents: (event, ctx) => {
        const display = displayFor(ctx);
        if (!display) return;
        if (event.kind === "recovering") display.recovering("acp");
        else if (event.kind === "recovered") display.recoverSucceed("acp");
        else display.recoverFail("acp", event.reason);
      },
      // 工单 10：ACP 高级配置实时读取口（级联合并在 acp/config.ts 的接缝里做）
      readAcpSettings: () => readCompressionSettings(context.getConfig()).settings.acp,
    });
    return engine;
  };
  // 启用且配置有 ACP 可能性时按注册期一次解析创建（保持既有 ACP 会话行为）
  engineFor();

  // ACP owner 常驻注入：引擎经 Lazy 代理取用，模块中途被打开时也能接管
  const acpOwnerBundle = createAcpOwner({
    engine: () => engineFor(),
    t: context.t,
    // 工单 06：ACP 无法投影而回退 Pi 原生时记降级（来源 acp + 机读原因）
    fallback: fallbackLedger,
    // 工单 08：展示上报接缝（扩展消息生命周期推进）
    display: displayFor,
  });

  // Codex owner：三条远程协议适配器接线（工单 05 Remote V2 / 06 responses-compact /
  // 07 Context Management）；owner 内部仍按白名单与 preflight 门控，未命中模型零行为
  const codexOwner = createCodexOwnerModule({
    t: context.t,
    getConfig: () => context.getConfig(),
    readSessionOverride: () => sessionCompressionOverride.get(),
    // 工单 06：接管前运行期复核不通过时记降级，finalize 成功时清除（同一个总线）
    fallback: fallbackLedger,
    protocolAdapters: {
      "remote-v2": createRemoteV2CompactionAdapter(),
      "responses-compact": createResponsesCompactAdapter(),
      "context-management": createContextManagementAdapter(),
    },
    pi: context.pi,
    // 工单 08：展示上报接缝（扩展消息生命周期推进）
    display: displayFor,
  });

  // 统一压缩调度器：一个模块实例一个调度器（诊断去重与状态行随实例走）；
  // Codex 与 ACP owner 并列注入（模型身份互斥，命中哪个走哪个；native 内建不可覆盖）。
  // ACP 私有状态探测（工单 11 跨模式切换保护）：内存槽（engine 在装）优先，
  // 磁盘 sidecar 兜底（配置已无 ACP 可能性时 engine 缺席也能探测）；探测异常
  // 按无状态处理，不阻断压缩决策
  const scheduler = createCompressionScheduler({
    t: context.t,
    getConfig: () => context.getConfig(),
    owners: [codexOwner, acpOwnerBundle.owner],
    readSessionOverride: () => sessionCompressionOverride.get(),
    acpStateProbe: async (ctx: ExtensionContext) => {
      try {
        // 只看已存在的引擎：探测不得创建引擎（工单 01 旁路口径）
        const inMemory = engine?.currentState(ctx);
        if (inMemory && inMemory.blocks.length > 0) return { blocks: inMemory.blocks.length };
        const sessionManager = ctx.sessionManager as { getSessionFile?: () => string | undefined };
        const sessionFile =
          typeof sessionManager.getSessionFile === "function" ? sessionManager.getSessionFile() : undefined;
        const blocks = await readAcpSidecarBlockCount(sessionFile ?? undefined);
        return blocks === undefined ? undefined : { blocks };
      } catch {
        return undefined;
      }
    },
  });

  // 已提示过的问题集合指纹：session_start 每个会话都会走，重复内容不重复提示；
  // 配置修复（问题消失）后指纹清空，之后新出现的问题会再次提示
  let reportedSignature: string | undefined;

  context.pi.on("session_start", async (_event, ctx) => {
    // 新会话开始：清空上一会话的调度诊断去重与状态行残留；绑定 ACP 运行态。
    // 工单 05：会话切换与新会话也以 session_start 到达，会话覆盖在此复位
    sessionCompressionOverride.reset();
    // 工单 06：降级记录不跨会话（复位降级，不动下面已复位的会话覆盖语义）
    fallbackLedger.reset();
    sessionModel = ctx.model ? modelIdentityFromModel(ctx.model) : undefined;
    scheduler.beginSession(ctx);
    codexOwner.beginSession(ctx);
    acpOwnerBundle.beginSession(ctx);
    acpDiagSeen.clear();
    // 工单 08：展示状态恢复——从会话分支重建展示 controller，把陈旧的进行中条目
    // 解释为过期（追加一条过期条目收束，不重放「正在压缩」）；已收束状态只读取不追加
    try {
      const expired = displayPresentation.controller.restore(ctx.sessionManager.getBranch());
      if (expired !== undefined) {
        const sessionManager = ctx.sessionManager as {
          appendCustomEntry?: (customType: string, data?: unknown) => string;
        };
        const id = sessionManager.appendCustomEntry?.(COMPRESSION_DISPLAY_ENTRY_TYPE, expired);
        if (id !== undefined) displayPresentation.markVisibleEntry(id);
      }
    } catch {
      // 恢复异常不击穿会话启动（展示是旁路能力）
    }
    const currentEngine = engineFor();
    if (currentEngine) {
      try {
        await currentEngine.beginSession(ctx);
      } catch {
        // sidecar 装载失败已由引擎诊断呈现；装配路径不允许抛出
      }
    }
    if (!ctx.hasUI) return;
    const { problems } = readCompressionSettings(context.getConfig());
    if (problems.length === 0) {
      reportedSignature = undefined;
      return;
    }
    const signature = JSON.stringify(problems);
    if (signature === reportedSignature) return;
    reportedSignature = signature;
    for (const problem of problems) {
      ctx.ui.notify(formatCompressionProblem(problem, context.t), "warning");
    }
  });

  // 模型切换：只重新解析策略（快照按当前模型 + 实时配置派生），不清除会话覆盖——
  // 工单 05 的会话内存覆盖叠在策略解析之上，切换模型不该把它复位。
  // 工单 06：降级结论绑定的是旧模型的能力复核结果，模型切换即复位降级记录
  context.pi.on("model_select", (event, ctx) => {
    if (event.model) sessionModel = modelIdentityFromModel(event.model);
    fallbackLedger.reset();
    // 工单 11：模型切换即时收束（不等下一次压缩事件）：新模型不再解析为展示
    // 进行中的压缩模式时，旧 owner 的进行中扩展消息立即收束（不留「正在压缩」）；
    // 已有 ACP sidecar 的跨模式保护仍由调度器的私态探测负责（收束展示不改变
    // 压缩决策）。规则 / 覆盖 / 总开关等无独立事件的切换由 session_before_compact
    // 边界收束兜底
    const current = displayPresentation.controller.current;
    if (current?.state === "in-progress") {
      const nextMode = resolveModeFor(context, event.model);
      // 工单 12：模块已关闭时扩展 owner 整体退场（无压缩执行权也无展示权），
      // 同模式模型切换也不再悬挂进行中消息——策略解析不看总开关，仅靠模式比较
      // 会漏掉关闭态（展示归属串线）
      if (!compressionEnabled() || (nextMode !== undefined && nextMode !== current.mode)) {
        displayFor(ctx)?.conclude(current.mode);
      }
    }
  });

  // 压缩成功（工单 04 的 native 记账接缝）：只有 Pi 原生压缩算进 native 状态；
  // fromExtension 的扩展压缩是 Codex/ACP owner 自己提交的结果，不改 native 状态。
  // 工单 06 的三路 clearFallback 总线接在同一条接缝上。
  context.pi.on("session_compact", (event) => {
    statusService.noteCompaction({ fromExtension: event.fromExtension });
  });

  // 唯一的压缩事件入口：session_before_compact（调度器内部分发给 native 或
  // 已注入的 owner；模块关闭时由调度器的关闭态接缝旁路）。
  // 工单 11：事件边界收束陈旧展示——上次展示进行中的模式已不是当前解析模式
  // （模型切换 / 规则变更 / 会话覆盖切换都可能造成且未必有独立事件），旧 owner
  // 的进行中消息不得遗留「正在压缩」；新 owner 的生命周期随后自行开启
  context.pi.on("session_before_compact", async (event, ctx) => {
    const stale = displayPresentation.controller.current;
    if (stale?.state === "in-progress") {
      const mode = resolveModeFor(context, ctx.model);
      // 工单 12：总开关关闭同样在此收束——resolveModeFor 不看总开关（仍按规则 /
      // 覆盖解析出原模式），仅靠模式比较会漏掉关闭态：进行中消息将与 Pi 原生
      // 压缩（无私态时放行）或保护取消并存
      if (!compressionEnabled() || (mode !== undefined && mode !== stale.mode)) {
        displayFor(ctx)?.conclude(stale.mode);
      }
    }
    return scheduler.handleBeforeCompact(event, ctx);
  });

  // 投影接缝：Codex 与 ACP 互斥分发（同一模型只会命中一种模式，命中方改写，
  // 另一方原样放行）。Codex 侧：checkpoint marker → 请求视图 / replacement
  // history，未命中 codex 白名单的模型（含同 provider 的 openai-responses 标记）零行为。
  // 模块关闭（工单 01）：投影整体旁路，原生视图原样放行。
  context.pi.on("context", async (event, ctx) => {
    if (!compressionEnabled()) return undefined;
    if (sessionResolvesAcp(context, ctx)) {
      const acpEngine = engineFor();
      if (!acpEngine) return undefined;
      try {
        return await acpEngine.handleContext(event, ctx, true);
      } catch {
        // 引擎内部已兜异常并进诊断；这里再兜一层保证不改写视图
        return undefined;
      }
    }
    return codexOwner.handleContext(event, ctx);
  });
  context.pi.on("before_provider_request", (event, ctx) => {
    // 模块关闭（工单 01）：请求改写旁路（专属于 Codex scope）
    if (!compressionEnabled()) return undefined;
    return codexOwner.handleBeforeProviderRequest(event, ctx);
  });

  // 会话结束：释放 ACP 运行态（缺失的 sidecar 先原子补写，再释放内存槽）。引擎从未
  // 创建时是一次空操作；引擎创建过但当前已不是 ACP（关闭模块 / 切到 codex / 覆盖
  // 切走）同样要补写释放——engine 闭包一旦创建就保留到装配结束，`engine?.` 覆盖全部情形。
  // 工单 05：会话边界同时清掉内存里的会话覆盖，不让它跨会话残存
  context.pi.on("session_shutdown", async (_event, ctx) => {
    await engine?.endSession(ctx);
    acpDiagSeen.clear();
    sessionModel = undefined;
    sessionCompressionOverride.reset();
    fallbackLedger.reset();
  });

  // 压缩/解压/搜索执行入口（模型驱动）：注册期无条件注册（工单 01），
  // 运行时经 Lazy engine 代理取用运行态；模块关闭或当前非 ACP 模式被调用时
  // 直接返回标准拒绝结果，不创建引擎。compress 的提示面（prompt pack /
  // 提示词覆写）在注册期按全局级 ACP 配置解析
  context.pi.registerTool(
    makeAcpCompressTool({
      engine: () => engineFor(),
      t: context.t,
      isSessionActive: acpActive,
      readAcpSettings: () => readCompressionSettings(context.getConfig()).settings.acp,
      // 工单 06：ACP 压缩成功且 sidecar 落盘完成 → 清除降级标记（幂等）
      clearFallback: () => fallbackLedger.clear(),
      // 工单 08：ACP 压缩真正成功（建块且 sidecar 落盘）→ 收束扩展进行中消息
      conclude: (ctx) => displayFor(ctx)?.succeed("acp"),
    }),
  );
  context.pi.registerTool(
    makeAcpDecompressTool({
      engine: () => engineFor(),
      t: context.t,
      isSessionActive: acpActive,
    }),
  );
  context.pi.registerTool(
    makeAcpSearchTool({
      engine: () => engineFor(),
      t: context.t,
      isSessionActive: acpActive,
    }),
  );
}
