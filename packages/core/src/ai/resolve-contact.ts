// packages/core/src/ai/resolve-contact.ts
//
// Resolve a `--to` / contactId selector (email, id, or full name) to the
// contact record the outreach engine should personalize from. One portable
// candidate query (ANSI SQL, soft-delete excluded) + pure JS resolution:
// exact email → exact id → unique case-insensitive full-name match. An
// ambiguous name errors and lists the candidates so the wrong person is
// never emailed by accident.
import { isNull, or, eq, and, sql } from 'drizzle-orm';
import type { SqliteConn, PgConn } from '@netpro/db';
import type { RecipientInput } from './prompt';

export interface ContactRef {
  id: string;
  fullName: string;
  email: string | null;
  company: string | null;
  role: string | null;
  headline: string | null;
  location: string | null;
  industry: string | null;
  linkedinUrl: string | null;
  githubUrl: string | null;
  notes: string | null;
}

async function findCandidates(
  conn: SqliteConn | PgConn,
  selector: string,
): Promise<ContactRef[]> {
  const trimmed = selector.trim();
  // Drizzle's typed builders need dialect-narrowed tables (same pattern as
  // analytics/metrics.ts); the queries themselves are plain ANSI SQL.
  if (conn.dialect === 'sqlite') {
    const t = conn.schema.contacts;
    return conn.db
      .select({
        id: t.id,
        fullName: t.fullName,
        email: t.email,
        company: t.company,
        role: t.role,
        headline: t.headline,
        location: t.location,
        industry: t.industry,
        linkedinUrl: t.linkedinUrl,
        githubUrl: t.githubUrl,
        notes: t.notes,
      })
      .from(t)
      .where(
        and(
          isNull(t.deletedAt),
          or(
            eq(t.email, trimmed),
            eq(t.id, trimmed),
            sql`lower(${t.fullName}) = ${trimmed.toLowerCase()}`,
          ),
        ),
      );
  }
  const t = conn.schema.contacts;
  return conn.db
    .select({
      id: t.id,
      fullName: t.fullName,
      email: t.email,
      company: t.company,
      role: t.role,
      headline: t.headline,
      location: t.location,
      industry: t.industry,
      linkedinUrl: t.linkedinUrl,
      githubUrl: t.githubUrl,
      notes: t.notes,
    })
    .from(t)
    .where(
      and(
        isNull(t.deletedAt),
        or(
          eq(t.email, trimmed),
          eq(t.id, trimmed),
          sql`lower(${t.fullName}) = ${trimmed.toLowerCase()}`,
        ),
      ),
    );
}

function describe(ref: ContactRef): string {
  return ref.email ? `${ref.fullName} <${ref.email}>` : ref.fullName;
}

/**
 * Resolve a selector to exactly one contact. Exact email and id matches win
 * outright; full-name matches are case-insensitive and must be unique.
 */
export async function resolveContactRef(
  conn: SqliteConn | PgConn,
  selector: string,
): Promise<ContactRef> {
  const trimmed = selector.trim();
  const candidates = await findCandidates(conn, trimmed);

  const byEmail = candidates.find((c) => c.email === trimmed);
  if (byEmail) return byEmail;

  const byId = candidates.find((c) => c.id === trimmed);
  if (byId) return byId;

  const needle = trimmed.toLowerCase();
  const byName = candidates.filter((c) => c.fullName.trim().toLowerCase() === needle);
  if (byName.length === 1) return byName[0]!;

  if (byName.length > 1) {
    throw new Error(
      `Ambiguous contact "${trimmed}" — ${byName.length} contacts share that name: ` +
        `${byName.map(describe).join('; ')}. Pick one by email or id (see "netpro search").`,
    );
  }

  throw new Error(
    `No contact matches "${trimmed}". Use an exact email or contact id, or check ` +
      `"netpro search --q <name>".`,
  );
}

/** Fetch a single non-deleted contact by id, or null when not found. */
export async function getContactById(
  conn: SqliteConn | PgConn,
  id: string,
): Promise<ContactRef | null> {
  if (conn.dialect === 'sqlite') {
    const t = conn.schema.contacts;
    const rows = await conn.db
      .select({
        id: t.id,
        fullName: t.fullName,
        email: t.email,
        company: t.company,
        role: t.role,
        headline: t.headline,
        location: t.location,
        industry: t.industry,
        linkedinUrl: t.linkedinUrl,
        githubUrl: t.githubUrl,
        notes: t.notes,
      })
      .from(t)
      .where(and(isNull(t.deletedAt), eq(t.id, id.trim())));
    return (rows[0] ?? null) as ContactRef | null;
  }
  const t = conn.schema.contacts;
  const rows = await conn.db
    .select({
      id: t.id,
      fullName: t.fullName,
      email: t.email,
      company: t.company,
      role: t.role,
      headline: t.headline,
      location: t.location,
      industry: t.industry,
      linkedinUrl: t.linkedinUrl,
      githubUrl: t.githubUrl,
      notes: t.notes,
    })
    .from(t)
    .where(and(isNull(t.deletedAt), eq(t.id, id.trim())));
  return (rows[0] ?? null) as ContactRef | null;
}

/** Map a stored contact to the recipient facts used by the outreach engine. */
export function contactToRecipientInput(ref: ContactRef): RecipientInput {
  return {
    name: ref.fullName,
    email: ref.email ?? undefined,
    company: ref.company ?? undefined,
    role: ref.role ?? undefined,
    headline: ref.headline ?? undefined,
    location: ref.location ?? undefined,
    industry: ref.industry ?? undefined,
    linkedinUrl: ref.linkedinUrl ?? undefined,
    githubUrl: ref.githubUrl ?? undefined,
    notes: ref.notes ?? undefined,
  };
}
