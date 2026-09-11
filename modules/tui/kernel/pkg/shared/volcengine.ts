// 火山方舟 Agent Plan / Coding Plan 控制面查询。
// 协议与签名规则移植自 cc-switch 0b5da51 coding_plan.rs；它使用 AK/SK，
// 不能复用推理接口的 Bearer Key。

import { createHash, createHmac } from 'node:crypto';
import type { QuotaInfo, QuotaWindow } from './provider-contracts.ts';

const HOST = 'open.volcengineapi.com';
const VERSION = '2024-01-01';
const SERVICE = 'ark';
const CONTENT_TYPE = 'application/json; charset=utf-8';
const SIGNED_HEADERS = 'host;x-date;x-content-sha256;content-type';

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest();
}

function isoBasic(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function shortDate(date: Date): string {
  return isoBasic(date).slice(0, 8);
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function volcengineRegion(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.split('.').find((part) => /^(?:cn|ap)-/.test(part)) ?? 'cn-beijing';
  } catch {
    return 'cn-beijing';
  }
}

export function volcengineCanonicalQuery(action: string, region: string): string {
  return [
    ['Action', action],
    ['Region', region],
    ['Version', VERSION],
  ]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${encodeRfc3986(key)}=${encodeRfc3986(value)}`)
    .join('&');
}

export function signVolcengineRequest(
  accessKeyId: string,
  secretAccessKey: string,
  region: string,
  canonicalQuery: string,
  now: Date,
): { authorization: string; xDate: string; contentSha256: string } {
  const xDate = isoBasic(now);
  const date = shortDate(now);
  const contentSha256 = sha256Hex('');
  const canonicalHeaders =
    `host:${HOST}\n` +
    `x-date:${xDate}\n` +
    `x-content-sha256:${contentSha256}\n` +
    `content-type:${CONTENT_TYPE}\n`;
  const canonicalRequest =
    `POST\n/\n${canonicalQuery}\n${canonicalHeaders}\n${SIGNED_HEADERS}\n${contentSha256}`;
  const scope = `${date}/${region}/${SERVICE}/request`;
  const stringToSign = `HMAC-SHA256\n${xDate}\n${scope}\n${sha256Hex(canonicalRequest)}`;
  const kDate = hmac(secretAccessKey, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, SERVICE);
  const kSigning = hmac(kService, 'request');
  const signature = hmac(kSigning, stringToSign).toString('hex');
  return {
    authorization:
      `HMAC-SHA256 Credential=${accessKeyId}/${scope}, ` +
      `SignedHeaders=${SIGNED_HEADERS}, Signature=${signature}`,
    xDate,
    contentSha256,
  };
}

function numberValue(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function resetMs(value: unknown): number | null {
  const numeric = numberValue(value);
  if (numeric != null) return numeric <= 0 ? null : numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function window(label: string, usedPercent: number, reset: unknown): QuotaWindow {
  return {
    label,
    remainingPercent: Math.max(0, Math.min(100, 100 - usedPercent)),
    resetMs: resetMs(reset),
  };
}

export function parseVolcengineAgentPlan(json: any): QuotaInfo | null {
  const result = json?.Result ?? json;
  const windows: QuotaWindow[] = [];
  for (const [field, label] of [
    ['AFPFiveHour', '5h'],
    ['AFPWeekly', '7d'],
    ['AFPMonthly', '30d'],
  ] as const) {
    const item = result?.[field];
    const quota = numberValue(item?.Quota);
    const used = numberValue(item?.Used);
    if (quota != null && quota > 0 && used != null) {
      windows.push(window(label, (used / quota) * 100, item?.ResetTime));
    }
  }
  return windows.length ? { provider: 'volcengine', windows } : null;
}

function codingWindow(value: unknown): string | null {
  const label = String(value ?? '').toLowerCase();
  if (['session', '5h', 'fivehour', 'five_hour', 'rolling_5h'].includes(label)) return '5h';
  if (['weekly', 'week', '7d'].includes(label)) return '7d';
  if (['monthly', 'month'].includes(label)) return '30d';
  return null;
}

export function parseVolcengineCodingPlan(json: any): QuotaInfo | null {
  const result = json?.Result ?? json;
  const items = result?.QuotaUsage ?? result?.Usages ?? result?.Details;
  if (!Array.isArray(items)) return null;
  const windows = items.flatMap((item: any): QuotaWindow[] => {
    const label = codingWindow(item?.Level ?? item?.Type ?? item?.Period ?? item?.Label ?? item?.Window);
    const used = numberValue(item?.Percent ?? item?.UsedPercent ?? item?.UsagePercent);
    return label && used != null
      ? [window(label, used, item?.ResetTime ?? item?.ResetTimestamp)]
      : [];
  });
  return windows.length ? { provider: 'volcengine', windows } : null;
}

function hasResponseError(json: any): boolean {
  const error = json?.ResponseMetadata?.Error ?? json?.Error;
  return Boolean(error?.Code || error?.Message);
}

async function callVolcengine(
  action: string,
  region: string,
  accessKeyId: string,
  secretAccessKey: string,
  request: typeof fetch,
): Promise<any | null> {
  const canonicalQuery = volcengineCanonicalQuery(action, region);
  const signed = signVolcengineRequest(accessKeyId, secretAccessKey, region, canonicalQuery, new Date());
  const response = await request(`https://${HOST}/?${canonicalQuery}`, {
    method: 'POST',
    headers: {
      Authorization: signed.authorization,
      'Content-Type': CONTENT_TYPE,
      'X-Date': signed.xDate,
      'X-Content-Sha256': signed.contentSha256,
    },
    body: '',
    signal: AbortSignal.timeout(15_000),
  });
  const json = await response.json().catch(() => null);
  return response.ok && json && !hasResponseError(json) ? json : null;
}

export async function fetchVolcengineQuota(
  baseUrl: string,
  accessKeyId: string,
  secretAccessKey: string,
  request: typeof fetch = fetch,
  plan: 'agent' | 'coding' = 'agent',
): Promise<QuotaInfo | null> {
  if (!accessKeyId || !secretAccessKey) return null;
  const region = volcengineRegion(baseUrl);
  if (plan === 'coding') {
    const coding = await callVolcengine('GetCodingPlanUsage', region, accessKeyId, secretAccessKey, request);
    return parseVolcengineCodingPlan(coding);
  }
  const agent = await callVolcengine('GetAFPUsage', region, accessKeyId, secretAccessKey, request);
  return parseVolcengineAgentPlan(agent);
}
