// 压缩模块实现入口（工单 01 骨架 + 02 策略解析 + 03 统一压缩调度器 + 04 Codex owner + 08 ACP owner + 09 解压/搜索/恢复）。
//
// 装配职责：
// - 解析本模块配置节，配置问题经会话启动提示逐项呈现（工单 01 口径不变）；
// - 注册统一压缩调度器的 session_before_compact handler（工单 03 起模块内唯一的
//   压缩 owner 入口）：压缩准备开始时按当前模型解析策略——native/auto 全部交回
//   Pi，native/manual 只放行手动 /compact、取消 threshold/overflow 自动压缩；
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
//     搜索执行入口（会话未命中 ACP 时返回引导文本）。
//   native-only 配置（无任何 ACP 可能性）不注册 ACP 的 context / session_shutdown /
//   上述工具，不产生任何第三方上下文修改（工单 03 锁定口径不变）。
//
// 呈现口径：装配失败由装配器收进 toolkit.problems；本模块配置节的字段级问题在
// session_start 的 ctx.ui.notify 呈现（与 peers 的 init 诊断同款路径），同一份问题
// 只提示一次，配置修好后再引入新问题才会再次提示；压缩调度的运行期诊断（取消、
// owner 未实现、内部异常、Codex 各阶段失败）由调度器与 owner 自己在事件现场
// 呈现并去重；ACP 侧诊断（接管、sidecar 重建/损坏/版本不兼容、投影失败）由
// 引擎/owner 在事件现场经 ui.notify 呈现，mod.ts 按诊断键去重（同一情形每会话
// 提示一次，新会话清空）。
//
// 事件契约注：本仓编译目标（pi-coding-agent 0.85.x）没有 context_with_system
// 事件；规格里的「context_with_system 阶段」按实际 `context` 事件适配（工单 04/08
// 口径，宿主 1.3.0 的 context_with_system 属后续升级时再评估的接缝）。

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModuleContext } from "../../kit/module.ts";
import { createCodexOwnerModule } from "./codex/owner.ts";
import { createRemoteV2CompactionAdapter } from "./codex/remote-v2.ts";
import { createResponsesCompactAdapter } from "./codex/remote-compact.ts";
import { createContextManagementAdapter } from "./codex/remote-context-management.ts";
import { readCompressionSettings } from "./config.ts";
import { createAcpEngine } from "./acp/engine.ts";
import { createAcpOwner } from "./acp/owner.ts";
import { readAcpSidecarBlockCount } from "./acp/sidecar.ts";
import { makeAcpCompressTool } from "./acp/compress-tool.ts";
import { makeAcpDecompressTool } from "./acp/decompress-tool.ts";
import { makeAcpSearchTool } from "./acp/search-tool.ts";
import { formatCompressionProblem } from "./messages/index.ts";
import { createCompressionScheduler } from "./scheduler.ts";
import { modelIdentityFromModel } from "./rules-editor.ts";
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
  if (!ctx.model) return false;
  const { settings } = readCompressionSettings(context.getConfig());
  return resolveCompressionStrategy(modelIdentityFromModel(ctx.model), settings).mode === "acp";
}

