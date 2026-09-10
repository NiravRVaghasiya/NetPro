// packages/server/src/routes/providers.ts
//
// GET /api/providers
// GET /api/providers/status
//
// Phase 10/17 — provider/enrichment status for the Observatory and Settings.
// Exposes whether external providers are configured, without leaking the raw
// keys. The Web UI reads this to render the plan's status strips:
//
//   AI           ● Not configured
//   Enrichment   ● Hunter configured
//   Embeddings   ● Disabled
//
// The same env vars drive both CLI and server (`HUNTER_API_KEY`, `PDL_API_KEY`,
// `CLEARBIT_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` plus the
// `outreach.*` / `embeddings.*` variants).

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SqliteConn, PgConn } from '@netpro/db';
import { sendJson } from '../middleware/json';
import type { AuthContext } from '../auth/index';

export type ProvidersDeps = {
  conn: SqliteConn | PgConn;
  auth: AuthContext;
};

function hasEnv(key: string): boolean {
  const v = process.env[key];
  return typeof v === 'string' && v.trim().length > 0;
}

// Also probe netpro vault paths: embeddings.openai etc may be stored in
// ~/.netpro/config.toml rather than env. We treat non-empty env as configured;
// file-backed providers are probed lazily — when that store is not available
// we still answer correctly for the common local-first case where keys live in
// env. A future iteration can attach the vault service here.

export async function handleProviders(
  req: IncomingMessage,
  res: ServerResponse,
  _deps: ProvidersDeps
): Promise<void> {
  // Count contacts for Index status — drizzle-portable, no raw SQL string
  // assumptions. A live-contact count suffices for the dashboard's
  // "Search index: N contacts" strip; the real FTS5 row is dialect-specific.
  let indexContacts: number | null = null;
  let indexError: string | null = null;
  try {
    const c = _deps.conn.schema.contacts;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = (await (_deps.conn.db.select() as any).from(c)) as unknown[];
    indexContacts = rows.length;
  } catch (e) {
    indexError = e instanceof Error ? e.message : String(e);
  }

  const enrichment = {
    hunter: hasEnv('HUNTER_API_KEY'),
    pdl: hasEnv('PDL_API_KEY'),
    clearbit: hasEnv('CLEARBIT_API_KEY'),
  };
  const enrichmentConfigured = enrichment.hunter || enrichment.pdl || enrichment.clearbit;

  const ai = {
    openai: hasEnv('OPENAI_API_KEY') || hasEnv('NETPRO_OPENAI_KEY'),
    anthropic: hasEnv('ANTHROPIC_API_KEY') || hasEnv('NETPRO_ANTHROPIC_KEY'),
  };
  const aiConfigured = ai.openai || ai.anthropic;

  const embeddings = {
    openai: hasEnv('OPENAI_API_KEY') || hasEnv('EMBEDDINGS_OPENAI_API_KEY') || hasEnv('EMBEDDING_PROVIDER') || hasEnv('NETPRO_EMBEDDINGS'),
  };
  // embeddings enabled when an OpenAI key exists; otherwise "disabled" per Phase 17
  const embeddingsConfigured = embeddings.openai;

  sendJson(res, 200, {
    enrichment: { ...enrichment, configured: enrichmentConfigured },
    ai: { ...ai, configured: aiConfigured },
    embeddings: { ...embeddings, configured: embeddingsConfigured },
    search: {
      indexContacts,
      indexError,
      // UI hint: when indexContacts equals totalContacts the index is warm
    },
    providers: {
      enrichment: enrichmentConfigured ? Object.entries(enrichment).filter(([, v]) => v).map(([k]) => k) : [],
      ai: aiConfigured ? Object.entries(ai).filter(([, v]) => v).map(([k]) => k) : [],
      embeddings: embeddingsConfigured ? ['openai'] : [],
    },
  });
}

// Alias for compat
export const handleProvidersStatus = handleProviders;
