// packages/server/src/routes/scan.ts
//
// POST /api/scan
// GET  /api/scan/:id (alias: jobs)
//
// The scan umbrella: reindex + enrichment + graph analysis in one observable
// sweep. Today the CLI's `netpro scan` does not exist as a single command —
// the web's \"Scan\" button (Phase 14) will drive this job. The server
// implementation is intentionally thin: it creates a job of type `scan`,
// emulates progress, and returns the same Job shape the import route does so
// the UI can poll or subscribe to /api/events without a second client code
// path.
//
// When the scan completes it publishes `scan.started/progress/completed` plus
// the generic `job.*` events. Real enrichment/graph work (Hunter/PDL,
// communities) stays behind explicit opt-in — a scan without configured
// providers still succeeds, exactly like an import without an embedding key.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SqliteConn, PgConn } from '@netpro/db';
import { sendJson, readJsonBody } from '../middleware/json';
import type { JobRegistry } from '../jobs/index';
import type { EventBus } from '../events/index';
import type { AuthContext } from '../auth/index';

export type ScanDeps = {
  conn: SqliteConn | PgConn;
  auth: AuthContext;
  jobs: JobRegistry;
  events: EventBus;
};

export async function handleScanPost(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ScanDeps
): Promise<void> {
  // Allow an optional JSON body { type?: 'import'|'enrich'|... } to seed
  // metadata, but scan is scan regardless.
  let metadata: Record<string, unknown> = {};
  const ct = (req.headers['content-type'] ?? '').toLowerCase();
  if (ct.includes('application/json')) {
    try {
      const body = await readJsonBody(req);
      if (body.metadata && typeof body.metadata === 'object') metadata = body.metadata as Record<string, unknown>;
      if (typeof body.source === 'string') metadata.source = body.source;
    } catch {
      // Empty or invalid scan body is fine — scan is trigger-only.
    }
  } else {
    // Drain non-JSON bodies so the socket can be reused.
    try {
      const { readBody } = await import('../middleware/json');
      const buf = await readBody(req);
      if (buf.length > 0) {
        try {
          const parsed = JSON.parse(buf.toString('utf-8')) as Record<string, unknown>;
          if (parsed.metadata && typeof parsed.metadata === 'object') metadata = parsed.metadata as Record<string, unknown>;
        } catch {
          // raw bytes: ignore
        }
      }
    } catch {
      // ignore
    }
  }

  const job = deps.jobs.create({ type: 'scan', metadata });
  deps.events.publish({ type: 'scan.started', jobId: job.id, progress: 0, message: 'Scan queued' });
  deps.events.publish({ type: 'job.queued', jobId: job.id, progress: 0 });
  deps.jobs.start(job.id);
  deps.events.publish({ type: 'job.running', jobId: job.id, progress: 5 });
  deps.events.publish({ type: 'scan.progress', jobId: job.id, progress: 15, message: 'Discovering contacts' });
  deps.jobs.updateProgress(job.id, 15, { stage: 'discovering' });

  // Simulate the phase ladder from the plan:
  //   0% queued → 15% discovering → 40% processing → 70% enriching → 90% indexing → 100% completed
  // In a real worker these would be await points; here they are synchronous
  // state transitions so the API returns a completed job deterministically for
  // tests. A streaming scan (Phase 8) will split this across async workers.
  deps.jobs.updateProgress(job.id, 40, { stage: 'processing' });
  deps.events.publish({ type: 'scan.progress', jobId: job.id, progress: 40, message: 'Processing' });
  deps.events.publish({ type: 'relationship.discovered', jobId: job.id, progress: 40, message: 'Processing relationships' });
  deps.jobs.updateProgress(job.id, 70, { stage: 'enriching' });
  deps.events.publish({ type: 'scan.progress', jobId: job.id, progress: 70, message: 'Enriching' });
  deps.events.publish({ type: 'enrichment.started', jobId: job.id, progress: 70, message: 'Enriching contacts' });
  deps.jobs.updateProgress(job.id, 90, { stage: 'indexing' });
  deps.events.publish({ type: 'scan.progress', jobId: job.id, progress: 90, message: 'Indexing' });
  deps.events.publish({ type: 'enrichment.completed', jobId: job.id, progress: 90, message: 'Enrichment step done' });

  // Resolve counts from the actual database so the scan result is honest:
  // the job's metadata carries a snapshot any consumer can read without a
  // second fetch.
  let counts: { contacts: number; edges?: number } | null = null;
  try {
    const { searchIndexStatus } = await import('@netpro/core/src/search');
    const status = await searchIndexStatus(deps.conn);
    // Try to also get graph size for a richer `graph.updated` event.
    let edges: number | undefined;
    try {
      const { getNetworkGraph } = await import('@netpro/core/src/graph');
      const g = await getNetworkGraph(deps.conn, {} as never);
      edges = (g as { edges?: number }).edges;
    } catch {
      edges = undefined;
    }
    counts = { contacts: status.contacts, edges };
  } catch {
    counts = null;
  }

  deps.jobs.complete(job.id, { result: counts, stage: 'completed' });
  const completed = deps.jobs.get(job.id)!;
  deps.events.publish({ type: 'scan.completed', jobId: job.id, progress: 100, result: counts });
  deps.events.publish({ type: 'job.completed', jobId: job.id, progress: 100 });
  // Phase 8 — a completed scan has at minimum touched the graph. The UI's
  // Observatory and Network views subscribe to `graph.updated` to know when to
  // refetch, without polling.
  deps.events.publish({ type: 'graph.updated', jobId: job.id, progress: 100, result: counts, message: 'Scan completed — graph refreshed' });
  if (counts && (counts.contacts > 0 || (counts.edges ?? 0) > 0)) {
    deps.events.publish({ type: 'relationship.updated', jobId: job.id, message: 'Relationships refreshed', result: counts });
  }

  sendJson(res, 201, { job: completed });
}
