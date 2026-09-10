// apps/web/app/(app)/scan/page.tsx
//
// Phase 14 — Scan Visualization. "Make scanning understandable."
//
// This page is a client of the local NetPro server: it reads the most recent
// scan job (GET /api/jobs?type=scan) so the view is meaningful even before
// the SSE connects, then hands off to <ScanPanel>, which:
//
//   * triggers POST /api/scan (the same `scan` job the CLI drives),
//   * visualizes the plan's SCAN mockup — Source, Progress, Processed X/Y,
//     New contacts, Updated contacts, Relationships discovered, Enrichment —
//   * and updates live through the SSE event stream (scan.progress,
//     enrichment.*, graph.updated) so a terminal `netpro scan` shows up here
//     without a refresh.
//
// No scan business logic lives in the Web UI — the server route orchestrates
// @netpro/core (reindex + enrichment + graph analysis) and this page only
// renders the job's result snapshot.

import Link from "next/link";
import { requireScope } from "@/lib/authz";
import { getServerUrl, serverFetchJson } from "@/lib/netpro-server";
import { ScanPanel, type ScanJob, type ScanResult } from "@/components/scan-panel";
import { ActivityFeed } from "@/components/activity-feed";
import {
  ProviderStatus,
  type ProviderStatusPayload,
} from "@/components/provider-status";

export const metadata = { title: "Scan — NetPro" };

type ScanJobRow = ScanJob & {
  started_at?: string | null;
  completed_at?: string | null;
};

export default async function ScanPage() {
  await requireScope();
  const serverUrl = getServerUrl();

  let reachable = false;
  let latestJob: ScanJob | null = null;
  let latestResult: ScanResult | null = null;
  let enrichmentConfigured = false;
  let providers: ProviderStatusPayload | null = null;

  try {
    const [jobsRes, providersRes] = await Promise.all([
      serverFetchJson<{ jobs: ScanJobRow[]; total: number }>("/api/jobs?type=scan&limit=5"),
      serverFetchJson<ProviderStatusPayload & { enrichment?: { configured?: boolean } }>(
        "/api/providers",
      ),
    ]);

    if (jobsRes.ok) {
      reachable = true;
      const jobs = jobsRes.data.jobs ?? [];
      // Prefer a live scan; otherwise the most recently updated one.
      const pick =
        jobs.find((j) => j.status === "running" || j.status === "queued") ??
        jobs.sort((a, b) => {
          const at = a.completed_at ?? a.started_at ?? "";
          const bt = b.completed_at ?? b.started_at ?? "";
          return at < bt ? 1 : at > bt ? -1 : 0;
        })[0] ??
        null;

      if (pick) {
        latestJob = {
          id: pick.id,
          type: pick.type,
          status: pick.status,
          progress: pick.progress,
          startedAt: pick.startedAt ?? pick.started_at ?? null,
          completedAt: pick.completedAt ?? pick.completed_at ?? null,
          metadata: pick.metadata ?? {},
        };
        const meta = pick.metadata ?? {};
        if (meta.result && typeof meta.result === "object") {
          latestResult = meta.result as unknown as ScanResult;
        }
      }
    }

    if (providersRes.ok) {
      enrichmentConfigured = Boolean(providersRes.data?.enrichment?.configured);
      providers = providersRes.data ?? null;
    }
  } catch {
    reachable = false;
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: "0.75rem", flexWrap: "wrap" }}>
        <h1 style={{ margin: 0 }}>Scan</h1>
        <span style={{ color: "#6b7280", fontSize: "0.9rem" }}>
          Reindex + enrichment + graph analysis, in one observable sweep.
        </span>
        <Link href="/activity" style={{ marginLeft: "auto", fontSize: "0.85rem", color: "#2563eb" }}>
          View activity →
        </Link>
      </div>

      <p style={{ color: "#6b7280", marginTop: "0.35rem", fontSize: "0.9rem" }}>
        The scan runs in the NetPro server (<code>{serverUrl}</code>) — the Web UI only visualizes it. Progress arrives live over{" "}
        <code>GET /api/events</code> (SSE), whether the scan started here or from <code>netpro scan</code> in a terminal.
      </p>

      {!reachable ? (
        <div style={{ background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e", borderRadius: 10, padding: "0.6rem 0.9rem", marginTop: "0.85rem" }}>
          NetPro server not reachable at <code>{serverUrl}</code> — run <code>netpro serve</code> to scan and watch progress live.
        </div>
      ) : null}

      <section style={{ marginTop: "1.15rem" }}>
        <ScanPanel
          serverUrl={serverUrl}
          initialJob={latestJob}
          initialResult={latestResult}
          enrichmentConfigured={enrichmentConfigured}
        />
      </section>

      <section style={{ marginTop: "1.5rem" }}>
        {/* Phase 17 — providers are optional: a scan enriches when they are
            configured and skips enrichment when they are not. Same sweep. */}
        <ProviderStatus status={providers} title="Providers" showDetails={false} />
      </section>

      <section style={{ marginTop: "1.5rem", border: "1px solid #e5e7eb", borderRadius: 12, padding: "1rem", background: "white" }}>
        <h2 style={{ margin: "0 0 0.6rem", fontSize: "1rem" }}>Scan activity — live</h2>
        <p style={{ color: "#6b7280", fontSize: "0.85rem", marginTop: 0 }}>
          <code>scan.started</code>, <code>scan.progress</code>, <code>enrichment.*</code>, <code>graph.updated</code>, and{" "}
          <code>job.*</code> events from this scan — including a CLI-triggered <code>netpro scan</code>.
        </p>
        <ActivityFeed serverUrl={serverUrl} types={["scan", "enrichment", "graph", "job"]} maxItems={60} />
      </section>
    </div>
  );
}
