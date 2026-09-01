import { describe, it, expect, vi, afterEach } from 'vitest';
import { createPDLProvider } from './pdl';

describe('People Data Labs provider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('canEnrich is false without an API key', () => {
    const provider = createPDLProvider(null);
    expect(provider.canEnrich({ id: '1', fullName: 'Jane Doe', linkedinUrl: 'https://linkedin.com/in/jane' })).toBe(false);
  });

  it('canEnrich requires a linkedinUrl, email, or name+company', () => {
    const provider = createPDLProvider('test-key');
    expect(provider.canEnrich({ id: '1', fullName: 'Jane Doe', linkedinUrl: 'https://linkedin.com/in/jane' })).toBe(true);
    expect(provider.canEnrich({ id: '1', fullName: 'Jane Doe', email: 'jane@example.com' })).toBe(true);
    expect(provider.canEnrich({ id: '1', fullName: 'Jane Doe', company: 'Stripe' })).toBe(true);
    expect(provider.canEnrich({ id: '1', fullName: 'Jane Doe' })).toBe(false);
  });

  it('enriches from a full PDL person response', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          likelihood: 8,
          work_email: 'jane.doe@stripe.com',
          job_company_name: 'Stripe',
          job_title: 'Senior Engineer',
          job_title_levels: ['senior'],
          location_name: 'San Francisco, CA',
          location_country: 'United States',
          linkedin_url: 'https://linkedin.com/in/janedoe',
          github_url: 'https://github.com/janedoe',
        }),
        { status: 200 }
      )
    );

    const provider = createPDLProvider('test-key');
    const result = await provider.enrich({ id: '1', fullName: 'Jane Doe', linkedinUrl: 'https://linkedin.com/in/janedoe' });

    expect(result.data.email).toBe('jane.doe@stripe.com');
    expect(result.data.role).toBe('Senior Engineer');
    expect(result.data.seniority).toBe('senior');
    expect(result.confidence).toBeCloseTo(0.8);
  });

  it('falls back to personal_emails when work_email is absent', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ likelihood: 5, personal_emails: ['jane@gmail.com'] }), { status: 200 })
    );

    const provider = createPDLProvider('test-key');
    const result = await provider.enrich({ id: '1', fullName: 'Jane Doe', email: 'jane@gmail.com' });

    expect(result.data.email).toBe('jane@gmail.com');
  });

  it('throws with the status code when the API responds with an error', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('', { status: 404 }));

    const provider = createPDLProvider('test-key');
    await expect(
      provider.enrich({ id: '1', fullName: 'Jane Doe', email: 'jane@example.com' })
    ).rejects.toThrow(/404/);
  });
});
