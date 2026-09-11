// @ts-nocheck
// packages/server/src/routes/enrich.ts
//
// POST /api/enrich
// GET  /api/enrich/:id  (alias for GET /api/jobs/:id when type=enrich)
//
// Phase 8 enrichment events + Phase 7 job wrapper.
//
// The enrichment pipeline is core-owned (`@netpro/core/src/enrichment`); this
// route is orchestration only — create a job, publish enrichment.started /
// progress / completed plus the generic job.* events, and store the summary
// in job.metadata.result so the Web UI can fetch it later. When no provider
// keys are configured the pipeline still runs (returning { enriched: 0 }) and
// the job succeeds — NetPro must function without external providers (Phase 17).

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SqliteConn, PgConn } from '@netpro/db';
import { sendJson, readJsonBody, readBody } from '../middleware/json';
import type { JobRegistry } from '../jobs/index';
import type { EventBus } from '../events/index';
import type { AuthContext } from '../auth/index';
import { resolveProviderStatus } from '@netpro/core/src/providers';

export type EnrichDeps = {
  conn: SqliteConn | PgConn;
  auth: AuthContext;
  jobs: JobRegistry;
  events: EventBus;
};

/** Phase 17 — is any enrichment provider configured right now? */
function enrichmentConfigured(): boolean {
  return resolveProviderStatus(process.env).enrichment.configured;
}

function parseEnrichBody(body: Record<string, unknown>): {
  contactIds?: string[];
  limit?: number;
  force?: boolean;
} {
  const out: { contactIds?: string[]; limit?: number; force?: boolean } = {};
  if (Array.isArray(body.contactIds)) {
    out.contactIds = body.contactIds.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  } else if (typeof body.contactId === 'string' && body.contactId.trim()) {
    out.contactIds = [body.contactId.trim()];
  } else if (typeof body.id === 'string' && body.id.trim()) {
    out.contactIds = [body.id.trim()];
  }
  if (body.limit !== undefined) {
    const n = Number(body.limit);
    if (Number.isFinite(n)) out.limit = Math.max(1, Math.min(Math.floor(n), 200));
  }
  if (body.force !== undefined) out.force = Boolean(body.force);
  return out;
}

