// packages/server/src/routes/providers.ts
//
// GET /api/providers
// GET /api/providers/status
//
// Phase 17 — Optional AI and Enrichment. This route is a thin HTTP view of
// @netpro/core's provider registry: one answer, computed once, rendered by
// three surfaces (CLI `netpro status`, this endpoint, and the Web UI).
//
// The Web UI reads it to render the plan's status strips:
//
//   AI           ● Not configured
//   Enrichment   ● Hunter configured
//   Embeddings   ● Disabled
//
// Rules that matter here:
//   * No key material ever leaves — the snapshot carries booleans and where a
//     key came from ('env' | 'keychain' | 'none'), never the value.
//   * Nothing 4xx/5xxs because a provider is missing. An empty environment is
//     a valid configuration: NetPro runs offline, and the payload says which
//     enhancements are off and how to turn them on.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SqliteConn, PgConn } from '@netpro/db';
import { resolveProviderStatus } from '@netpro/core/src/providers';
import { sendJson } from '../middleware/json';
import type { AuthContext } from '../auth/index';

export type ProvidersDeps = {
  conn: SqliteConn | PgConn;
  auth: AuthContext;
};

export async function handleProviders(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ProvidersDeps
): Promise<void> {
  // Count contacts for the Index strip — drizzle-portable, no raw SQL string
  // assumptions. A live-contact count suffices for the dashboard's
  // "Search index: N contacts" strip; the real FTS5 row is dialect-specific.
  let indexContacts: number | null = null;
  let indexError: string | null = null;
  try {
    const c = deps.conn.schema.contacts;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = (await (deps.conn.db.select() as any).from(c)) as unknown[];
    indexContacts = rows.length;
  } catch (e) {
    indexError = e instanceof Error ? e.message : String(e);
  }

  const status = resolveProviderStatus(process.env);

  sendJson(res, 200, {
    // ── Legacy shape (Phase 10) — kept so Observatory/Scan keep working ──
    enrichment: {
      hunter: status.enrichment.providers.find((p) => p.id === 'hunter')?.configured ?? false,
      pdl: status.enrichment.providers.find((p) => p.id === 'pdl')?.configured ?? false,
      clearbit: status.enrichment.providers.find((p) => p.id === 'clearbit')?.configured ?? false,
      configured: status.enrichment.configured,
    },
    ai: {
      openai: status.ai.providers.find((p) => p.id === 'openai')?.configured ?? false,
      anthropic: status.ai.providers.find((p) => p.id === 'anthropic')?.configured ?? false,
      configured: status.ai.configured,
    },
    embeddings: {
      openai: status.embeddings.providers.find((p) => p.id === 'embeddings-openai')?.configured ?? false,
      configured: status.embeddings.configured,
    },
    search: {
      indexContacts,
      indexError,
    },
    /** Configured ids per category — lowercase ids, as before this phase. */
    providers: {
      enrichment: status.enrichment.providers.filter((p) => p.configured).map((p) => p.id),
      ai: status.ai.providers.filter((p) => p.configured).map((p) => p.id),
      embeddings: status.embeddings.providers.filter((p) => p.configured).map((p) => p.id),
    },

    // ── Phase 17 — the full snapshot ────────────────────────────────────
    /** Never false: an empty configuration is a supported configuration. */
    runsWithoutProviders: status.runsWithoutProviders,
    categories: status.categories,
    catalog: status.providers,
    capabilities: status.capabilities,
    degraded: status.degraded,
    warnings: status.warnings,
    generatedAt: status.generatedAt,
  });
}

// Alias for compat
export const handleProvidersStatus = handleProviders;
