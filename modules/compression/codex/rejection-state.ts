// Codex 压缩路由的 OAuth 拒绝暂停状态（工单 05 从上游 rejection-state.ts 提取）。
//
// 上游对应：reference/Pi生态/pi-codex-compact/source/src/rejection-state.ts
// （MIT，来源登记见 ../UPSTREAM.md）。提取与适配：
// - 上游 rejectionRouteKey 接收 CompactionRoute（上游自有路由判定产物）；本仓的
//   资格判定由白名单策略解析承担（工单 04），路由身份改为直接取
//   provider/model/api/profile/protocol（+ 可选 baseUrl / 实际观察到的 endpoint），
//   哈希算法与 URL 归一化口径保留上游算法；
// - RejectedRoutes 的容量（128）、observe/hasObserved/add 语义原样保留：已记住的
//   拒绝路由持续跟踪后端变化（包括成功），无关路由不得污染缓存；
// - 状态生命周期：上游按 owner（每会话）持有并随 session_start 重建；本仓由
//   Remote V2 适配器工厂持有（mod.ts 装配时创建，一个模块实例一份），跨压缩
//   请求共享——「本会话内暂停、重载后重试」的语义对压缩请求成立（重载即新模块
//   实例）。

import { createHash } from "node:crypto";
import type { CodexProtocol } from "../api.ts";
import type { ResponsesCompactionProfile } from "./profiles.ts";

/** 路由身份：白名单命中的模型 + 规则协议/profile（可选 baseUrl 与 fetch 边界实际观察到的 endpoint） */
export interface CodexRejectionRouteIdentity {
  readonly provider: string;
  readonly modelId: string;
  readonly api: string;
  readonly profile: ResponsesCompactionProfile;
  readonly protocol: CodexProtocol;
  readonly baseUrl?: string;
  /** fetch 边界观察到的完整 endpoint URL（含 Azure 的 api-version 查询参数） */
  readonly endpoint?: string;
}

// 公开路由字段 + fetch 边界观察到的 endpoint。排除 URL 凭据与查询串秘密；
// 只保留 Azure 的路由性 api-version。
export function codexRejectionRouteKey(identity: CodexRejectionRouteIdentity): string {
  const normalize = (value: string | undefined): (string | null)[] | undefined => {
    if (!value) return undefined;
    try {
      const url = new URL(value);
      return [
        url.origin,
        url.pathname,
        identity.api === "azure-openai-responses" ? url.searchParams.get("api-version") : null,
      ];
    } catch {
      return undefined;
    }
  };
  const backend = normalize(identity.endpoint);
  return createHash("sha256")
    .update(
      JSON.stringify([
        identity.provider,
        identity.modelId,
        identity.api,
        identity.profile,
        identity.protocol,
        normalize(identity.baseUrl),
        backend,
      ]),
    )
    .digest("hex");
}

export class RejectedRoutes {
  private readonly keys = new Set<string>();
  private readonly observed = new Map<string, string>();

  observe(route: string, backend: string): void {
    // 无关的成功路由不得填充拒绝状态缓存；已记住的路由继续跟踪后端变化（含成功）。
    if (this.observed.has(route) || (this.keys.has(backend) && this.observed.size < 128))
      this.observed.set(route, backend);
  }

  hasObserved(route: string): boolean {
    const backend = this.observed.get(route);
    return backend !== undefined && this.has(backend);
  }

  has(key: string): boolean {
    return this.keys.has(key);
  }

  add(key: string): void {
    // 最多保留 128 个被拒绝的身份：满额后新身份走普通失败处理，绝不压制无关路由。
    if (this.keys.size < 128) this.keys.add(key);
  }
}
