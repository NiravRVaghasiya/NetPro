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
// The route orchestrates only — every piece of work is a `@netpro/core` call
// (reindexSearchIndex, EnrichmentPipeline, getNetworkGraph). Each step is
// best-effort by design: a scan without configured providers (or without the
// search-index migration) still completes, exactly like an import without an
// embedding key (Phase 17: external providers are optional).
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

/** The snapshot a completed scan records — mirrors the Phase 14 mockup. */
export type ScanResult = {
  source: string;
  /** Contacts the scan processed (scanned through the index). */
  processed: number;
  /** Live contacts in the workspace. */
  total: number;
  /** Search-index documents newly written (a scan's "new" signal). */
  newContacts: number;
  /** Contacts whose data changed via enrichment. */
  updatedContacts: number;
  /** Confirmed graph edges. */
  relationships: number;
  /** Pending + confirmed relationship candidates surfaced by graph analysis. */
  relationshipsDiscovered: number;
  /** Louvain communities detected. */
  communities: number;
  enrichment: {
    configured: boolean;
    enriched: number;
    /** 0 when enrichment was skipped, 100 when it ran to completion. */
    progress: number;
    skipped: number;
    error: string | null;
  };
  index: {
    scanned: number;
    indexed: number;
    skipped: number;
    pruned: number;
    keywordIndexAvailable: boolean;
  };
  startedAt: string | null;
  completedAt: string | null;
};

function providerKeys(): { hunter: boolean; pdl: boolean; clearbit: boolean } {
  return {
    hunter: Boolean(process.env.HUNTER_API_KEY?.trim()),
    pdl: Boolean(process.env.PDL_API_KEY?.trim()),
    clearbit: Boolean(process.env.CLEARBIT_API_KEY?.trim()),
  };
}

/**
 * Optional enrichment sweep. Local-first NetPro must succeed with no external
 * provider, so this returns a zero-enrichment result when no keys are present
 * or the pipeline throws. Runs on a bounded batch so a synchronous scan cannot
 * make unbounded network calls.
 */
