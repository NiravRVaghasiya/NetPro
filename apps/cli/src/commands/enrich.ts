import type { Command } from "commander";
import type { SqliteConn, PgConn } from "@netpro/db";
import {
  EnrichmentPipeline,
  createHunterProvider,
  createPDLProvider,
  createClearbitProvider,
  type EnrichableContact,
} from "@netpro/core/src/enrichment";
import {
  workspacePredicate,
  type WorkspaceScope,
} from "@netpro/core/src/workspaces/scope";
import { Keychain } from "../config/keychain";

export interface EnrichCommandOptions {
  source?: string;
  force?: boolean;
}

export async function executeEnrich(
  options: EnrichCommandOptions,
  conn: SqliteConn | PgConn,
  scope?: WorkspaceScope,
): Promise<string> {
  const source = options.source ?? "all";
  const [hunterKey, pdlKey, clearbitKey] = await Promise.all([
    Keychain.get("enrichment.hunter"),
    Keychain.get("enrichment.pdl"),
    Keychain.get("enrichment.clearbit"),
  ]);

  const allProviders = [
    createHunterProvider(hunterKey),
    createPDLProvider(pdlKey),
    createClearbitProvider(clearbitKey),
  ];
  const providers =
    source === "all"
      ? allProviders
      : allProviders.filter((p) => p.id === source);

  if (providers.length === 0) {
    throw new Error(
      `Unknown source "${source}". Expected hunter, pdl, clearbit, or all.`,
    );
  }

  const contacts = await listContacts(conn, scope);
  const enrichableContacts: EnrichableContact[] = contacts.map((c) => ({
    id: c.id,
    fullName: c.fullName,
    email: c.email,
    company: c.company,
    companyDomain: c.companyDomain,
    linkedinUrl: c.linkedinUrl,
  }));

  const pipeline = new EnrichmentPipeline(conn, providers, scope);
  const summary = await pipeline.enrichBatch(enrichableContacts, {
    force: options.force,
  });

  const lines = [
    `✓ Enriched ${summary.enriched} of ${contacts.length} contacts`,
  ];
  const noKeyCount = summary.skipped.filter((s) =>
    s.reason.includes("no key configured"),
  ).length;
  if (noKeyCount > 0) {
    lines.push(
      `  ${noKeyCount} skipped: no API key configured for that provider (set one with "netpro config set enrichment.<provider> <key>")`,
    );
  }
  return lines.join("\n");
}

// NOTE: `conn.db.select()` doesn't typecheck against the raw `SqliteConn | PgConn`
// union — Drizzle's per-dialect query builders have incompatible overload sets, so
// narrowing on `conn.dialect` (rather than casting) is required. Same pattern as
// Task 2's `import/pipeline.ts` and Task 7's `enrichment/pipeline.ts`.
async function listContacts(conn: SqliteConn | PgConn, scope?: WorkspaceScope) {
  if (conn.dialect === "sqlite") {
    return conn.db
      .select()
      .from(conn.schema.contacts)
      .where(workspacePredicate(scope, conn.schema.contacts.workspaceId));
  }
  return conn.db
    .select()
    .from(conn.schema.contacts)
    .where(workspacePredicate(scope, conn.schema.contacts.workspaceId));
}

export function registerEnrichCommand(program: Command): void {
  const cmd = program
    .command("enrich")
    .description("Enrich contacts via Hunter.io, People Data Labs, or Clearbit")
    .option("--source <source>", "hunter | pdl | clearbit | all", "all")
    .option("--force", "bypass the cache and re-fetch from providers")
    .action(async (options: EnrichCommandOptions) => {
      const { openDb, resolveCliScope } = await import("../db");
      try {
        const conn = await openDb();
        const scope = await resolveCliScope(cmd, conn);
        const output = await executeEnrich(options, conn, scope);
        console.log(output);
      } catch (e) {
        console.error(`netpro enrich: ${(e as Error).message}`);
        process.exitCode = 1;
      }
    });
}
