import type { EnrichableContact, EnrichmentProvider, EnrichmentResult } from '../types';

const SENIORITY_MAP: Record<string, string> = {
  intern: 'intern', entry: 'junior', senior: 'senior', manager: 'lead',
  director: 'director', vp: 'vp', cxo: 'c_level', owner: 'c_level',
};
const SENIORITY_RANK = ['intern', 'entry', 'senior', 'manager', 'director', 'vp', 'cxo', 'owner'];

export function createPDLProvider(apiKey: string | null): EnrichmentProvider {
  return {
    id: 'pdl',
    name: 'People Data Labs',
    rateLimit: { requests: 100, windowMs: 30 * 24 * 60 * 60 * 1000 }, // free tier: ~100/mo
    priority: 2,
    cacheTTL: 60 * 86400,
    apiKey,

    canEnrich(contact: EnrichableContact): boolean {
      if (!apiKey) return false;
      return Boolean(contact.linkedinUrl || contact.email || (contact.fullName && contact.company));
    },

    async enrich(contact: EnrichableContact): Promise<EnrichmentResult> {
      if (!apiKey) throw new Error('People Data Labs API key not configured');

      const url = new URL('https://api.peopledatalabs.com/v5/person/enrich');
      if (contact.linkedinUrl) url.searchParams.set('profile', contact.linkedinUrl);
      if (contact.email) url.searchParams.set('email', contact.email);
      if (contact.fullName) url.searchParams.set('name', contact.fullName);
      if (contact.company) url.searchParams.set('company', contact.company);

      const response = await fetch(url, { headers: { 'X-Api-Key': apiKey } });
      if (!response.ok) {
        throw new Error(`People Data Labs enrich failed: ${response.status}`);
      }
      const person = await response.json();

      return {
        provider: 'pdl',
        confidence: typeof person.likelihood === 'number' ? person.likelihood / 10 : 0.5,
        data: {
          email: person.work_email || person.personal_emails?.[0],
          company: person.job_company_name,
          role: person.job_title,
          seniority: mapSeniority(person.job_title_levels),
          location: person.location_name,
          country: person.location_country,
          linkedinUrl: person.linkedin_url,
          githubUrl: person.github_url,
          twitterUrl: person.twitter_url,
        },
        rawPayload: person,
      };
    },
  };
}

function mapSeniority(levels: string[] | undefined): string | undefined {
  if (!levels || levels.length === 0) return undefined;
  const highest = levels.reduce(
    (best, level) => (SENIORITY_RANK.indexOf(level) > SENIORITY_RANK.indexOf(best) ? level : best),
    levels[0]!
  );
  return SENIORITY_MAP[highest] ?? undefined;
}
