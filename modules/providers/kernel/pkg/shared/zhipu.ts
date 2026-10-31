import type { QuotaInfo, QuotaWindow } from './provider-contracts.ts';

export interface ZhipuLimit {
  type?: string;
  unit?: number;
  number?: number;
  percentage?: number;
  nextResetTime?: number;
}

export function parseZhipuQuota(json: any): QuotaInfo | null {
  const limits: ZhipuLimit[] = json?.data?.limits;
  if (!Array.isArray(limits) || limits.length === 0) return null;

  const valid = limits.filter((l) => {
    const t = (l.type ?? '').toUpperCase();
    return t === 'TOKENS_LIMIT' || t === 'CREDIT_LIMIT';
  });
  if (valid.length === 0) return null;

  const toWindow = (label: string, l: ZhipuLimit | null): QuotaWindow | null => {
    if (!l || typeof l.percentage !== 'number') return null;
    return {
      label,
      remainingPercent: Math.max(0, Math.min(100, 100 - l.percentage)),
      resetMs: typeof l.nextResetTime === 'number' ? l.nextResetTime : null,
    };
  };

  let w5 = valid.find((l) => l.unit === 3) ?? null;
  let w7 = valid.find((l) => l.unit === 6) ?? null;

  if (!w5 && !w7) {
    if (valid.length === 1) {
      w5 = valid[0];
    } else {
      const sorted = [...valid].sort((a, b) => (a.nextResetTime ?? 0) - (b.nextResetTime ?? 0));
      w5 = sorted.find((l) => l.nextResetTime == null) ?? sorted[0];
      w7 = sorted.filter((l) => l !== w5)[0] ?? null;
    }
  }

  const windows = [toWindow('5h', w5), toWindow('7d', w7)].filter(
    (window): window is QuotaWindow => window != null,
  );
  return windows.length > 0 ? { provider: 'zhipu', windows } : null;
}

export function parseZhipuBalance(json: any): number | null {
  if (json?.code !== 200 || typeof json?.data?.balance !== 'number') return null;
  return json.data.balance;
}

export function zhipuHost(baseUrl: string): string {
  try {
    const hostname = new URL(baseUrl).hostname;
    if (hostname === 'bigmodel.cn' || hostname.endsWith('.bigmodel.cn')) return 'https://open.bigmodel.cn';
  } catch {

  }
  return 'https://api.z.ai';
}

export async function fetchZhipuQuota(
  baseUrl: string,
  apiKey: string,
  request: typeof fetch = fetch,
): Promise<QuotaInfo | null> {
  const url = `${zhipuHost(baseUrl)}/api/monitor/usage/quota/limit`;
  const res = await request(url, {
    headers: {
      Authorization: apiKey, // 裸 key：智谱监控端点不带 Bearer 前缀
      'Content-Type': 'application/json',
      'Accept-Language': 'en-US,en',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  const quota = parseZhipuQuota(await res.json().catch(() => null));
  return quota && zhipuHost(baseUrl) === 'https://api.z.ai' ? { ...quota, provider: 'z.ai' } : quota;
}

export async function fetchZhipuTeamQuota(
  apiKey: string,
  organizationId: string,
  projectId: string,
  request: typeof fetch = fetch,
): Promise<QuotaInfo | null> {
  if (!apiKey || !organizationId || !projectId) return null;
  const res = await request('https://open.bigmodel.cn/api/monitor/usage/quota/limit?type=2', {
    headers: {
      Authorization: apiKey,
      'bigmodel-organization': organizationId,
      'bigmodel-project': projectId,
      'Content-Type': 'application/json',
      'Accept-Language': 'en-US,en',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  return parseZhipuQuota(await res.json().catch(() => null));
}

export async function fetchZhipuBalance(apiKey: string, request: typeof fetch = fetch): Promise<number | null> {
  const res = await request('https://bigmodel.cn/api/biz/account/query-customer-account-report', {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  return parseZhipuBalance(await res.json().catch(() => null));
}

export interface DeepSeekBalance {
  amount: number;
  currency: 'CNY' | 'USD';
}

export function parseDeepSeekBalance(json: any): DeepSeekBalance | null {
  const infos = json?.balance_infos;
  if (!Array.isArray(infos) || infos.length === 0) return null;
  const pick = infos.find((i: any) => i?.currency === 'CNY') ?? infos[0];
  const amount = Number(pick?.total_balance);
  if (!Number.isFinite(amount)) return null;
  return { amount, currency: pick?.currency === 'USD' ? 'USD' : 'CNY' };
}

export async function fetchDeepSeekBalance(
  apiKey: string,
  request: typeof fetch = fetch,
): Promise<DeepSeekBalance | null> {
  const res = await request('https://api.deepseek.com/user/balance', {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  return parseDeepSeekBalance(await res.json().catch(() => null));
}
