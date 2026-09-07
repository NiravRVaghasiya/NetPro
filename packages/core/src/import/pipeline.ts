import { randomUUID } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import type { SqliteConn, PgConn } from '@netpro/db';
import { parseLinkedInCSV } from './linkedin-csv';
import { normalizeName, normalizeCompany, normalizeTitle, parseLinkedInDate, generateFingerprint, mergeContacts, type NormalizedContact } from './normalize';

export interface ImportError {
  row: number;
  reason: string;
}

export interface ImportSummary {
  imported: number;
  merged: number;
  errors: ImportError[];
  /** Pending mutual-network candidates surfaced for confirmation — never auto-confirmed. */
  edgeCandidates?: { candidates: number; inserted: number; skipped: number };
  /**
   * Search-index rows written for the contacts this run touched (v2.0 Phase 4).
   * Keyword-only and fully offline — embeddings are never produced by an
   * import, they need `netpro reindex --embeddings` and a configured key.
   * Absent when the index could not be written (an unmigrated database must
   * not fail an import).
   */
  indexed?: { indexed: number; skipped: number };
}

export async function runImport(csv: string, conn: SqliteConn | PgConn): Promise<ImportSummary> {
  const rawContacts = parseLinkedInCSV(csv);
  const errors: ImportError[] = [];
  const touched: string[] = [];
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

      // The "Connected On" date is when the relationship started — the only
      // truthful growth timeline and the contact's initial lastInteraction
      // (see the Phase 3 analytics spec). Undefined falls back to import time.
      const connectionDate = parseLinkedInDate(raw.connectedOn);

      if (existing) {
        const mergedContact = mergeContacts(
          { ...normalized, fullName: existing.fullName, email: existing.email ?? undefined, company: existing.company ?? undefined, role: existing.role ?? undefined, location: existing.location ?? undefined, fingerprint },
          normalized
        );
        // Backfill lastInteraction only when the existing row has none —
        // re-imports must never erase a newer recorded interaction.
        const backfillDate = existing.lastInteraction === null ? connectionDate : undefined;
        await updateContact(conn, existing.id, mergedContact, raw.linkedinUrl, backfillDate);
        touched.push(existing.id);
        merged++;
      } else {
        touched.push(await insertContact(conn, normalized, raw.linkedinUrl, connectionDate));
        imported++;
      }
    } catch (e) {
      errors.push({ row, reason: (e as Error).message });
    }
  }

  // Surface LinkedIn "Mutual connections" as pending edges for confirmation.
  // Never auto-insert confirmed graph links from an import.
  let edgeCandidates: ImportSummary['edgeCandidates'];
  try {
    const { ingestMutualCandidates } = await import('../graph/import-edges');
    edgeCandidates = await ingestMutualCandidates(conn, csv);
  } catch {
    edgeCandidates = undefined;
  }

  // Keep the search index in step with what we just wrote. Best effort by
  // design: a database that predates migration 0004 (or any index failure)
  // must not turn a successful import into a failed one — search simply falls
  // back to the portable engine until `netpro reindex` runs.
  let indexed: ImportSummary['indexed'];
  if (touched.length > 0) {
    try {
      const { reindexSearchIndex } = await import('../search/indexer');
      const result = await reindexSearchIndex(conn, { contactIds: touched });
      indexed = { indexed: result.indexed, skipped: result.skipped };
    } catch {
      indexed = undefined;
    }
  }

  return { imported, merged, errors, edgeCandidates, indexed };
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

async function insertContact(conn: SqliteConn | PgConn, normalized: NormalizedContact, linkedinUrl: string | undefined, connectionDate: string | undefined): Promise<string> {
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
    // When the CSV carries "Connected On", the relationship entered your
    // network that day — createdAt reflects acquisition, lastInteraction
    // starts at the connection itself (an accepted invite is an interaction).
    createdAt: connectionDate ?? now,
    lastInteraction: connectionDate ?? null,
    updatedAt: now,
  };

  if (conn.dialect === 'sqlite') {
    await conn.db.insert(conn.schema.contacts).values(values);
    return values.id;
  }

  await conn.db.insert(conn.schema.contacts).values(values);
  return values.id;
}

async function updateContact(conn: SqliteConn | PgConn, id: string, merged: NormalizedContact, linkedinUrl: string | undefined, backfillInteractionDate?: string): Promise<void> {
  const set = {
    fullName: merged.fullName,
    email: merged.email,
    company: merged.company,
    role: merged.role,
    seniority: merged.seniority,
    location: merged.location,
    linkedinUrl,
    updatedAt: new Date().toISOString(),
    // Backfill only when the caller asks — the pipeline passes a date solely
    // for existing rows that have no interaction recorded yet.
    ...(backfillInteractionDate ? { lastInteraction: backfillInteractionDate } : {}),
  };

  if (conn.dialect === 'sqlite') {
    await conn.db.update(conn.schema.contacts).set(set).where(eq(conn.schema.contacts.id, id));
    return;
  }

  await conn.db.update(conn.schema.contacts).set(set).where(eq(conn.schema.contacts.id, id));
}
