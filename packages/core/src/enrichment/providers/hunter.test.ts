import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHunterProvider } from './hunter';

describe('Hunter.io provider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('canEnrich is false without an API key', () => {
    const provider = createHunterProvider(null);
    expect(provider.canEnrich({ id: '1', fullName: 'Jane Doe', company: 'Stripe' })).toBe(false);
  });

  it('canEnrich requires a domain or company+name', () => {
    const provider = createHunterProvider('test-key');
    expect(provider.canEnrich({ id: '1', fullName: 'Jane Doe', company: 'Stripe' })).toBe(true);
    expect(provider.canEnrich({ id: '1', fullName: 'Jane Doe' })).toBe(false);
  });

  it('finds an email via domain-search then email-finder when no domain is known', async () => {
    const fetchMock = vi.spyOn(global, 'fetch')
      .mockImplementationOnce(async () => new Response(JSON.stringify({ data: { domain: 'stripe.com' } }), { status: 200 }))
      .mockImplementationOnce(async () => new Response(JSON.stringify({
        data: { email: 'jane.doe@stripe.com', score: 85, verification: { status: 'valid' } },
      }), { status: 200 }));

    const provider = createHunterProvider('test-key');
    const result = await provider.enrich({ id: '1', fullName: 'Jane Doe', company: 'Stripe' });

    expect(result.data.email).toBe('jane.doe@stripe.com');
    expect(result.confidence).toBeCloseTo(0.85);
    expect(result.data.emailVerified).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('skips domain-search when companyDomain is already known', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { email: 'jane@stripe.com', score: 70, verification: { status: 'unknown' } } }), { status: 200 })
    );

    const provider = createHunterProvider('test-key');
    await provider.enrich({ id: '1', fullName: 'Jane Doe', companyDomain: 'stripe.com' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws with the status code when the API responds with an error', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('', { status: 401 }));

    const provider = createHunterProvider('test-key');
    await expect(
      provider.enrich({ id: '1', fullName: 'Jane Doe', companyDomain: 'stripe.com' })
    ).rejects.toThrow(/401/);
  });
});
