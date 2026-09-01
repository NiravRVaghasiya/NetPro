import type { EnrichableContact, EnrichmentProvider, EnrichmentResult } from '../types';

export function createHunterProvider(apiKey: string | null): EnrichmentProvider {
  return {
    id: 'hunter',
    name: 'Hunter.io',
    rateLimit: { requests: 25, windowMs: 24 * 60 * 60 * 1000 }, // free tier: 25/day
    priority: 1,
    cacheTTL: 30 * 86400,
    apiKey: apiKey,

    canEnrich(contact: EnrichableContact): boolean {
      if (!apiKey) return false;
      return Boolean(contact.companyDomain || (contact.fullName && contact.company));
    },

    async enrich(contact: EnrichableContact): Promise<EnrichmentResult> {
      if (!apiKey) throw new Error('Hunter.io API key not configured');

      let domain: string | undefined = contact.companyDomain ?? undefined;
      if (!domain && contact.company) {
        domain = await findDomain(contact.company, apiKey);
      }
      if (!domain) throw new Error('Could not resolve a domain for this contact');

      const nameParts = contact.fullName.split(' ');
      const firstName: string = nameParts[0]!;
      const lastName: string = nameParts.slice(1).join(' ');

      const url = new URL('https://api.hunter.io/v2/email-finder');
      url.searchParams.set('domain', domain as string);
      url.searchParams.set('first_name', firstName);
      url.searchParams.set('last_name', lastName);
      url.searchParams.set('api_key', apiKey as string);

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Hunter.io email-finder failed: ${response.status}`);
      }
      const json = await response.json();
      const data = json.data;

      return {
        provider: 'hunter',
        confidence: (data.score ?? 0) / 100,
        data: {
          email: data.email ?? undefined,
          emailVerified: data.verification?.status === 'valid',
        },
        rawPayload: data,
      };
    },
  };
}

async function findDomain(company: string, apiKey: string): Promise<string | undefined> {
  const url = new URL('https://api.hunter.io/v2/domain-search');
  url.searchParams.set('company', company);
  url.searchParams.set('api_key', apiKey);

  const response = await fetch(url);
  if (!response.ok) return undefined;
  const json = await response.json();
  return json.data?.domain;
}
