// packages/core/src/scan/index.ts
//
// Phase 16 — CLI ↔ Web UI integration: ONE scan implementation.
//
// The plan's rule, verbatim:
//
//   One operation:
//     One core implementation
//     One job system
//     One event stream
//     Multiple interfaces
//
// Until this module existed the scan pipeline lived inside the server route
// (`packages/server/src/routes/scan.ts`), so `netpro scan` had nothing to call
// and the Web UI's scan was the only scan. Now:
//
//   `runScan` (here)              ← the one implementation
//        ▲                   ▲
//        │                   │
//   server POST /api/scan    `netpro scan` (CLI)
//   (Job + SSE events)       (same Job model, events forwarded to the server)
//
// A scan is one observable sweep — reindex + enrichment + graph analysis — and
// every step is best-effort by design: a scan with no providers configured (or
// on an unmigrated database) still completes and still reports real numbers.
// That is Phase 17's rule applied here: external providers are optional.

import type { SqliteConn, PgConn } from "@netpro/db";
import type { WorkspaceScope } from "../workspaces/scope";
import { reindexSearchIndex, keywordIndexAvailable, searchIndexStatus } from "../search";
import { getNetworkGraph } from "../graph";
import { EnrichmentPipeline, type EnrichmentProvider } from "../enrichment";
import {
  createEnrichmentProviders,
  resolveProviderStatus,
  type KeychainValues,
  type ProviderStatusSnapshot,
} from "../providers";

type Conn = SqliteConn | PgConn;

/** Where a scan thinks its contacts came from. Informational only. */
export const DEFAULT_SCAN_SOURCE = "linkedin_csv";

export const SCAN_STAGES = [
  "queued",
  "discovering",
  "processing",
  "enriching",
  "indexing",
  "completed",
] as const;

export type ScanStage = (typeof SCAN_STAGES)[number];

export interface ScanProgressUpdate {
  stage: ScanStage;
  /** 0–100. */
  progress: number;
  message: string;
}

export interface ScanIndexSummary {
  scanned: number;
  indexed: number;
  skipped: number;
  pruned: number;
  keywordIndexAvailable: boolean;
}

export interface ScanEnrichmentSummary {
  configured: boolean;
  /** Provider labels that took part, e.g. ["Hunter"]. */
  providers: string[];
  enriched: number;
  /** 0 when enrichment was skipped, 100 when it ran to completion. */
  progress: number;
  skipped: number;
  error: string | null;
}

export interface ScanGraphSummary {
  nodes: number;
  edges: number;
  pendingCandidates: number;
  communities: number;
}