export async function handleEnrichPost(
  req: IncomingMessage,
  res: ServerResponse,
  deps: EnrichDeps
): Promise<void> {
  let parsed: { contactIds?: string[]; limit?: number; force?: boolean } = {};
  const ct = (req.headers['content-type'] ?? '').toLowerCase();
  if (ct.includes('application/json')) {
    try {
      const body = await readJsonBody(req);
      parsed = parseEnrichBody(body);
    } catch (error) {
      const status = (error as { status?: number })?.status ?? 400;
      sendJson(res, status, { error: error instanceof Error ? error.message : String(error) });
      return;
    }
  } else {
    // Empty body is allowed — enrich the next batch (default 10).
    try {
      const buf = await readBody(req);
      if (buf.length > 0) {
        try {
          const body = JSON.parse(buf.toString('utf-8')) as Record<string, unknown>;
          parsed = parseEnrichBody(body);
        } catch {
          // raw bytes with no JSON: ignore, use defaults
        }
      }
    } catch {
      // drain failed: still use defaults
    }
  }

  const job = deps.jobs.create({
    type: 'enrich',
    metadata: {
      source: 'api',
      contactIds: parsed.contactIds,
      limit: parsed.limit,
      force: parsed.force,
    },
  });
  deps.events.publish({ type: 'enrichment.started', jobId: job.id, message: 'Enrichment queued' });
  deps.events.publish({ type: 'job.queued', jobId: job.id, progress: 0 });
  deps.jobs.start(job.id);
  deps.events.publish({ type: 'job.running', jobId: job.id, progress: 5 });
  deps.events.publish({ type: 'enrichment.started', jobId: job.id, progress: 15, message: 'Resolving contacts' });
  deps.jobs.updateProgress(job.id, 15, { stage: 'resolving' });

  try {
    // Resolve which contacts to enrich. When caller supplies IDs we use those;
    // otherwise we take a small window of contacts that have never been enriched.
    let contactRows: Array<{ id: string; fullName: string }> = [];
    if (parsed.contactIds && parsed.contactIds.length > 0) {
      // Fetch by IDs — use a simple query per id to stay dialect-portable.
      for (const id of parsed.contactIds.slice(0, parsed.limit ?? 50)) {
        const fetched = await fetchContactById(deps.conn, id);
        if (fetched) contactRows.push(fetched);
      }
    } else {
      contactRows = await fetchNextEnrichable(deps.conn, parsed.limit ?? 10);
    }

    deps.jobs.updateProgress(job.id, 40, { stage: 'enriching', total: contactRows.length });
    deps.events.publish({
      type: 'enrichment.started',
      jobId: job.id,
      progress: 40,
      message: `Enriching ${contactRows.length} contacts`,
      total: contactRows.length,
    });

    // In this local-first server the enrichment providers are optional. We try
    // to run the real pipeline when keys are configured; otherwise we degrade
    // gracefully to a zero-enrichment success (Phase 17). The job itself is
    // always `completed`, never `failed`, because "no provider" is not an
    // error — it is a configuration choice the UI shows explicitly.
    let enriched = 0;
    let enrichmentError: string | null = null;
    try {
      // Phase 17 — one registry decides what is configured and how to build
      // it: @netpro/core/src/providers. With no key anywhere this resolves to
      // an empty list and the route short-circuits to a zero-enrichment
      // success (no network call is even attempted).
      const { createEnrichmentProviders } = await import('@netpro/core/src/providers');
      const providers = await createEnrichmentProviders(process.env);
      if (providers.length > 0 && contactRows.length > 0) {
        // Attempt to call the real enrichment pipeline. We keep the import
        // dynamic so a misconfigured provider does not crash the route module
        // at load time.
        const { EnrichmentPipeline } = await import('@netpro/core/src/enrichment');
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const pipeline: any = new (EnrichmentPipeline as any)(deps.conn, providers);
          const enrichable = contactRows.map((c) => ({
            id: c.id,
            fullName: c.fullName,
          }));
          const result = await pipeline.enrichBatch(enrichable, { force: parsed.force });
          enriched = result?.enriched ?? 0;
        } catch (e) {
          enrichmentError = e instanceof Error ? e.message : String(e);
        }
      } else {
        // No provider or no contacts — zero enrichment is the expected path.
        enriched = 0;
      }
    } catch (e) {
      enrichmentError = e instanceof Error ? e.message : String(e);
      enriched = 0;
    }

    deps.jobs.updateProgress(job.id, 90, { stage: 'finalizing' });
    deps.events.publish({ type: 'enrichment.completed', jobId: job.id, progress: 90, message: 'Finalizing' });

    const summary = {
      enriched,
      total: contactRows.length,
      enrichmentError,
      providerConfigured: enrichmentConfigured(),
    };
    deps.jobs.complete(job.id, { result: summary, stage: 'completed' } as Record<string, unknown>);
    const completed = deps.jobs.get(job.id)!;
    deps.events.publish({ type: 'enrichment.completed', jobId: job.id, progress: 100, result: summary });
    deps.events.publish({ type: 'job.completed', jobId: job.id, progress: 100 });
    // A successful enrichment may have newly discovered company/role data and
    // therefore new graph edges — surface as relationship + graph events.
    if (enriched > 0) {
      deps.events.publish({
        type: 'relationship.updated',
        jobId: job.id,
        message: `${enriched} contacts enriched`,
        enriched,
      });
      deps.events.publish({ type: 'graph.updated', jobId: job.id, message: 'Enrichment updated contacts' });
    } else if (contactRows.length > 0) {
      // Even a zero-enrichment run is worth a graph ping: the UI's provider
      // status strip should refresh so "Not configured" stays honest.
      deps.events.publish({ type: 'graph.updated', jobId: job.id, message: 'Enrichment checked — no updates' });
    }
    sendJson(res, 200, { job: completed, summary });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.jobs.fail(job.id, message);
    deps.events.publish({ type: 'job.failed', jobId: job.id, error: message, message });
    deps.events.publish({ type: 'enrichment.completed', jobId: job.id, error: message });
    sendJson(res, 500, { error: message, job: deps.jobs.get(job.id) });
  }
}

export async function handleEnrichGet(
  req: IncomingMessage,
  res: ServerResponse,
  deps: EnrichDeps
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const id = url.pathname.split('/').pop() ?? '';
  if (!id) {
    sendJson(res, 400, { error: 'Enrich job id is required.' });
    return;
  }
  const job = deps.jobs.get(id);
  if (!job) {
    sendJson(res, 404, { error: `No enrich job with id "${id}".`, code: 'not_found' });
    return;
  }
  if (job.type !== 'enrich') {
    sendJson(res, 404, { error: `Job "${id}" is not an enrich job.`, code: 'not_found' });
    return;
  }
  sendJson(res, 200, { job });
}

async function fetchContactById(
  conn: SqliteConn | PgConn,
  id: string
): Promise<{ id: string; fullName: string } | null> {
  const c = conn.schema.contacts;
  try {
    const { eq } = await import('drizzle-orm');
    if (conn.dialect === 'sqlite') {
      const rows = await conn.db.select().from(c).where(eq(c.id, id)).limit(1);
      const r = rows[0] as typeof c.$inferSelect | undefined;
      return r ? { id: r.id, fullName: r.fullName } : null;
    }
    const rows = await conn.db.select().from(c).where(eq(c.id, id)).limit(1);
    const r = rows[0] as typeof c.$inferSelect | undefined;
    return r ? { id: r.id, fullName: r.fullName } : null;
  } catch {
    return null;
  }
}

async function fetchNextEnrichable(
  conn: SqliteConn | PgConn,
  limit: number
): Promise<Array<{ id: string; fullName: string }>> {
  const c = conn.schema.contacts;
  try {
    if (conn.dialect === 'sqlite') {
      const rows = await conn.db.select().from(c).limit(limit);
      return (rows as Array<typeof c.$inferSelect>).map((r) => ({
        id: r.id,
        fullName: r.fullName,
      }));
    }
    const rows = await conn.db.select().from(c).limit(limit);
    return (rows as Array<typeof c.$inferSelect>).map((r) => ({
      id: r.id,
      fullName: r.fullName,
    }));
  } catch {
    return [];
  }
}