export function registerCompression(context: ModuleContext): void {
  const acpPossible = acpPossibleInSettings(context.getConfig());

  // ACP 诊断通道：引擎在事件现场产出（带 ctx），这里按键去重后 ui.notify；
  // 新会话（session_start / session_shutdown）清空
  const acpDiagSeen = new Set<string>();

  const engine = acpPossible
    ? createAcpEngine({
        t: context.t,
        diagnostics: (key, level, message, ctx) => {
          if (acpDiagSeen.has(key)) return;
          acpDiagSeen.add(key);
          if (ctx.hasUI) ctx.ui.notify(message, level);
        },
        // 工单 10：ACP 高级配置实时读取口（级联合并在 acp/config.ts 的接缝里做）
        readAcpSettings: () => readCompressionSettings(context.getConfig()).settings.acp,
      })
    : undefined;

  const acpOwnerBundle = engine ? createAcpOwner({ engine, t: context.t }) : undefined;

  // Codex owner：三条远程协议适配器接线（工单 05 Remote V2 / 06 responses-compact /
  // 07 Context Management）；owner 内部仍按白名单与 preflight 门控，未命中模型零行为
  const codexOwner = createCodexOwnerModule({
    t: context.t,
    getConfig: () => context.getConfig(),
    protocolAdapters: {
      "remote-v2": createRemoteV2CompactionAdapter(),
      "responses-compact": createResponsesCompactAdapter(),
      "context-management": createContextManagementAdapter(),
    },
    pi: context.pi,
  });

  // 统一压缩调度器：一个模块实例一个调度器（诊断去重与状态行随实例走）；
  // Codex 与 ACP owner 并列注入（模型身份互斥，命中哪个走哪个；native 内建不可覆盖）。
  // ACP 私有状态探测（工单 11 跨模式切换保护）：内存槽（engine 在装）优先，
  // 磁盘 sidecar 兜底（配置已无 ACP 可能性时 engine 缺席也能探测）；探测异常
  // 按无状态处理，不阻断压缩决策
  const scheduler = createCompressionScheduler({
    t: context.t,
    getConfig: () => context.getConfig(),
    owners: acpOwnerBundle ? [codexOwner, acpOwnerBundle.owner] : [codexOwner],
    acpStateProbe: async (ctx: ExtensionContext) => {
      try {
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
    // beginSession 内含生命周期边界的策略重新解析诊断（工单 11：resume / fork /
    // 宿主重载都以 session_start 到达，noteworthy 的解析给一行 info）
    scheduler.beginSession(ctx);
    codexOwner.beginSession(ctx);
    acpOwnerBundle?.beginSession(ctx);
    acpDiagSeen.clear();
    if (engine) {
      try {
        await engine.beginSession(ctx);
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

  // 唯一的压缩事件入口：session_before_compact（调度器内部分发给 native 或
  // 已注入的 owner；ACP 可能性不存在时不注册任何 ACP 上下文事件）
  context.pi.on("session_before_compact", (event, ctx) => scheduler.handleBeforeCompact(event, ctx));

  // 投影接缝：Codex 与 ACP 互斥分发（同一模型只会命中一种模式，命中方改写，
  // 另一方原样放行）。Codex 侧：checkpoint marker → 请求视图 / replacement
  // history，未命中 codex 白名单的模型（含同 provider 的 openai-responses 标记）零行为。
  context.pi.on("context", async (event, ctx) => {
    if (sessionResolvesAcp(context, ctx)) {
      if (!engine) return undefined;
      try {
        return await engine.handleContext(event, ctx, true);
      } catch {
        // 引擎内部已兜异常并进诊断；这里再兜一层保证不改写视图
        return undefined;
      }
    }
    return codexOwner.handleContext(event, ctx);
  });
  context.pi.on("before_provider_request", (event, ctx) =>
    codexOwner.handleBeforeProviderRequest(event, ctx),
  );

  if (engine) {
    // 会话结束：释放 ACP 运行态（sidecar 落盘保留）
    context.pi.on("session_shutdown", (_event, ctx) => {
      engine.endSession(ctx);
      acpDiagSeen.clear();
    });

    // 压缩/解压/搜索执行入口（模型驱动）：会话未命中 ACP 时返回引导文本不执行；
    // compress 的提示面（prompt pack / 提示词覆写）在注册期按全局级 ACP 配置解析
    context.pi.registerTool(
      makeAcpCompressTool({
        engine,
        t: context.t,
        isSessionActive: (ctx) => sessionResolvesAcp(context, ctx),
        readAcpSettings: () => readCompressionSettings(context.getConfig()).settings.acp,
      }),
    );
    context.pi.registerTool(
      makeAcpDecompressTool({
        engine,
        t: context.t,
        isSessionActive: (ctx) => sessionResolvesAcp(context, ctx),
      }),
    );
    context.pi.registerTool(
      makeAcpSearchTool({
        engine,
        t: context.t,
        isSessionActive: (ctx) => sessionResolvesAcp(context, ctx),
      }),
    );
  }
}
