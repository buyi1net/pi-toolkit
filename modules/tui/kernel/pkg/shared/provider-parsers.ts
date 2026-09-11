// 供应商响应解析（纯函数，零 IO）。字段口径以 cc-switch 0b5da51 为基准，
// Sub2API /v1/usage 另按 ApiKey 现场响应与 Sub2API 上游实现适配。
// 解析器只由查询运行层按路由表绑定消费，不从 usage-core / usage-node 出口导出。

import type { BalanceValue, ProviderUsage, QuotaInfo, QuotaWindow } from './provider-contracts.ts';

export function numberValue(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function currencyValue(value: unknown, fallback: 'CNY' | 'USD'): 'CNY' | 'USD' {
  const currency = String(value).toUpperCase();
  if (currency === 'USD' || currency === 'CNY') return currency;
  return fallback;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function resetTime(value: unknown): number | null {
  const numeric = numberValue(value);
  if (numeric != null) {
    if (numeric <= 0) return null;
    return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  }
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function remainingWindow(label: string, remainingPercent: number, reset: unknown): QuotaWindow {
  return { label, remainingPercent: clampPercent(remainingPercent), resetMs: resetTime(reset) };
}

function usageWindow(label: string, used: unknown, limit: unknown, reset: unknown): QuotaWindow | null {
  const usedValue = numberValue(used);
  const limitValue = numberValue(limit);
  if (usedValue == null || limitValue == null || limitValue <= 0) return null;
  return remainingWindow(label, 100 - (usedValue / limitValue) * 100, reset);
}

export function parseStepFunBalance(json: any): BalanceValue | null {
  const amount = numberValue(json?.balance);
  return amount == null ? null : { amount, currency: 'CNY' };
}

export function parseSiliconFlowBalance(json: any, international: boolean): BalanceValue | null {
  const amount = numberValue(json?.data?.totalBalance);
  if (amount == null) return null;
  return { amount, currency: international ? 'USD' : 'CNY' };
}

export function parseOpenRouterBalance(json: any): BalanceValue | null {
  const data = json?.data ?? json;
  const total = numberValue(data?.total_credits);
  const used = numberValue(data?.total_usage);
  if (total == null || used == null) return null;
  return { amount: total - used, currency: 'USD' };
}

export function parseNovitaBalance(json: any): BalanceValue | null {
  const units = numberValue(json?.availableBalance);
  return units == null ? null : { amount: units / 10_000, currency: 'USD' };
}

export function parseKimiBalance(json: any, international = false): BalanceValue | null {
  if ((json?.code !== 0 && json?.code !== '0') || !json?.data) return null;
  const amount = numberValue(json.data.available_balance);
  return amount == null
    ? null
    : { amount, currency: international ? 'USD' : 'CNY' };
}

export function parseKimiQuota(json: any): QuotaInfo | null {
  // 官方接口当前返回裸对象；兼容网关包裹在 data 下的同一响应，
  // 但不把普通余额响应误认为套餐额度。
  const payload = json?.data && (json.data.usage || json.data.limits) ? json.data : json;
  const windows: QuotaWindow[] = [];
  const detail = Array.isArray(payload?.limits)
    ? payload.limits.map((item: any) => item?.detail).find((item: any) => item && numberValue(item.limit) != null)
    : null;
  if (detail) {
    const limit = numberValue(detail.limit);
    const remaining = numberValue(detail.remaining);
    if (limit != null && limit > 0 && remaining != null) {
      windows.push(remainingWindow('5h', (remaining / limit) * 100, detail.resetTime));
    }
  }
  const weeklyLimit = numberValue(payload?.usage?.limit);
  const weeklyRemaining = numberValue(payload?.usage?.remaining);
  if (weeklyLimit != null && weeklyLimit > 0 && weeklyRemaining != null) {
    windows.push(remainingWindow('7d', (weeklyRemaining / weeklyLimit) * 100, payload.usage.resetTime));
  }
  return windows.length > 0 ? { provider: 'kimi', windows } : null;
}

export function parseMiniMaxQuota(json: any): QuotaInfo | null {
  if (numberValue(json?.base_resp?.status_code) != null && numberValue(json.base_resp.status_code) !== 0) {
    return null;
  }
  const item = Array.isArray(json?.model_remains)
    ? json.model_remains.find((entry: any) => entry?.model_name === 'general')
    : null;
  if (!item) return null;

  const windows: QuotaWindow[] = [];
  const interval = numberValue(item.current_interval_remaining_percent);
  if (interval != null) windows.push(remainingWindow('5h', interval, item.end_time));
  if (numberValue(item.current_weekly_status) === 1) {
    const weekly = numberValue(item.current_weekly_remaining_percent);
    if (weekly != null) windows.push(remainingWindow('7d', weekly, item.weekly_end_time));
  }
  return windows.length > 0 ? { provider: 'minimax', windows } : null;
}

export function parseZenMuxQuota(json: any): QuotaInfo | null {
  if (json?.success !== true || !json?.data) return null;
  const windows: QuotaWindow[] = [];
  for (const [field, label] of [
    ['quota_5_hour', '5h'],
    ['quota_7_day', '7d'],
  ] as const) {
    const item = json.data[field];
    const usedRatio = numberValue(item?.usage_percentage);
    if (usedRatio != null) windows.push(remainingWindow(label, 100 - usedRatio * 100, item.resets_at));
  }
  return windows.length > 0 ? { provider: 'zenmux', windows } : null;
}

function sub2ApiSubscriptionWindows(subscription: any): QuotaWindow[] {
  const weeklyStart = resetTime(subscription?.weekly_window_start);
  const weeklyReset = weeklyStart == null ? null : weeklyStart + 7 * 86_400_000;
  return [
    usageWindow('1d', subscription?.daily_usage_usd, subscription?.daily_limit_usd, null),
    usageWindow('7d', subscription?.weekly_usage_usd, subscription?.weekly_limit_usd, weeklyReset),
    usageWindow('30d', subscription?.monthly_usage_usd, subscription?.monthly_limit_usd, subscription?.expires_at),
  ].filter((window): window is QuotaWindow => window != null);
}

function sub2ApiRateWindows(rateLimits: any): QuotaWindow[] {
  if (!Array.isArray(rateLimits)) return [];
  return rateLimits
    .map((item: any) => usageWindow(String(item?.window ?? ''), item?.used, item?.limit, item?.reset_at))
    .filter((window): window is QuotaWindow => window != null && window.label.length > 0);
}

export function parseSub2ApiUsage(json: any, provider: string): ProviderUsage | null {
  if (!json || json.isValid === false || json.error) return null;

  const subscriptionWindows = sub2ApiSubscriptionWindows(json.subscription);
  const rateWindows = sub2ApiRateWindows(json.rate_limits);
  const windows = [...subscriptionWindows, ...rateWindows];
  const quotaRemaining = numberValue(json?.quota?.remaining);
  const walletRemaining = numberValue(json?.remaining) ?? numberValue(json?.balance);
  const amount = quotaRemaining ?? walletRemaining;
  const balance =
    amount == null
      ? undefined
      : { amount, currency: currencyValue(json?.quota?.unit ?? json?.unit, 'USD') };

  if (windows.length > 0) {
    return {
      mode: balance ? 'hybrid' : 'subscription',
      balance,
      quota: { provider, windows },
    };
  }
  return balance ? { mode: 'api', balance } : null;
}
