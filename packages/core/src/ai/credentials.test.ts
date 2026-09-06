import { describe, it, expect } from 'vitest';
import { resolveAiProvider } from './credentials';
import { AiProviderError } from './types';

// A fetch that returns a minimal valid completion for whichever endpoint is
// called, so we can exercise constructed providers without network access.
function recordingFetch(expectedUrl: string): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    expect(url).toBe(expectedUrl);
    return {
      ok: true,
      status: 200,
      json: async () =>
        url.includes('anthropic')
          ? { content: [{ type: 'text', text: 'ok' }] }
          : { choices: [{ message: { content: 'ok' } }] },
    } as Response;
  }) as typeof fetch;
}

describe('resolveAiProvider', () => {
  it('prefers OpenAI when both keys exist and no provider is named', () => {
    const provider = resolveAiProvider(
      { openaiKey: 'sk-o', anthropicKey: 'sk-ant-a' },
      recordingFetch('https://api.openai.com/v1/chat/completions'),
    );
    expect(provider.id).toBe('openai');
  });

  it('falls back to Anthropic when only that key exists', () => {
    const provider = resolveAiProvider(
      { anthropicKey: 'sk-ant-a' },
      recordingFetch('https://api.anthropic.com/v1/messages'),
    );
    expect(provider.id).toBe('anthropic');
  });

  it('honors an explicit anthropic provider even if an OpenAI key exists', () => {
    const provider = resolveAiProvider(
      { provider: 'anthropic', openaiKey: 'sk-o', anthropicKey: 'sk-ant-a' },
      recordingFetch('https://api.anthropic.com/v1/messages'),
    );
    expect(provider.id).toBe('anthropic');
  });

  it('treats blank/whitespace keys as absent', () => {
    expect(() =>
      resolveAiProvider({ openaiKey: '   ', anthropicKey: '' }, recordingFetch('x')),
    ).toThrowError(AiProviderError);
  });

  it('throws not_configured with setup guidance when no key is present', () => {
    try {
      resolveAiProvider({}, recordingFetch('x'));
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(AiProviderError);
      expect((e as AiProviderError).code).toBe('not_configured');
      expect((e as Error).message).toMatch(/ai\.openai\.key/);
    }
  });

  it('throws not_configured naming the provider when an explicit provider lacks its key', () => {
    try {
      resolveAiProvider({ provider: 'anthropic', openaiKey: 'sk-o' }, recordingFetch('x'));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as AiProviderError).code).toBe('not_configured');
      expect((e as Error).message).toMatch(/anthropic/);
    }
  });

  it('rejects an unknown provider name', () => {
    try {
      resolveAiProvider({ provider: 'gemini', openaiKey: 'sk-o' }, recordingFetch('x'));
      throw new Error('expected throw');
    } catch (e) {
      expect((e as AiProviderError).code).toBe('not_configured');
      expect((e as Error).message).toMatch(/Unknown AI provider "gemini"/);
    }
  });

  it('constructs a working OpenAI provider that calls the chat endpoint', async () => {
    const provider = resolveAiProvider(
      { openaiKey: 'sk-o', openaiBaseUrl: 'https://gw.test/v1', model: 'gpt-x' },
      recordingFetch('https://gw.test/v1/chat/completions'),
    );
    expect(provider.defaultModel).toBe('gpt-x');
    const reply = await provider.complete([{ role: 'user', content: 'hi' }]);
    expect(reply).toBe('ok');
  });
});