export interface ScanResult {
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
  enrichment: ScanEnrichmentSummary;
  index: ScanIndexSummary;
  graph: ScanGraphSummary;
  /** Phase 17 — provider status as it was when the scan ran. */
  providers: ProviderStatusSnapshot | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ScanOptions {
  /** Where the scan's data comes from (default `linkedin_csv`). */
  source?: string;
  scope?: WorkspaceScope;
  /** Set false to skip enrichment even when providers are configured. */
  enrich?: boolean;
  /** Max contacts to enrich in one sweep (default 25, so a scan cannot make
   * unbounded network calls). */
  enrichLimit?: number;
  /** Provider environment (default `process.env`). */
  env?: Record<string, string | undefined>;
  /** CLI keychain values, if the caller decrypted them. */
  keychain?: KeychainValues;
  /** Called on every stage transition — the CLI prints these, the server
   * publishes them as `scan.progress` events over SSE. */
  onProgress?: (update: ScanProgressUpdate) => void;
  /** Injectable clock (tests). */
  now?: () => Date;
}

const DEFAULT_ENRICH_LIMIT = 25;

const EMPTY_INDEX: ScanIndexSummary = {
  scanned: 0,
  indexed: 0,
  skipped: 0,
  pruned: 0,
  keywordIndexAvailable: false,
};

const EMPTY_GRAPH: ScanGraphSummary = {
  nodes: 0,
  edges: 0,
  pendingCandidates: 0,
  communities: 0,
};

/**
 * Step 1 — reindex. Never throws: an unmigrated database reports zeros and the
 * scan moves on, exactly like `runImport` treats a missing FTS table.
 */
async function runIndexStep(conn: Conn, options: ScanOptions): Promise<ScanIndexSummary> {
  try {
    const reindex = await reindexSearchIndex(conn, {}, options.scope);
    let available = false;
    try {
      available = await keywordIndexAvailable(conn);
    } catch {
      available = false;
    }
    return {
      scanned: reindex.scanned,
      indexed: reindex.indexed,
      skipped: reindex.skipped,
      pruned: reindex.pruned,
      keywordIndexAvailable: available,
    };
  } catch {
    return { ...EMPTY_INDEX };
  }
}

/**
 * Step 2 — enrichment. Optional in the strongest sense: with no provider
 * configured it does no network I/O at all and returns a zeroed summary with
 * `configured: false`. A provider that throws is recorded, not propagated —
 * "the provider is down" is a scan result, not a scan failure.
 */
async function runEnrichmentStep(
  conn: Conn,
  options: ScanOptions
): Promise<ScanEnrichmentSummary> {
  const env = options.env ?? process.env;
  const status = resolveProviderStatus(env, { keychain: options.keychain });
  const configured = status.enrichment.configured;
  const labels = status.enrichment.configuredProviders;

  if (!configured) {
    return { configured, providers: [], enriched: 0, progress: 0, skipped: 0, error: null };
  }
  // The operator turned enrichment off for this sweep (`--no-enrich`). It did
  // not take part, so it is reported as not configured rather than as a
  // configured run that happened to find nothing.
  if (options.enrich === false) {
    return { configured: false, providers: [], enriched: 0, progress: 0, skipped: 0, error: null };
  }

  const limit = options.enrichLimit ?? DEFAULT_ENRICH_LIMIT;
  try {
    const providers = await createEnrichmentProviders(env, { keychain: options.keychain });
    if (providers.length === 0) {
      return { configured, providers: labels, enriched: 0, progress: 0, skipped: 0, error: null };
    }

    const rows = await fetchContactsForEnrichment(conn, limit);
    if (rows.length === 0) {
      return { configured, providers: labels, enriched: 0, progress: 100, skipped: 0, error: null };
    }

    // The providers were constructed by core's provider registry (dynamic
    // import, so this module stays cheap for the provider-free case); cast
    // once at the boundary instead of widening the pipeline's public type.
    const pipeline = new EnrichmentPipeline(
      conn,
      providers as EnrichmentProvider[],
      options.scope
    );
    const result = await pipeline.enrichBatch(
      rows.map((r) => ({ id: r.id, fullName: r.fullName })),
      { force: false }
    );
    return {
      configured,
      providers: labels,
      enriched: typeof result?.enriched === "number" ? result.enriched : 0,
      progress: 100,
      skipped: Array.isArray(result?.skipped) ? result.skipped.length : 0,
      error: null,
    };
  } catch (error) {
    return {
      configured,
      providers: labels,
      enriched: 0,
      progress: 0,
      skipped: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function fetchContactsForEnrichment(
  conn: Conn,
  limit: number
): Promise<Array<{ id: string; fullName: string }>> {
  // Narrow on `dialect` so each branch sees a concrete connection type —
  // Drizzle's per-dialect query builders cannot be called on the union (the
  // same pattern as @netpro/core/src/import/pipeline.ts).
  if (conn.dialect === "sqlite") {
    const rows = await conn.db.select().from(conn.schema.contacts).limit(limit);
    return rows.map((r) => ({ id: r.id, fullName: r.fullName }));
  }
  const rows = await conn.db.select().from(conn.schema.contacts).limit(limit);
  return rows.map((r) => ({ id: r.id, fullName: r.fullName }));
}

/** Step 3 — graph analysis. Degrades to zeros; never throws. */
async function runGraphStep(conn: Conn, options: ScanOptions): Promise<ScanGraphSummary> {
  try {
    const g = await getNetworkGraph(conn, { scope: options.scope });
    return {
      nodes: g.nodes,
      edges: g.edges,
      pendingCandidates: g.pendingCandidates,
      communities: g.communities.count,
    };
  } catch {
    return { ...EMPTY_GRAPH };
  }
}

/**
 * The provider status at scan time — recorded on the result so the Web UI can
 * show "why was enrichment 0?" next to the numbers. Never fatal.
 */
function providersSnapshot(options: ScanOptions): ProviderStatusSnapshot | null {
  try {
    return resolveProviderStatus(options.env ?? process.env, { keychain: options.keychain });
  } catch {
    return null;
  }
}

/**
 * Run one scan: reindex → (optional) enrichment → graph analysis.
 *
 * The single implementation behind `POST /api/scan` and `netpro scan`. It is
 * deliberately free of jobs, events, and HTTP — callers wrap it in their own
 * job/event machinery, which is what lets the CLI and the Web UI drive the
 * identical sweep through the identical job model.
 */
export async function runScan(conn: Conn, options: ScanOptions = {}): Promise<ScanResult> {
  const now = options.now ?? (() => new Date());
  const source = options.source?.trim() || DEFAULT_SCAN_SOURCE;
  const emit = (stage: ScanStage, progress: number, message: string): void => {
    options.onProgress?.({ stage, progress, message });
  };

  const startedAt = now().toISOString();
  emit("queued", 0, "Scan queued");
  emit("discovering", 15, "Discovering contacts");

  // ── Step 1: reindex (processing → indexing) ─────────────────────────────
  emit("processing", 40, "Processing contacts");
  const index = await runIndexStep(conn, options);
  emit("processing", 70, `Indexed ${index.indexed} contact(s)`);

  // ── Step 2: enrichment (optional, external providers) ───────────────────
  const enrichment = await runEnrichmentStep(conn, options);
  emit(
    "enriching",
    enrichment.configured ? 90 : 70,
    enrichment.configured
      ? `Enriched ${enrichment.enriched} contact(s)`
      : "Enrichment skipped — no provider configured"
  );

  // ── Step 3: graph analysis ──────────────────────────────────────────────
  emit("indexing", 90, "Analyzing graph");
  const graph = await runGraphStep(conn, options);

  // Total contacts: prefer the graph's live count, fall back to the index.
  let total = graph.nodes;
  if (total === 0) {
    try {
      const status = await searchIndexStatus(conn, options.scope);
      total = status.contacts;
    } catch {
      total = index.scanned;
    }
  }

  const providers = providersSnapshot(options);

  const result: ScanResult = {
    source,
    processed: index.scanned || total,
    total,
    newContacts: index.indexed,
    updatedContacts: enrichment.enriched,
    relationships: graph.edges,
    relationshipsDiscovered: graph.pendingCandidates + graph.edges,
    communities: graph.communities,
    enrichment,
    index,
    graph,
    providers,
    startedAt,
    completedAt: now().toISOString(),
  };

  emit("completed", 100, "Scan complete");
  return result;
}
