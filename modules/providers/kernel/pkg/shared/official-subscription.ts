// 官方订阅查询只处理协议与响应；OAuth 凭据从哪里读取由宿主适配器决定。

import type { ProviderUsage, QuotaWindow } from './provider-contracts.ts';

function numberValue(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function resetTime(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function claudeWindowLabel(key: string): string {
  return (
    {
      five_hour: '5h',
      seven_day: '7d',
      seven_day_opus: '7d Opus',
      seven_day_sonnet: '7d Sonnet',
    } as Record<string, string>
  )[key] ?? key;
}

export function parseClaudeSubscription(json: any): ProviderUsage | null {
  if (!json || typeof json !== 'object') return null;
  const windows: QuotaWindow[] = [];
  for (const [key, item] of Object.entries(json)) {
    if (key === 'extra_usage' || !item || typeof item !== 'object') continue;
    const utilization = numberValue((item as any).utilization);
    if (utilization == null) continue;
    windows.push({
      label: claudeWindowLabel(key),
      remainingPercent: Math.max(0, Math.min(100, 100 - utilization)),
      resetMs: resetTime((item as any).resets_at),
    });
  }

  const extra = json.extra_usage;
  const enabled = extra?.is_enabled === true;
  const monthlyLimit = numberValue(extra?.monthly_limit);
  const usedCredits = numberValue(extra?.used_credits);
  const currency = String(extra?.currency ?? '').toUpperCase() === 'CNY' ? 'CNY' : 'USD';
  const balance =
    enabled && monthlyLimit != null && usedCredits != null
      ? { amount: Math.max(0, monthlyLimit - usedCredits), currency: currency as 'CNY' | 'USD' }
      : undefined;

  if (!windows.length && !balance) return null;
  return {
    mode: windows.length && balance ? 'hybrid' : windows.length ? 'subscription' : 'api',
    quota: windows.length ? { provider: 'anthropic', windows } : undefined,
    balance,
  };
}

export async function fetchClaudeSubscription(
  accessToken: string,
  request: typeof fetch = fetch,
): Promise<ProviderUsage | null> {
  if (!accessToken) return null;
  const response = await request('https://api.anthropic.com/api/oauth/usage', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return null;
  return parseClaudeSubscription(await response.json().catch(() => null));
}

function codexWindowLabel(seconds: unknown): string {
  const value = numberValue(seconds);
  if (value === 18_000) return '5h';
  if (value === 604_800) return '7d';
  if (value === 2_592_000) return '30d';
  if (value == null) return 'unknown';
  const hours = Math.floor(value / 3600);
  return hours >= 24 ? `${Math.floor(hours / 24)}d` : `${hours}h`;
}

export function parseCodexSubscription(json: any): ProviderUsage | null {
  const rateLimit = json?.rate_limit;
  const windows = [rateLimit?.primary_window, rateLimit?.secondary_window].flatMap(
    (item: any): QuotaWindow[] => {
      const used = numberValue(item?.used_percent);
      return used == null
        ? []
        : [
            {
              label: codexWindowLabel(item?.limit_window_seconds),
              remainingPercent: Math.max(0, Math.min(100, 100 - used)),
              resetMs: resetTime(item?.reset_at),
            },
          ];
    },
  );
  return windows.length ? { mode: 'subscription', quota: { provider: 'codex', windows } } : null;
}

export async function fetchCodexSubscription(
  accessToken: string,
  accountId?: string,
  request: typeof fetch = fetch,
): Promise<ProviderUsage | null> {
  if (!accessToken) return null;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': 'codex-cli',
    Accept: 'application/json',
  };
  if (accountId) headers['ChatGPT-Account-Id'] = accountId;
  const response = await request('https://chatgpt.com/backend-api/wham/usage', {
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return null;
  return parseCodexSubscription(await response.json().catch(() => null));
}

function geminiCategory(modelId: string): string {
  if (modelId.includes('flash-lite')) return 'Gemini Flash Lite';
  if (modelId.includes('flash')) return 'Gemini Flash';
  if (modelId.includes('pro')) return 'Gemini Pro';
  return modelId || 'unknown';
}

export function parseGeminiSubscription(json: any): ProviderUsage | null {
  if (!Array.isArray(json?.buckets)) return null;
  const categories = new Map<string, { remaining: number; reset: unknown }>();
  for (const bucket of json.buckets) {
    const remaining = numberValue(bucket?.remainingFraction);
    if (remaining == null) continue;
    const category = geminiCategory(String(bucket?.modelId ?? ''));
    const current = categories.get(category);
    if (!current || remaining < current.remaining) {
      categories.set(category, { remaining: Math.max(0, Math.min(1, remaining)), reset: bucket?.resetTime });
    }
  }
  const order = new Map([
    ['Gemini Pro', 0],
    ['Gemini Flash', 1],
    ['Gemini Flash Lite', 2],
  ]);
  const windows = [...categories.entries()]
    .sort(([left], [right]) => (order.get(left) ?? 3) - (order.get(right) ?? 3))
    .map(([label, item]) => ({
      label,
      remainingPercent: item.remaining * 100,
      resetMs: resetTime(item.reset),
    }));
  return windows.length ? { mode: 'subscription', quota: { provider: 'gemini', windows } } : null;
}

function geminiProjectId(value: any): string | null {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return null;
  return typeof value.id === 'string'
    ? value.id
    : typeof value.projectId === 'string'
      ? value.projectId
      : null;
}

export async function fetchGeminiSubscription(
  accessToken: string,
  request: typeof fetch = fetch,
): Promise<ProviderUsage | null> {
  if (!accessToken) return null;
  const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
  const load = await request('https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist', {
    method: 'POST',
    headers,
    body: JSON.stringify({ metadata: { ideType: 'GEMINI_CLI', pluginType: 'GEMINI' } }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!load.ok) return null;
  const loadJson: any = await load.json().catch(() => null);
  const project = geminiProjectId(loadJson?.cloudaicompanionProject);
  const quota = await request('https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota', {
    method: 'POST',
    headers,
    body: JSON.stringify(project ? { project } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  if (!quota.ok) return null;
  return parseGeminiSubscription(await quota.json().catch(() => null));
}

export function parseCopilotSubscription(json: any): ProviderUsage | null {
  const premium = json?.quota_snapshots?.premium_interactions;
  const remaining = numberValue(premium?.percent_remaining);
  if (remaining == null) return null;
  return {
    mode: 'subscription',
    quota: {
      provider: 'github-copilot',
      windows: [
        {
          label: 'Premium',
          remainingPercent: Math.max(0, Math.min(100, remaining)),
          resetMs: resetTime(json?.quota_reset_date),
        },
      ],
    },
  };
}

export async function fetchCopilotSubscription(
  githubToken: string,
  githubDomain = 'github.com',
  request: typeof fetch = fetch,
): Promise<ProviderUsage | null> {
  if (!githubToken) return null;
  const apiBase =
    githubDomain === 'github.com' ? 'https://api.github.com' : `https://${githubDomain}/api/v3`;
  const response = await request(`${apiBase}/copilot_internal/user`, {
    headers: {
      Authorization: `token ${githubToken}`,
      'Content-Type': 'application/json',
      'editor-version': 'vscode/1.110.1',
      'editor-plugin-version': 'copilot-chat/0.38.2',
      'user-agent': 'GitHubCopilotChat/0.38.2',
      'x-github-api-version': '2025-10-01',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return null;
  return parseCopilotSubscription(await response.json().catch(() => null));
}
