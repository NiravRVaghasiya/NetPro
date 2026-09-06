import { describe, it, expect, vi } from 'vitest';
import {
  createAnthropicProvider,
  ANTHROPIC_API_URL,
  ANTHROPIC_API_VERSION,
  ANTHROPIC_DEFAULT_MODEL,
} from './anthropic';
import { AiProviderError } from '../types';

function fakeFetch(response: Partial<Response>): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}), ...response } as Response));
}

describe('createAnthropicProvider', () => {
  it('posts to the messages endpoint, splitting system out and joining text blocks', async () => {
    const fetchImpl = fakeFetch({
      json: async () => ({
        content: [
          { type: 'text', text: 'Subject: Hi\n\nBody' },
          { type: 'tool_use', id: 'x', name: 'n', input: {} },
        ],
      }),
    });
    const provider = createAnthropicProvider({ apiKey: 'sk-ant-test' }, fetchImpl);

    const reply = await provider.complete([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'draft' },
    ]);

    expect(reply).toBe('Subject: Hi\n\nBody');
    expect(provider.id).toBe('anthropic');
    expect(provider.defaultModel).toBe(ANTHROPIC_DEFAULT_MODEL);

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(ANTHROPIC_API_URL);
    expect(init?.headers).toMatchObject({
      'x-api-key': 'sk-ant-test',
      'anthropic-version': ANTHROPIC_API_VERSION,
    });
    const body = JSON.parse((init?.body as string) ?? '{}');
    expect(body.system).toBe('be brief');
    expect(body.messages).toEqual([{ role: 'user', content: 'draft' }]);
    expect(body.max_tokens).toBe(600);
  });

  it('honors model/config overrides', async () => {
    const fetchImpl = fakeFetch({
      json: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    });
    const provider = createAnthropicProvider(
      { apiKey: 'k', model: 'claude-custom', baseUrl: 'https://proxy.example.com/v1/messages' },
      fetchImpl,
    );
    await provider.complete([{ role: 'user', content: 'x' }], { maxTokens: 50 });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://proxy.example.com/v1/messages');
    const body = JSON.parse((init?.body as string) ?? '{}');
    expect(body.model).toBe('claude-custom');
    expect(body.max_tokens).toBe(50);
  });

  it('throws upstream_error with status on failure', async () => {
    const fetchImpl = fakeFetch({
      ok: false,
      status: 429,
      json: async () => ({ error: { message: 'rate limited' } }),
    });
    const provider = createAnthropicProvider({ apiKey: 'k' }, fetchImpl);
    await expect(provider.complete([{ role: 'user', content: 'x' }])).rejects.toThrow(
      /Anthropic request failed: 429 rate limited/,
    );
  });

  it('throws invalid_response when no text block comes back', async () => {
    const fetchImpl = fakeFetch({ json: async () => ({ content: [] }) });
    const provider = createAnthropicProvider({ apiKey: 'k' }, fetchImpl);
    await expect(provider.complete([{ role: 'user', content: 'x' }])).rejects.toBeInstanceOf(
      AiProviderError,
    );
    await expect(provider.complete([{ role: 'user', content: 'x' }])).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });
});
