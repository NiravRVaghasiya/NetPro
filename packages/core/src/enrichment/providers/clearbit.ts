import type { EnrichableContact, EnrichmentProvider, EnrichmentResult } from '../types';

export function createClearbitProvider(apiKey: string | null): EnrichmentProvider {
  return {
    id: 'clearbit',
    name: 'Clearbit',
    rateLimit: { requests: 50, windowMs: 24 * 60 * 60 * 1000 },
    priority: 3,
    cacheTTL: 60 * 86400,
    apiKey,

    canEnrich(contact: EnrichableContact): boolean {
      if (!apiKey) return false;
      return Boolean(contact.companyDomain || contact.company);
    },

    async enrich(contact: EnrichableContact): Promise<EnrichmentResult> {
      if (!apiKey) throw new Error('Clearbit API key not configured');

      const url = new URL('https://company.clearbit.com/v2/companies/find');
      if (contact.companyDomain) {
        url.searchParams.set('domain', contact.companyDomain);
      } else if (contact.company) {
        url.searchParams.set('name', contact.company);
      }

      const response = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!response.ok) {
        throw new Error(`Clearbit company lookup failed: ${response.status}`);
      }
      const company = await response.json();

      return {
        provider: 'clearbit',
        confidence: 0.8, // Clearbit's company-find endpoint doesn't return a match confidence
        data: {
          company: company.name,
          companyDomain: company.domain,
          industry: company.category?.industry,
        },
        rawPayload: company,
      };
    },
  };
}
