import { findProviderById } from './provider-catalog.ts';

const MODEL_PROVIDER_PATTERNS: readonly [RegExp, string][] = [
  [/^deepseek(?:[-_/]|$)/, 'deepseek'],
  [/^(?:kimi|moonshot)(?:[-_/]|$)/, 'kimi'],
  [/^(?:glm|chatglm|zhipu)(?:[-_/]|$)/, 'zhipu'],
  [/^(?:qwen|qwq)(?:[-_/]|$)/, 'qwen'],
  [/^(?:minimax|abab)(?:[-_/]|$)/, 'minimax'],
  [/^(?:doubao|seed)(?:[-_/]|$)/, 'doubao'],
  [/^(?:gemini|gemma)(?:[-_/]|$)/, 'gemini'],
  [/^(?:claude|anthropic)(?:[-_/]|$)/, 'anthropic'],
  [/^(?:gpt|o[1-4])(?:[-_/]|$)/, 'openai'],
  [/^(?:grok|xai)(?:[-_/]|$)/, 'xai'],
  [/^(?:llama)(?:[-_/]|$)/, 'meta'],
  [/^(?:mistral|codestral)(?:[-_/]|$)/, 'mistral'],
];

const QUERY_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  zhipu: 'Zhipu',
  'z.ai': 'Zhipu',
  kimi: 'Kimi',
  qwen: 'Qwen',
  doubao: 'Doubao',
  gemini: 'Google',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  xai: 'xAI',
  meta: 'Meta',
  mistral: 'Mistral',
  minimax: 'MiniMax',
  'minimax-cn': 'MiniMax',
  'minimax-en': 'MiniMax',
  zenmux: 'ZenMux',
  deepseek: 'DeepSeek',
  stepfun: 'StepFun',
  siliconflow: 'SiliconFlow',
  'siliconflow-cn': 'SiliconFlow',
  'siliconflow-en': 'SiliconFlow',
  openrouter: 'OpenRouter',
  novita: 'Novita',
  sub2api: 'Sub2API',
  'apikey.fun': 'ApiKey',
};

/** 仅用于未知中转的界面标注，不能用于选择查询端点或发送凭据。 */
export function inferModelProviderName(modelId: string): string | undefined {
  const normalized = modelId.trim().toLowerCase().split('/').pop() ?? '';
  return MODEL_PROVIDER_PATTERNS.find(([pattern]) => pattern.test(normalized))?.[1];
}

/** 内部标识只用于逻辑；状态栏显示官方拉丁品牌名，未知值保留宿主原文。 */
export function displayProviderName(providerId: string): string {
  const normalized = providerId.toLowerCase();
  return QUERY_DISPLAY_NAMES[normalized] ?? findProviderById(normalized)?.displayName ?? providerId;
}
