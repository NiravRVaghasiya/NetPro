export interface EnrichableContact {
  id: string;
  fullName: string;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  company?: string | null;
  companyDomain?: string | null;
  linkedinUrl?: string | null;
}

export interface EnrichmentResult {
  provider: string;
  confidence: number; // 0-1
  data: Partial<{
    email: string;
    emailVerified: boolean;
    company: string;
    companyDomain: string;
    role: string;
    seniority: string;
    location: string;
    country: string;
    linkedinUrl: string;
    githubUrl: string;
    twitterUrl: string;
    industry: string;
  }>;
  rawPayload: Record<string, unknown>;
}

export interface EnrichmentProvider {
  id: string;
  name: string;
  rateLimit: { requests: number; windowMs: number };
  priority: number; // lower runs first
  cacheTTL: number; // seconds
  apiKey: string | null;
  canEnrich(contact: EnrichableContact): boolean;
  enrich(contact: EnrichableContact): Promise<EnrichmentResult>;
}