async function runOptionalEnrichment(
  conn: SqliteConn | PgConn,
  limit = 25
): Promise<{
  configured: boolean;
  enriched: number;
  skipped: number;
  error: string | null;
}> {
  const keys = providerKeys();
  const configured = keys.hunter || keys.pdl || keys.clearbit;
  if (!configured) {
    return { configured: false, enriched: 0, skipped: 0, error: null };
  }

  try {
    // Narrow on `conn.dialect` so each branch sees a concrete connection type —
    // Drizzle's per-dialect query builders can't be called on the union (see
    // the same pattern in @netpro/core/src/import/pipeline.ts).
    let rows: Array<{ id: string; fullName: string }> = [];
    if (conn.dialect === 'sqlite') {
      const c = conn.schema.contacts;
      const found = await conn.db.select().from(c).limit(limit);
      rows = found.map((r) => ({ id: r.id, fullName: r.fullName }));
    } else {
      const c = conn.schema.contacts;
      const found = await conn.db.select().from(c).limit(limit);
      rows = found.map((r) => ({ id: r.id, fullName: r.fullName }));
    }
    if (rows.length === 0) return { configured, enriched: 0, skipped: 0, error: null };

    const { EnrichmentPipeline } = await import('@netpro/core/src/enrichment');
    const providers: unknown[] = [];
    if (keys.hunter) {
      const { createHunterProvider } = await import('@netpro/core/src/enrichment/providers/hunter');
      providers.push(createHunterProvider(process.env.HUNTER_API_KEY!));
    }
    if (keys.pdl) {
      const { createPDLProvider } = await import('@netpro/core/src/enrichment/providers/pdl');
      providers.push(createPDLProvider(process.env.PDL_API_KEY!));
    }
    if (keys.clearbit) {
      const { createClearbitProvider } = await import('@netpro/core/src/enrichment/providers/clearbit');
      providers.push(createClearbitProvider(process.env.CLEARBIT_API_KEY!));
    }

    // The pipeline constructor is core-owned; keep this orchestration tolerant
    // of provider constructor drift across phases, as the enrich route does.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pipeline: any = new (EnrichmentPipeline as any)(conn, providers);
    const result = await pipeline.enrichBatch(
      rows.map((r) => ({ id: r.id, fullName: r.fullName })),
      { force: false }
    );
    return {
      configured,
      enriched: typeof result?.enriched === 'number' ? result.enriched : 0,
      skipped: Array.isArray(result?.skipped) ? result.skipped.length : 0,
      error: null,
    };
  } catch (error) {
    return {
      configured,
      enriched: 0,
      skipped: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function handleScanPost(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ScanDeps
): Promise<void> {
  // Optional JSON body { source?: string } names where the scan is coming from
  // (e.g. "linkedin_csv", "api", "cli"). Scan is trigger-only otherwise.
  let source = 'linkedin_csv';
  const ct = (req.headers['content-type'] ?? '').toLowerCase();
  if (ct.includes('application/json')) {
    try {
      const body = await readJsonBody(req);
      if (typeof body.source === 'string' && body.source.trim().length > 0) {
        source = body.source.trim();
      }
      if (body.metadata && typeof body.metadata === 'object') {
        const meta = body.metadata as Record<string, unknown>;
        if (typeof meta.source === 'string' && meta.source.trim().length > 0) {
          source = meta.source.trim();
        }
      }
    } catch {
      // Empty or invalid body is fine — scan is trigger-only.
    }
  }

  const job = deps.jobs.create({ type: 'scan', metadata: { source, stage: 'queued' } });
  deps.events.publish({ type: 'scan.started', jobId: job.id, progress: 0, message: 'Scan queued', source });
  deps.events.publish({ type: 'job.queued', jobId: job.id, progress: 0 });
  deps.jobs.start(job.id);
  deps.events.publish({ type: 'job.running', jobId: job.id, progress: 5 });
  deps.events.publish({ type: 'scan.progress', jobId: job.id, progress: 15, message: 'Discovering contacts' });
  deps.jobs.updateProgress(job.id, 15, { stage: 'discovering' });

  const startedAt = job.startedAt;

  // ── Step 1: reindex (processing → indexing) ────────────────────────────
  deps.events.publish({ type: 'scan.progress', jobId: job.id, progress: 40, message: 'Processing contacts' });
  deps.jobs.updateProgress(job.id, 40, { stage: 'processing' });

  let index: ScanResult['index'] = {
    scanned: 0,
    indexed: 0,
    skipped: 0,
    pruned: 0,
    keywordIndexAvailable: false,
  };
  try {
    const { reindexSearchIndex, keywordIndexAvailable } = await import('@netpro/core/src/search');
    const reindex = await reindexSearchIndex(deps.conn, {});
    index = {
      scanned: reindex.scanned,
      indexed: reindex.indexed,
      skipped: reindex.skipped,
      pruned: reindex.pruned,
      keywordIndexAvailable: await keywordIndexAvailable(deps.conn),
    };
  } catch {
    // An unmigrated database must not fail a scan (mirrors runImport).
  }
  deps.events.publish({
    type: 'scan.progress',
    jobId: job.id,
    progress: 70,
    message: `Indexed ${index.indexed} contact(s)`,
    indexed: index.indexed,
  });

  // ── Step 2: enrichment (optional, external providers) ──────────────────
  deps.jobs.updateProgress(job.id, 70, { stage: 'enriching' });
  deps.events.publish({ type: 'enrichment.started', jobId: job.id, progress: 70, message: 'Enriching contacts' });
  const enrichment = await runOptionalEnrichment(deps.conn);
  deps.events.publish({
    type: 'enrichment.completed',
    jobId: job.id,
    progress: enrichment.configured ? 90 : 70,
    message: enrichment.configured
      ? `Enriched ${enrichment.enriched} contact(s)`
      : 'Enrichment skipped — no provider configured',
    enriched: enrichment.enriched,
  });

  // ── Step 3: graph analysis ─────────────────────────────────────────────
  deps.jobs.updateProgress(job.id, 90, { stage: 'indexing' });
  deps.events.publish({ type: 'scan.progress', jobId: job.id, progress: 90, message: 'Analyzing graph' });

  let graph: { nodes: number; edges: number; pendingCandidates: number; communities: number } = {
    nodes: 0,
    edges: 0,
    pendingCandidates: 0,
    communities: 0,
  };
  let totalContacts = 0;
  try {
    const { getNetworkGraph } = await import('@netpro/core/src/graph');
    const g = await getNetworkGraph(deps.conn, {});
    graph = {
      nodes: g.nodes,
      edges: g.edges,
      pendingCandidates: g.pendingCandidates,
      communities: g.communities.count,
    };
    totalContacts = g.totalContacts;
  } catch {
    // Degraded graph is acceptable — the scan still completes.
  }
  if (totalContacts === 0) {
    try {
      const { searchIndexStatus } = await import('@netpro/core/src/search');
      const status = await searchIndexStatus(deps.conn);
      totalContacts = status.contacts;
    } catch {
      totalContacts = index.scanned;
    }
  }

  const result: ScanResult = {
    source,
    processed: index.scanned || totalContacts,
    total: totalContacts,
    newContacts: index.indexed,
    updatedContacts: enrichment.enriched,
    relationships: graph.edges,
    relationshipsDiscovered: graph.pendingCandidates + graph.edges,
    communities: graph.communities,
    enrichment: {
      configured: enrichment.configured,
      enriched: enrichment.enriched,
      progress: enrichment.configured ? 100 : 0,
      skipped: enrichment.skipped,
      error: enrichment.error,
    },
    index,
    startedAt,
    completedAt: null,
  };

  deps.jobs.complete(job.id, { result, stage: 'completed', source });
  const completed = deps.jobs.get(job.id)!;
  // `result` is the same object reference stored in job.metadata.result, so
  // stamping the job's completion time here is visible to later GETs without
  // a second complete() call.
  result.completedAt = completed.completedAt;

  deps.events.publish({ type: 'scan.completed', jobId: job.id, progress: 100, result });
  deps.events.publish({ type: 'job.completed', jobId: job.id, progress: 100 });
  // Phase 8 — a completed scan has at minimum touched the graph and the
  // index. The UI's Observatory, Network, and Scan views subscribe to these
  // to know when to refetch without polling.
  deps.events.publish({
    type: 'graph.updated',
    jobId: job.id,
    progress: 100,
    result: { nodes: graph.nodes, edges: graph.edges, communities: graph.communities },
    message: 'Scan completed — graph refreshed',
  });
  if (graph.pendingCandidates > 0 || graph.edges > 0) {
    deps.events.publish({
      type: 'relationship.discovered',
      jobId: job.id,
      progress: 100,
      message: `Discovered ${graph.pendingCandidates} pending relationship candidate(s)`,
      candidates: graph.pendingCandidates,
    });
  }
  if (enrichment.enriched > 0) {
    deps.events.publish({
      type: 'contact.updated',
      jobId: job.id,
      message: `Enriched ${enrichment.enriched} contact(s)`,
      updated: enrichment.enriched,
    });
  }

  sendJson(res, 201, { job: completed, result });
}
