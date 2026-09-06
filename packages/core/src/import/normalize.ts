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

// ─── Connection-date parsing (added in v1.0 Phase 3) ─────────────────────────
//
// LinkedIn's "Connected On" column is the only truthful growth timeline and
// the only interaction date an export carries. Before Phase 3 the value was
// parsed out of the CSV and discarded; analytics (growth, dormancy) needs it.

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** Build a UTC date from components, rejecting impossible ones (Feb 30, month 13). */
function utcDate(year: number, month: number, day: number): Date | undefined {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return undefined;
  if (month < 0 || month > 11 || day < 1 || day > 31) return undefined;
  const d = new Date(Date.UTC(year, month, day));
  // Round-trip check catches rollovers like Feb 30 → Mar 2.
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month || d.getUTCDate() !== day) {
    return undefined;
  }
  return d;
}

/**
 * Parse a LinkedIn "Connected On" value into an ISO-8601 UTC timestamp.
 *
 * Accepts the formats LinkedIn's export actually produces plus the ones our
 * own data round-trips through:
 * - `DD MMM YYYY`   (standard LinkedIn export, e.g. "01 Jan 2024")
 * - `MMMM D, YYYY`  (long-form, e.g. "January 5, 2024")
 * - `YYYY-MM-DD`    (ISO date — also matches datetime prefixes)
 *
 * Returns undefined for anything unparsable — callers fall back to "now"
 * rather than guessing.
 */
export function parseLinkedInDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const value = raw.trim();
  if (value.length === 0) return undefined;

  // ISO date (or datetime prefix): YYYY-MM-DD...
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (isoMatch) {
    const d = utcDate(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]));
    return d ? d.toISOString() : undefined;
  }

  // LinkedIn export: DD MMM YYYY — month names may be abbreviated or long;
  // matching on the first three letters covers both case-insensitively.
  const dmy = /^(\d{1,2})\s+([A-Za-z]{3,})\.?,?\s+(\d{4})$/.exec(value);
  if (dmy) {
    const month = MONTHS[dmy[2]!.slice(0, 3).toLowerCase()];
    const d = utcDate(Number(dmy[3]), month ?? -1, Number(dmy[1]));
    return d ? d.toISOString() : undefined;
  }

  // Long-form: MMMM D, YYYY (e.g. "January 5, 2024")
  const mdy = /^([A-Za-z]{3,})\.?\s+(\d{1,2}),\s*(\d{4})$/.exec(value);
  if (mdy) {
    const month = MONTHS[mdy[1]!.slice(0, 3).toLowerCase()];
    const d = utcDate(Number(mdy[3]), month ?? -1, Number(mdy[2]));
    return d ? d.toISOString() : undefined;
  }

  return undefined;
}
