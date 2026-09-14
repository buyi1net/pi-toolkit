// 任意 UUID 形状 id 的短码派生（规格「会话发现与通讯」·发现·会话短码派生；作用域经
// 《会话通讯消息关联与链路优化规格说明》决策 1 从会话 id 推广到任意 UUID 形状 id）：会话
// 短码与消息短码是同一实现的两次应用，唯一实现归 shared/——tui 短码段、peers 列表、寻址
// 解析与消息引用共用，禁止在别处重复派生逻辑。
//
// 返回值不带前缀（呈现侧自行加：会话呈 `#` 加 6 位，消息呈 `@` 加 6 位）；规范化后不是
// 32 位十六进制（缺失、非法字符、长度不符）返回 null，不抛错、不猜值。

/** Crockford base32 字母表（32 个字符，去掉 I / L / O / U），按规格字面量 */
const CROCKFORD_BASE32_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 规范化结果：会话 id 去连字符、转小写后必须是恰好 32 位十六进制 */
const NORMALIZED_SESSION_ID_PATTERN = /^[0-9a-f]{32}$/;

/** 规格给出的 golden vectors（字面量，派生规则与测试共用同一组期望值） */
export interface PeerShortIdVector {
  readonly sessionId: string;
  /** 不带 `#` 前缀的 6 位短码 */
  readonly shortId: string;
}

export const PEER_SHORT_ID_VECTORS: readonly PeerShortIdVector[] = Object.freeze([
  Object.freeze({ sessionId: "01a09ac8-1d54-74a2-ac5b-faa98c2aed7a", shortId: "62nvbt" }),
  Object.freeze({ sessionId: "01a09b08-8e1c-7096-8b21-550b8c9b0705", shortId: "69p1r5" }),
  Object.freeze({ sessionId: "01a09a61-6632-75f2-b233-24849ef772ce", shortId: "ffewpe" }),
]);

/**
 * UUID 形状 id → 6 位短码（确定性派生）：
 * 1. 去连字符转小写，非 32 位十六进制返回 null；
 * 2. 取最后 8 个十六进制字符解析为 32 位整数，取最低 30 位；
 * 3. 从高位到低位切成 6 组 × 5 位，逐组映射 Crockford 字母表，输出小写。
 */
export function deriveSessionShortId(sessionId: string): string | null {
  const normalized = sessionId.replaceAll("-", "").toLowerCase();
  if (!NORMALIZED_SESSION_ID_PATTERN.test(normalized)) return null;
  const value = Number.parseInt(normalized.slice(-8), 16) & 0x3fffffff;
  let code = "";
  for (let shift = 25; shift >= 0; shift -= 5) {
    code += CROCKFORD_BASE32_ALPHABET[(value >>> shift) & 0x1f];
  }
  return code.toLowerCase();
}
