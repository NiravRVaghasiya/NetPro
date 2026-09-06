import type { AiCompletionOptions, AiProvider, ChatMessage, ProviderConfig } from '../types';
import { AiProviderError } from '../types';

export const ANTHROPIC_DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
export const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_API_VERSION = '2023-06-01';

type FetchImpl = typeof fetch;

/**
 * Anthropic Messages provider. The Anthropic API takes the system prompt as
 * a top-level `system` field rather than as a message, so system messages are
 * split out here. Raw `fetch`, injectable for tests, no SDK dependency.
 */
export function createAnthropicProvider(config: ProviderConfig, fetchImpl: FetchImpl = fetch): AiProvider {
  const defaultModel = config.model ?? ANTHROPIC_DEFAULT_MODEL;

  return {
    id: 'anthropic',
    label: 'Anthropic',
    defaultModel,

    async complete(messages: ChatMessage[], options?: AiCompletionOptions): Promise<string> {
      const system = messages
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n\n');
      const convo = messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role, content: m.content }));

      const response = await fetchImpl(config.baseUrl ?? ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': ANTHROPIC_API_VERSION,
        },
        body: JSON.stringify({
          model: options?.model ?? defaultModel,
          max_tokens: options?.maxTokens ?? 600,
          temperature: options?.temperature ?? 0.7,
          system,
          messages: convo,
        }),
        signal: options?.signal,
      });

      if (!response.ok) {
        throw new AiProviderError(
          'upstream_error',
          `Anthropic request failed: ${response.status}${await extractError(response)}`,
        );
      }

      const json = (await response.json()) as {
        content?: Array<{ type?: string; text?: string }>;
      };
      const text = json.content
        ?.filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('')
        .trim();
      if (!text) {
        throw new AiProviderError('invalid_response', 'Anthropic returned an empty completion');
      }
      return text;
    },
  };
}

async function extractError(response: Response): Promise<string> {
  try {
    const json = (await response.json()) as { error?: { message?: string } };
    return json.error?.message ? ` ${json.error.message}` : '';
  } catch {
    return '';
  }
}
