import { randomUUID } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import type { SqliteConn, PgConn } from '@netpro/db';
import { parseLinkedInCSV } from './linkedin-csv';
import { normalizeName, normalizeCompany, normalizeTitle, generateFingerprint, mergeContacts, type NormalizedContact } from './normalize';

export interface ImportError {
  row: number;
  reason: string;
}

export interface ImportSummary {
  imported: number;
  merged: number;
  errors: ImportError[];
}

export async function runImport(csv: string, conn: SqliteConn | PgConn): Promise<ImportSummary> {
  const rawContacts = parseLinkedInCSV(csv);
  const errors: ImportError[] = [];
  let imported = 0;
  let merged = 0;

  for (const [index, raw] of rawContacts.entries()) {
    const row = index + 2; // +1 for 0-index, +1 for the header row
    try {
      const { firstName, lastName, fullName } = normalizeName(raw);
      if (!fullName) {
        errors.push({ row, reason: 'missing name' });
        continue;
      }

      const { company } = normalizeCompany(raw.company);
      const { role, seniority } = normalizeTitle(raw.position);
      const fingerprint = generateFingerprint({ email: raw.email, fullName, company });

      const normalized: NormalizedContact = {
        fullName, firstName, lastName,
        email: raw.email, company, role, seniority,
        location: raw.location,
        fingerprint,
      };

      const existing = await findExistingContact(conn, normalized);

      if (existing) {
        const mergedContact = mergeContacts(
          { ...normalized, fullName: existing.fullName, email: existing.email ?? undefined, company: existing.company ?? undefined, role: existing.role ?? undefined, location: existing.location ?? undefined, fingerprint },
          normalized
        );
        await updateContact(conn, existing.id, mergedContact, raw.linkedinUrl);
        merged++;
      } else {
        await insertContact(conn, normalized, raw.linkedinUrl);
        imported++;
      }
    } catch (e) {
      errors.push({ row, reason: (e as Error).message });
    }
  }

  return { imported, merged, errors };
}

// NOTE: `conn.db.select()`/`.insert()`/`.update()` don't typecheck against the raw
// `SqliteConn | PgConn` union — Drizzle's per-dialect query builders have incompatible
// overload sets, so TS can't call a method on the union type. Narrowing on
// `conn.dialect` (rather than casting) collapses each branch to a single concrete
// connection type, which resolves cleanly. The query logic is intentionally
// duplicated in each branch — see Task 2 brief / packages/db discriminated union.
async function findExistingContact(conn: SqliteConn | PgConn, normalized: NormalizedContact) {
  if (conn.dialect === 'sqlite') {
    if (normalized.email) {
      const rows = await conn.db.select().from(conn.schema.contacts).where(eq(conn.schema.contacts.email, normalized.email)).limit(1);
      if (rows[0]) return rows[0];
    }
    if (normalized.company) {
      const rows = await conn.db.select().from(conn.schema.contacts)
        .where(and(eq(conn.schema.contacts.fullName, normalized.fullName), eq(conn.schema.contacts.company, normalized.company)))
        .limit(1);
      if (rows[0]) return rows[0];
    }
    return null;
  }

  if (normalized.email) {
    const rows = await conn.db.select().from(conn.schema.contacts).where(eq(conn.schema.contacts.email, normalized.email)).limit(1);
    if (rows[0]) return rows[0];
  }
  if (normalized.company) {
    const rows = await conn.db.select().from(conn.schema.contacts)
      .where(and(eq(conn.schema.contacts.fullName, normalized.fullName), eq(conn.schema.contacts.company, normalized.company)))
      .limit(1);
    if (rows[0]) return rows[0];
  }
  return null;
}

async function insertContact(conn: SqliteConn | PgConn, normalized: NormalizedContact, linkedinUrl: string | undefined): Promise<void> {
  const now = new Date().toISOString();
  const values = {
    id: randomUUID(),
    fullName: normalized.fullName,
    firstName: normalized.firstName,
    lastName: normalized.lastName,
    email: normalized.email,
    company: normalized.company,
    role: normalized.role,
    seniority: normalized.seniority,
    location: normalized.location,
    linkedinUrl,
    source: 'linkedin_csv',
    createdAt: now,
    updatedAt: now,
  };

  if (conn.dialect === 'sqlite') {
    await conn.db.insert(conn.schema.contacts).values(values);
    return;
  }

  await conn.db.insert(conn.schema.contacts).values(values);
}

async function updateContact(conn: SqliteConn | PgConn, id: string, merged: NormalizedContact, linkedinUrl: string | undefined): Promise<void> {
  const set = {
    fullName: merged.fullName,
    email: merged.email,
    company: merged.company,
    role: merged.role,
    seniority: merged.seniority,
    location: merged.location,
    linkedinUrl,
    updatedAt: new Date().toISOString(),
  };

  if (conn.dialect === 'sqlite') {
    await conn.db.update(conn.schema.contacts).set(set).where(eq(conn.schema.contacts.id, id));
    return;
  }

  await conn.db.update(conn.schema.contacts).set(set).where(eq(conn.schema.contacts.id, id));
}
