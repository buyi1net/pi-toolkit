// xAI / Grok 官方订阅额度。grok.com 使用 gRPC-web + protobuf，且未公开 .proto；
// 此处保留 cc-switch 0b5da51 的防御式字段扫描策略，不把二进制响应当 JSON 猜测。

import type { ProviderUsage } from './provider-contracts.ts';

const ENDPOINT = 'https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig';

interface Scan {
  floats: Array<{ path: number[]; value: number; order: number }>;
  varints: Array<{ path: number[]; value: number }>;
}

function readVarint(bytes: Uint8Array, state: { index: number }): number | null {
  let value = 0;
  let shift = 0;
  while (state.index < bytes.length && shift < 53) {
    const byte = bytes[state.index++];
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return value;
    shift += 7;
  }
  return null;
}

function scanProtobuf(
  bytes: Uint8Array,
  depth: number,
  path: number[],
  scan: Scan,
  order: { value: number },
): void {
  const state = { index: 0 };
  while (state.index < bytes.length) {
    const start = state.index;
    const key = readVarint(bytes, state);
    if (!key) {
      state.index = start + 1;
      continue;
    }
    const field = Math.floor(key / 8);
    const wire = key & 7;
    const fieldPath = [...path, field];
    if (wire === 0) {
      const value = readVarint(bytes, state);
      if (value == null) state.index = start + 1;
      else scan.varints.push({ path: fieldPath, value });
    } else if (wire === 1) {
      state.index += 8;
    } else if (wire === 2) {
      const length = readVarint(bytes, state);
      if (length == null || state.index + length > bytes.length) {
        state.index = start + 1;
        continue;
      }
      const end = state.index + length;
      if (depth < 4) scanProtobuf(bytes.subarray(state.index, end), depth + 1, fieldPath, scan, order);
      state.index = end;
    } else if (wire === 5) {
      if (state.index + 4 > bytes.length) break;
      const view = new DataView(bytes.buffer, bytes.byteOffset + state.index, 4);
      scan.floats.push({ path: fieldPath, value: view.getFloat32(0, true), order: order.value++ });
      state.index += 4;
    } else {
      state.index = start + 1;
    }
  }
}

function grpcPayloads(bytes: Uint8Array): Uint8Array[] {
  const payloads: Uint8Array[] = [];
  let index = 0;
  while (index < bytes.length) {
    if (index + 5 > bytes.length) return [];
    const flags = bytes[index];
    const length = new DataView(bytes.buffer, bytes.byteOffset + index + 1, 4).getUint32(0, false);
    const start = index + 5;
    const end = start + length;
    if (end > bytes.length) return [];
    if ((flags & 0x80) === 0) payloads.push(bytes.subarray(start, end));
    index = end;
  }
  return payloads;
}

function looksLikeProtobuf(bytes: Uint8Array): boolean {
  const first = bytes[0];
  return bytes.length > 0 && first >> 3 > 0 && [0, 1, 2, 5].includes(first & 7);
}

function samePath(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function tierLabel(resetSeconds: number | null, nowSeconds: number): string {
  if (resetSeconds != null) {
    const days = Math.round((resetSeconds - nowSeconds) / 86_400);
    if (days >= 4 && days <= 12) return '7d';
    if (days >= 20 && days <= 45) return '30d';
  }
  return 'Credits';
}

export function parseGrokSubscription(
  bytes: Uint8Array,
  nowSeconds = Math.floor(Date.now() / 1000),
): ProviderUsage | null {
  let payloads = grpcPayloads(bytes);
  if (!payloads.length && looksLikeProtobuf(bytes)) payloads = [bytes];
  if (!payloads.length) return null;

  const scan: Scan = { floats: [], varints: [] };
  for (const payload of payloads) scanProtobuf(payload, 0, [], scan, { value: 0 });
  const percent = scan.floats
    .filter((item) => item.path.at(-1) === 1 && Number.isFinite(item.value) && item.value >= 0 && item.value <= 100)
    .sort((left, right) => left.path.length - right.path.length || left.order - right.order)[0]?.value;
  const resets = scan.varints
    .filter((item) => item.value >= 1_700_000_000 && item.value <= 2_100_000_000 && item.value > nowSeconds)
    .sort((left, right) => {
      const leftExact = samePath(left.path, [1, 5, 1]) ? 0 : 1;
      const rightExact = samePath(right.path, [1, 5, 1]) ? 0 : 1;
      return leftExact - rightExact || left.value - right.value;
    });
  const reset = resets[0]?.value ?? null;
  const hasPeriod = scan.varints.some(
    (item) =>
      (item.path[0] === 1 && item.path[1] === 6) ||
      (samePath(item.path, [1, 8, 1]) && (item.value === 1 || item.value === 2)),
  );
  const used = percent ?? (!scan.floats.length && reset != null && hasPeriod ? 0 : null);
  if (used == null) return null;
  return {
    mode: 'subscription',
    quota: {
      provider: 'xai',
      windows: [
        {
          label: tierLabel(reset, nowSeconds),
          remainingPercent: Math.max(0, Math.min(100, 100 - used)),
          resetMs: reset == null ? null : reset * 1000,
        },
      ],
    },
  };
}

export async function fetchGrokSubscription(
  accessToken: string,
  request: typeof fetch = fetch,
  userAgent?: string,
): Promise<ProviderUsage | null> {
  if (!accessToken) return null;
  const response = await request(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Origin: 'https://grok.com',
      Referer: 'https://grok.com/?_s=usage',
      Accept: '*/*',
      'Content-Type': 'application/grpc-web+proto',
      'x-grpc-web': '1',
      'x-user-agent': 'connect-es/2.1.1',
      ...(userAgent ? { 'User-Agent': userAgent } : {}),
    },
    body: new Uint8Array(5),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok || (response.headers.get('grpc-status') ?? '0') !== '0') return null;
  return parseGrokSubscription(new Uint8Array(await response.arrayBuffer()));
}
