import { privateEnrichmentProvider } from '@/lib/provider-privacy';
import { providerEnvironment, vaultErrorResponse } from '@/lib/vault';
import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import type { SqliteConn, PgConn } from '@netpro/db';
import { conn } from '@/lib/db';
import {
  EnrichmentPipeline,
  createHunterProvider,
  createPDLProvider,
  createClearbitProvider,
  type EnrichableContact,
} from '@netpro/core/src/enrichment';

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const all = body.all === true;
  const contactId = typeof body.contactId === 'string' ? body.contactId : undefined;

  if (!all && !contactId) {
    return NextResponse.json({ error: 'Provide either { contactId } or { all: true }' }, { status: 400 });
  }

  let env: NodeJS.ProcessEnv;
  try { env = await providerEnvironment(['enrichment.hunter', 'enrichment.pdl', 'enrichment.clearbit']); }
  catch (error) { return vaultErrorResponse(error); }
  const providers = [
    createHunterProvider(env.HUNTER_API_KEY ?? null),
    createPDLProvider(env.PDL_API_KEY ?? null),
    createClearbitProvider(env.CLEARBIT_API_KEY ?? null),
  ].map(privateEnrichmentProvider);

  const rows = await selectContacts(conn, contactId);
  const enrichableContacts: EnrichableContact[] = rows.map((c) => ({
    id: c.id,
    fullName: c.fullName,
    email: c.email,
    company: c.company,
    companyDomain: c.companyDomain,
    linkedinUrl: c.linkedinUrl,
  }));

  const pipeline = new EnrichmentPipeline(conn, providers);
  const summary = await pipeline.enrichBatch(enrichableContacts);

  return NextResponse.json(summary);
}

// NOTE: `conn.db.select()` doesn't typecheck against the raw `SqliteConn | PgConn`
// union — Drizzle's per-dialect query builders have incompatible overload sets, so
// narrowing on `conn.dialect` (rather than casting) is required. Same pattern as
// Task 2's `import/pipeline.ts` and Task 7's `enrichment/pipeline.ts`.
async function selectContacts(conn: SqliteConn | PgConn, contactId?: string) {
  if (conn.dialect === 'sqlite') {
    if (contactId) {
      return conn.db.select().from(conn.schema.contacts).where(eq(conn.schema.contacts.id, contactId));
    }
    return conn.db.select().from(conn.schema.contacts);
  }
  if (contactId) {
    return conn.db.select().from(conn.schema.contacts).where(eq(conn.schema.contacts.id, contactId));
  }
  return conn.db.select().from(conn.schema.contacts);
}
