import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@netpro/db/src/schema.sqlite';
import type { SqliteConn } from '@netpro/db';
import { resolveContactRef, contactToRecipientInput } from './resolve-contact';

function createTestConn(): SqliteConn {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite, { schema });
  sqlite.exec(`
    CREATE TABLE contacts (
      id TEXT PRIMARY KEY, full_name TEXT NOT NULL, first_name TEXT, last_name TEXT,
      email TEXT, email_verified INTEGER DEFAULT 0, phone TEXT, avatar_url TEXT,
      headline TEXT, company TEXT, company_domain TEXT, role TEXT, seniority TEXT,
      department TEXT, industry TEXT, location TEXT, country TEXT, timezone TEXT,
      linkedin_url TEXT, github_url TEXT, twitter_url TEXT, website_url TEXT,
      source TEXT NOT NULL, source_id TEXT, tags TEXT, custom_fields TEXT, notes TEXT,
      relationship_score REAL DEFAULT 0, last_interaction TEXT, interaction_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
    );
  `);
  return { dialect: 'sqlite', db, schema };
}

interface Seed {
  id: string;
  fullName: string;
  email?: string | null;
  company?: string | null;
  role?: string | null;
  deletedAt?: string | null;
}

const SEED: Seed[] = [
  { id: 'uuid-1', fullName: 'Jane Doe', email: 'jane@stripe.com', company: 'Stripe', role: 'Engineer' },
  { id: 'uuid-2', fullName: 'John Smith', email: 'john@vercel.com', company: 'Vercel', role: 'Designer' },
  { id: 'uuid-3', fullName: 'Jane Doe', email: 'jane.doe@example.com', company: 'Acme' },
  { id: 'uuid-4', fullName: 'Ghost User', email: 'ghost@nowhere.com', deletedAt: '2026-01-01T00:00:00Z' },
];

async function seed(conn: SqliteConn): Promise<void> {
  const now = new Date().toISOString();
  for (const s of SEED) {
    await conn.db.insert(conn.schema.contacts).values({
      id: s.id,
      fullName: s.fullName,
      email: s.email ?? null,
      company: s.company ?? null,
      role: s.role ?? null,
      source: 'test',
      createdAt: now,
      updatedAt: now,
      deletedAt: s.deletedAt ?? null,
    });
  }
}

describe('resolveContactRef', () => {
  let conn: SqliteConn;
  beforeEach(async () => {
    conn = createTestConn();
    await seed(conn);
  });

  it('resolves by exact email', async () => {
    const ref = await resolveContactRef(conn, 'john@vercel.com');
    expect(ref.id).toBe('uuid-2');
    expect(ref.fullName).toBe('John Smith');
  });

  it('resolves by id', async () => {
    const ref = await resolveContactRef(conn, 'uuid-2');
    expect(ref.email).toBe('john@vercel.com');
  });

  it('resolves by unique full name (case-insensitive, trimmed)', async () => {
    const ref = await resolveContactRef(conn, '  john smith ');
    expect(ref.id).toBe('uuid-2');
  });

  it('errors and lists candidates when the name is ambiguous', async () => {
    await expect(resolveContactRef(conn, 'Jane Doe')).rejects.toThrow(/Ambiguous contact/);
    await expect(resolveContactRef(conn, 'Jane Doe')).rejects.toThrow(/jane@stripe\.com/);
    await expect(resolveContactRef(conn, 'Jane Doe')).rejects.toThrow(/jane\.doe@example\.com/);
  });

  it('errors with a hint when nothing matches', async () => {
    await expect(resolveContactRef(conn, 'nobody@nowhere.com')).rejects.toThrow(
      /No contact matches "nobody@nowhere\.com"/,
    );
  });

  it('excludes soft-deleted contacts', async () => {
    await expect(resolveContactRef(conn, 'ghost@nowhere.com')).rejects.toThrow(/No contact matches/);
  });

  it('maps a contact to recipient input for the engine', () => {
    const input = contactToRecipientInput({
      id: 'uuid-2',
      fullName: 'John Smith',
      email: 'john@vercel.com',
      company: 'Vercel',
      role: 'Designer',
      headline: null,
      location: null,
      industry: null,
      linkedinUrl: null,
      githubUrl: null,
      notes: null,
    });
    expect(input).toEqual({
      name: 'John Smith',
      email: 'john@vercel.com',
      company: 'Vercel',
      role: 'Designer',
      headline: undefined,
      location: undefined,
      industry: undefined,
      linkedinUrl: undefined,
      githubUrl: undefined,
      notes: undefined,
    });
  });
});
