import { describe, it, expect, vi, afterEach } from 'vitest';
import { createClearbitProvider } from './clearbit';

describe('Clearbit provider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('canEnrich is false without an API key', () => {
    const provider = createClearbitProvider(null);
    expect(provider.canEnrich({ id: '1', fullName: 'Jane Doe', company: 'Stripe' })).toBe(false);
  });

  it('canEnrich requires a company or companyDomain', () => {
    const provider = createClearbitProvider('test-key');
    expect(provider.canEnrich({ id: '1', fullName: 'Jane Doe', company: 'Stripe' })).toBe(true);
    expect(provider.canEnrich({ id: '1', fullName: 'Jane Doe', companyDomain: 'stripe.com' })).toBe(true);
    expect(provider.canEnrich({ id: '1', fullName: 'Jane Doe' })).toBe(false);
  });

  it('looks up a company by domain when known, with a Bearer auth header', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ name: 'Stripe', domain: 'stripe.com', category: { industry: 'Financial Services' } }), { status: 200 })
    );

    const provider = createClearbitProvider('test-key');
    const result = await provider.enrich({ id: '1', fullName: 'Jane Doe', companyDomain: 'stripe.com' });

    expect(result.data.company).toBe('Stripe');
    expect(result.data.industry).toBe('Financial Services');
    const [, options] = fetchMock.mock.calls[0]!;
    expect((options as RequestInit).headers).toMatchObject({ Authorization: 'Bearer test-key' });
  });

  it('falls back to a name lookup when no domain is known', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ name: 'Stripe', domain: 'stripe.com' }), { status: 200 })
    );

    const provider = createClearbitProvider('test-key');
    await provider.enrich({ id: '1', fullName: 'Jane Doe', company: 'Stripe' });

    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('name=Stripe');
  });

  it('throws with the status code when the API responds with an error', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('', { status: 404 }));

    const provider = createClearbitProvider('test-key');
    await expect(
      provider.enrich({ id: '1', fullName: 'Jane Doe', companyDomain: 'unknown.example' })
    ).rejects.toThrow(/404/);
  });
});
