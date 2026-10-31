const CROCKFORD_BASE32_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const NORMALIZED_SESSION_ID_PATTERN = /^[0-9a-f]{32}$/;

export interface PeerShortIdVector {
  readonly sessionId: string;

  readonly shortId: string;
}

export const PEER_SHORT_ID_VECTORS: readonly PeerShortIdVector[] = Object.freeze([
  Object.freeze({ sessionId: "01a09ac8-1d54-74a2-ac5b-faa98c2aed7a", shortId: "62nvbt" }),
  Object.freeze({ sessionId: "01a09b08-8e1c-7096-8b21-550b8c9b0705", shortId: "69p1r5" }),
  Object.freeze({ sessionId: "01a09a61-6632-75f2-b233-24849ef772ce", shortId: "ffewpe" }),
]);

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
