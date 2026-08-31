import type { RawContact } from './linkedin-csv';

export type Seniority = 'intern' | 'junior' | 'mid' | 'senior' | 'lead' | 'director' | 'vp' | 'c_level';

export interface NormalizedContact {
  fullName: string;
  firstName: string;
  lastName: string;
  email?: string;
  company?: string;
  role?: string;
  seniority?: Seniority;
  location?: string;
  fingerprint: string;
}

export function normalizeName(raw: RawContact): { firstName: string; lastName: string; fullName: string } {
  const full = raw.fullName || `${raw.firstName ?? ''} ${raw.lastName ?? ''}`.trim();

  const parts = full.includes(',')
    ? full.split(',').reverse().map((s) => s.trim())
    : full.split(/\s+/);

  return {
    firstName: raw.firstName || parts[0] || '',
    lastName: raw.lastName || parts.slice(1).join(' ') || '',
    fullName: full,
  };
}

export function normalizeCompany(raw: string | undefined): { company?: string } {
  if (!raw) return {};
  const cleaned = raw
    .replace(/,?\s*(Inc\.?|LLC|Ltd\.?|Corp\.?|GmbH|S\.A\.?|PLC)$/i, '')
    .trim();
  return { company: cleaned || undefined };
}

export function normalizeTitle(title: string | undefined): { role?: string; seniority?: Seniority } {
  if (!title) return {};

  const seniorityMap: Array<[RegExp, Seniority]> = [
    [/\b(ceo|cto|cfo|coo|chief)\b/i, 'c_level'],
    [/\b(vp|vice president)\b/i, 'vp'],
    [/\b(director)\b/i, 'director'],
    [/\b(lead|principal|staff)\b/i, 'lead'],
    [/\b(senior|sr\.?)\b/i, 'senior'],
    [/\b(junior|jr\.?|associate)\b/i, 'junior'],
    [/\b(intern)\b/i, 'intern'],
  ];

  let seniority: Seniority = 'mid';
  for (const [pattern, level] of seniorityMap) {
    if (pattern.test(title)) {
      seniority = level;
      break;
    }
  }

  const role = title
    .replace(/\b(senior|sr\.?|junior|jr\.?|lead|principal|staff|chief|vp|vice president|director)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  return { role: role || title, seniority };
}

export function generateFingerprint(contact: { email?: string; fullName?: string; company?: string }): string {
  if (contact.email) {
    return `email:${contact.email.toLowerCase()}`;
  }
  const namePart = (contact.fullName || '').toLowerCase().replace(/[^a-z]/g, '');
  const companyPart = (contact.company || '').toLowerCase().replace(/[^a-z]/g, '');
  return `name:${namePart}|company:${companyPart}`;
}

export function mergeContacts(existing: NormalizedContact, incoming: NormalizedContact): NormalizedContact {
  return {
    ...existing,
    email: incoming.email || existing.email,
    company: incoming.company || existing.company,
    role: incoming.role || existing.role,
    location: incoming.location || existing.location,
    fullName: incoming.fullName || existing.fullName,
  };
}
