// packages/server/src/routes/scan.ts
//
// POST /api/scan
// GET  /api/scan/:id (alias: jobs)
//
// Phase 14 — Scan Visualization. The scan umbrella is reindex + enrichment +
// graph analysis in one observable sweep, and the job it creates carries the
// exact metrics the Web UI's Scan view renders:
//
//   Source                    ← job.metadata.source
//   Progress                  ← job.progress + scan.progress SSE events
//   Processed  X / Y          ← result.processed / result.total
//   New contacts              ← result.newContacts (index docs newly written)
//   Updated contacts          ← result.updatedContacts (contacts enriched)
//   Relationships discovered  ← result.relationshipsDiscovered
//   Enrichment progress       ← result.enrichment.progress
//
// Phase 16 — the route *orchestrates*; the sweep itself is `runScan` in
// @netpro/core. `netpro scan` calls that same function, so a scan started in a
// terminal and a scan started from this route are one operation with one job
// model and one event stream — the plan's rule:
//
//   One operation:
//     One core implementation
//     One job system
//     One event stream
//     Multiple interfaces
//
// Each step of the sweep is best-effort by design: a scan without configured
// providers (or without the search-index migration) still completes, exactly
// like an import without an embedding key (Phase 17: providers are optional).
//
// The ladder from the plan (Phase 7):
//   0% queued → 15% discovering → 40% processing → 70% enriching
//   → 90% indexing/graph → 100% completed

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

/**
 * The result snapshot is owned by core — the server re-exports the type so
 * route consumers and tests speak one shape.
 */
export type { ScanResult } from '@netpro/core/src/scan';

/** Who asked for the scan: the Web UI, or a terminal (`netpro scan`). */
export type ScanOrigin = 'web' | 'cli';

export async function handleScanPost(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ScanDeps
): Promise<void> {
  // Optional JSON body { source?: string, origin?: 'web' | 'cli' } names where
  // the scan came from (e.g. "linkedin_csv") and which interface triggered it.
  // Scan is trigger-only otherwise.
  let source = 'linkedin_csv';
  let origin: ScanOrigin = 'web';
  const ct = (req.headers['content-type'] ?? '').toLowerCase();
  if (ct.includes('application/json')) {
    try {
      const body = await readJsonBody(req);
      if (typeof body.source === 'string' && body.source.trim().length > 0) {
        source = body.source.trim();
      }
      if (typeof body.origin === 'string' && (body.origin === 'cli' || body.origin === 'web')) {
        origin = body.origin;
      }
      if (body.metadata && typeof body.metadata === 'object') {
        const meta = body.metadata as Record<string, unknown>;
        if (typeof meta.source === 'string' && meta.source.trim().length > 0) {
          source = meta.source.trim();
        }
        if (meta.origin === 'cli' || meta.origin === 'web') {
          origin = meta.origin as ScanOrigin;
        }
      }
    } catch {
      // Empty or invalid body is fine — scan is trigger-only.
    }
  }

  const job = deps.jobs.create({
    type: 'scan',
    metadata: { source, stage: 'queued', origin },
  });
  deps.events.publish({ type: 'scan.started', jobId: job.id, progress: 0, message: 'Scan queued', source, origin });
  deps.events.publish({ type: 'job.queued', jobId: job.id, progress: 0 });
  deps.jobs.start(job.id);
  deps.events.publish({ type: 'job.running', jobId: job.id, progress: 5 });

  let enrichmentStarted = false;

  // Dynamically imported so a route module load never pulls the whole core
  // scan/search/graph stack — and so `netpro scan` and this route call the
  // exact same function object in production.
  const { runScan } = await import('@netpro/core/src/scan');
  const result = await runScan(deps.conn, {
    source,
    onProgress: (update) => {
      // Every core stage transition becomes one job update + one SSE event,
      // which is what makes a CLI-triggered scan and a UI-triggered scan
      // indistinguishable on the stream.
      deps.jobs.updateProgress(job.id, update.progress, { stage: update.stage });
      deps.events.publish({
        type: 'scan.progress',
        jobId: job.id,
        progress: update.progress,
        message: update.message,
        stage: update.stage,
        source,
        origin,
      });
      if (update.stage === 'enriching' && !enrichmentStarted) {
        enrichmentStarted = true;
        deps.events.publish({
          type: 'enrichment.started',
          jobId: job.id,
          progress: update.progress,
          message: update.message,
        });
      }
    },
  });

  // The enrichment bookends the UI expects: `enrichment.started` before the
  // sweep's enrichment step and `enrichment.completed` at the end, whether or
  // not a provider took part.
  deps.events.publish({
    type: 'enrichment.completed',
    jobId: job.id,
    progress: result.enrichment.configured ? 90 : 70,
    message: result.enrichment.configured
      ? `Enriched ${result.enrichment.enriched} contact(s)`
      : 'Enrichment skipped — no provider configured',
    enriched: result.enrichment.enriched,
  });

  deps.jobs.complete(job.id, { result, stage: 'completed', source, origin });
  const completed = deps.jobs.get(job.id)!;
  // `result` is the same object reference stored in job.metadata.result, so
  // stamping the job's completion time here is visible to later GETs without
  // a second complete() call.
  result.completedAt = completed.completedAt;

  deps.events.publish({
    type: 'scan.completed',
    jobId: job.id,
    progress: 100,
    message: 'Scan complete',
    result,
    origin,
  });
  deps.events.publish({ type: 'job.completed', jobId: job.id, progress: 100 });
  // Phase 8 — a completed scan has at minimum touched the graph and the
  // index. The UI's Observatory, Network, and Scan views subscribe to these
  // to know when to refetch without polling.
  deps.events.publish({
    type: 'graph.updated',
    jobId: job.id,
    progress: 100,
    result: {
      nodes: result.graph.nodes,
      edges: result.graph.edges,
      communities: result.communities,
    },
    message: 'Scan completed — graph refreshed',
  });
  if (result.relationshipsDiscovered > 0) {
    deps.events.publish({
      type: 'relationship.discovered',
      jobId: job.id,
      progress: 100,
      message: `Discovered ${result.relationshipsDiscovered} relationship(s) and candidate(s)`,
      candidates: result.graph.pendingCandidates,
    });
  }
  if (result.updatedContacts > 0) {
    deps.events.publish({
      type: 'contact.updated',
      jobId: job.id,
      message: `Enriched ${result.updatedContacts} contact(s)`,
      updated: result.updatedContacts,
    });
  }

  sendJson(res, 201, { job: completed, result });
}
