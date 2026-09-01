import type { Command } from 'commander';
import type { SqliteConn, PgConn } from '@netpro/db';
import {
  EnrichmentPipeline,
  createHunterProvider,
  createPDLProvider,
  createClearbitProvider,
  type EnrichableContact,
} from '@netpro/core/src/enrichment';
import { Keychain } from '../config/keychain';

export interface EnrichCommandOptions {
  source?: string;
  force?: boolean;
}

// NOTE: `conn.db.select()` doesn't typecheck against the raw `SqliteConn | PgConn`
// union — Drizzle's per-dialect query builders have incompatible overload sets, so TS
// can't call a method on the union type. Narrowing on `conn.dialect` (rather than
// casting) collapses each branch to a single concrete connection type, which resolves
// cleanly. See `packages/core/src/enrichment/cache.ts` / `pipeline.ts` for the same pattern.
async function fetchContacts(conn: SqliteConn | PgConn) {
  if (conn.dialect === 'sqlite') {
    return conn.db.select().from(conn.schema.contacts);
  }
  return conn.db.select().from(conn.schema.contacts);
}

export async function executeEnrich(options: EnrichCommandOptions, conn: SqliteConn | PgConn): Promise<string> {
  const source = options.source ?? 'all';
  const [hunterKey, pdlKey, clearbitKey] = await Promise.all([
    Keychain.get('enrichment.hunter'),
    Keychain.get('enrichment.pdl'),
    Keychain.get('enrichment.clearbit'),
  ]);

  const allProviders = [
    createHunterProvider(hunterKey),
    createPDLProvider(pdlKey),
    createClearbitProvider(clearbitKey),
  ];
  const providers = source === 'all' ? allProviders : allProviders.filter((p) => p.id === source);

  if (providers.length === 0) {
    throw new Error(`Unknown source "${source}". Expected hunter, pdl, clearbit, or all.`);
  }

  const contacts = await fetchContacts(conn);
  const enrichableContacts: EnrichableContact[] = contacts.map((c) => ({
    id: c.id,
    fullName: c.fullName,
    email: c.email,
    company: c.company,
    companyDomain: c.companyDomain,
    linkedinUrl: c.linkedinUrl,
  }));

  const pipeline = new EnrichmentPipeline(conn, providers);
  const summary = await pipeline.enrichBatch(enrichableContacts, { force: options.force });

  const lines = [`✓ Enriched ${summary.enriched} of ${contacts.length} contacts`];
  const noKeyCount = summary.skipped.filter((s) => s.reason.includes('no key configured')).length;
  if (noKeyCount > 0) {
    lines.push(
      `  ${noKeyCount} skipped: no API key configured for that provider (set one with "netpro config set enrichment.<provider> <key>")`
    );
  }
  return lines.join('\n');
}

export function registerEnrichCommand(program: Command): void {
  program
    .command('enrich')
    .description('Enrich contacts via Hunter.io, People Data Labs, or Clearbit')
    .option('--source <source>', 'hunter | pdl | clearbit | all', 'all')
    .option('--force', 'bypass the cache and re-fetch from providers')
    .action(async (options: EnrichCommandOptions) => {
      const { createDb } = await import('@netpro/db');
      try {
        const output = await executeEnrich(options, createDb());
        console.log(output);
      } catch (e) {
        console.error(`netpro enrich: ${(e as Error).message}`);
        process.exitCode = 1;
      }
    });
}
