import type { AiProvider, AiProviderId, ProviderConfig } from './types';
import { AiProviderError } from './types';
import { createOpenAiProvider } from './providers/openai';
import { createAnthropicProvider } from './providers/anthropic';

/**
 * Resolved credentials for the AI providers. The CLI fills this from its
 * encrypted keychain (+ env fallbacks); the web app fills it from server-side
 * environment variables. A future per-user encrypted vault can feed the same
 * shape without touching the engine.
 */
export interface AiCredentials {
  /** Explicit provider selection ('openai' | 'anthropic'); otherwise inferred. */
  provider?: string | null;
  openaiKey?: string | null;
  anthropicKey?: string | null;
  /** OpenAI-compatible API root override. */
  openaiBaseUrl?: string | null;
  /** Model id override for whichever provider is selected. */
  model?: string | null;
}

export function createAiProvider(
  id: AiProviderId,
  config: ProviderConfig,
  fetchImpl?: typeof fetch,
): AiProvider {
  return id === 'openai'
    ? createOpenAiProvider(config, fetchImpl)
    : createAnthropicProvider(config, fetchImpl);
}

/**
 * Choose and construct a provider from available credentials.
 *
 * Selection rules: an explicit `provider` is honored when its key exists
 * (otherwise a clear not-configured error names it); with no explicit
 * provider, OpenAI is preferred when its key is present, then Anthropic.
 * Throws `AiProviderError('not_configured')` when nothing usable is found.
 */
export function resolveAiProvider(credentials: AiCredentials, fetchImpl?: typeof fetch): AiProvider {
  const provider = credentials.provider?.trim().toLowerCase() ?? null;
  const openaiKey = credentials.openaiKey?.trim() || null;
  const anthropicKey = credentials.anthropicKey?.trim() || null;
  const model = credentials.model?.trim() || undefined;
  const baseUrl = credentials.openaiBaseUrl?.trim() || undefined;

  if (provider && provider !== 'openai' && provider !== 'anthropic') {
    throw new AiProviderError(
      'not_configured',
      `Unknown AI provider "${credentials.provider}". Expected "openai" or "anthropic".`,
    );
  }

  if (provider === 'openai') {
    if (!openaiKey) throw missingKeyError('openai');
    return createOpenAiProvider({ apiKey: openaiKey, baseUrl, model }, fetchImpl);
  }
  if (provider === 'anthropic') {
    if (!anthropicKey) throw missingKeyError('anthropic');
    return createAnthropicProvider({ apiKey: anthropicKey, model }, fetchImpl);
  }

  // No explicit preference: prefer OpenAI, fall back to Anthropic.
  if (openaiKey) return createOpenAiProvider({ apiKey: openaiKey, baseUrl, model }, fetchImpl);
  if (anthropicKey) return createAnthropicProvider({ apiKey: anthropicKey, model }, fetchImpl);

  throw new AiProviderError(
    'not_configured',
    'No AI provider key configured. Set one with ' +
      '"netpro config set ai.openai.key sk-..." (or ai.anthropic.key), ' +
      'or set OPENAI_API_KEY / ANTHROPIC_API_KEY in the environment.',
  );
}

function missingKeyError(provider: AiProviderId): AiProviderError {
  return new AiProviderError(
    'not_configured',
    provider === 'openai'
      ? 'AI provider set to "openai" but no OpenAI key found. Set one with ' +
          '"netpro config set ai.openai.key sk-..." or OPENAI_API_KEY in the environment.'
      : 'AI provider set to "anthropic" but no Anthropic key found. Set one with ' +
          '"netpro config set ai.anthropic.key sk-ant-..." or ANTHROPIC_API_KEY in the environment.',
  );
}
