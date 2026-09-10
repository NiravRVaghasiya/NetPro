// @ts-nocheck
// apps/web/app/(app)/observatory/page.tsx
//
// Phase 9/10 — Observatory: the primary dashboard.
//
// From the plan (Phase 10):
//   Show: Network size, Relationships, Communities, Recent activity, Current
//   jobs, Last scan, Enrichment status, Index status, Graph status.
//
// This page is the Web UI's answer to "What is NetPro doing, what did it
// discover, and what can I do with it?" It fetches from the local NetPro
// server (http://127.0.0.1:3777) via @/lib/netpro-server — never by
// duplicating `packages/core` logic in React.
//
// When the server is not running (e.g. `next dev` without `netpro serve`),
// the page degrades to a banner and still renders via the direct DB fallback
// so the operator is not blocked. The new observatory never becomes the
// application's business-logic layer again.

import Link from "next/link";
import { requireScope } from "@/lib/authz";
import { ObservatoryGrid, type ObservatoryStats } from "@/components/observatory";
import { ActivityFeed } from "@/components/activity-feed";
import { getServerUrl, serverFetchJson } from "@/lib/netpro-server";
import { conn } from "@/lib/db";
import { getNetworkOverview } from "@netpro/core/src/analytics";

export const metadata = { title: "Observatory — NetPro" };

export default async function ObservatoryPage() {
  await requireScope();
  const serverUrl = getServerUrl();

  // Try the server first — this is the local-first path (Web UI → Server → Core).
  let serverReachable = false;
  let serverStats: ObservatoryStats | null = null;
  let serverError: string | null = null;

  try {
    // Health probe is the cheap "is anyone home?" before the heavier analytics.
    const health = await serverFetchJson<{ status: string }>("/api/health");
    if (health.ok) serverReachable = true;

    if (serverReachable) {
      // Parallelize the observatory's data pulls — each is a separate API the
      // plan defines (Phase 6: GET /api/analytics, /api/graph, /api/jobs).
      const [analyticsRes, graphRes, jobsRes, settingsRes] = await Promise.all([
        serverFetchJson<{
          metrics?: { totalContacts?: number };
          graph?: { nodes?: number; edges?: number; components?: { count?: number }; communities?: { count?: number } };
          growth?: { series?: unknown[] };
        }>("/api/analytics"),
        serverFetchJson<{
          nodes?: number;
          edges?: number;
          components?: { count?: number };
          communities?: { count?: number };
        }>("/api/graph"),
        serverFetchJson<{ jobs: { status: string }[]; total: number }>("/api/jobs?limit=20"),
        serverFetchJson<{ auth?: unknown; version?: string }>("/api/settings"),
      ]);

      const analytics = analyticsRes.ok ? analyticsRes.data : null;
      const graph = graphRes.ok ? graphRes.data : null;
      const jobsData = jobsRes.ok ? jobsRes.data : null;

      serverStats = {
        contacts: (analytics as { metrics?: { totalContacts?: number } } | null)?.metrics?.totalContacts ??
          (graph as { nodes?: number } | null)?.nodes ??
          0,
        relationships: (graph as { edges?: number } | null)?.edges,
        communities: (graph as { communities?: { count?: number } } | null)?.communities?.count ??
          (analytics as { graph?: { communities?: { count?: number } } } | null)?.graph?.communities?.count,
        jobs: jobsData
          ? {
              total: jobsData.total,
              running: jobsData.jobs.filter((j) => j.status === "running").length,
              queued: jobsData.jobs.filter((j) => j.status === "queued").length,
            }
          : undefined,
        graph: graph
          ? {
              nodes: graph.nodes ?? 0,
              edges: graph.edges ?? 0,
              components: graph.components?.count ?? 0,
            }
          : undefined,
        enrichmentConfigured: undefined, // shown via Settings strip when server is reachable
      };
    }
  } catch (e) {
    serverError = e instanceof Error ? e.message : String(e);
    serverReachable = false;
  }

  // Fallback — direct core (Phase 10's dashboard heritage) so the page never
  // 500s just because `netpro serve` is not running.
  let fallbackStats: ObservatoryStats | null = null;
  if (!serverStats) {
    try {
      const overview = await getNetworkOverview(conn, {});
      fallbackStats = {
        contacts: overview.metrics.totalContacts,
        relationships: (overview.graph as { edges?: number } | undefined)?.edges,
        communities: (overview.graph as { communities?: { count?: number } } | undefined)?.communities?.count,
        graph: overview.graph
          ? {
              nodes: (overview.graph as { nodes: number }).nodes,
              edges: (overview.graph as { edges: number }).edges,
              components: (overview.graph as { components: { count: number } }).components.count,
            }
          : undefined,
        jobs: { total: 0, running: 0, queued: 0 },
      };
    } catch {
      fallbackStats = { contacts: 0 };
    }
  }

  const stats = serverStats ?? fallbackStats ?? { contacts: 0 };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: "0.75rem", flexWrap: "wrap" }}>
        <h1 style={{ margin: 0 }}>Observatory</h1>
        <span style={{ color: "#6b7280", fontSize: "0.9rem" }}>Your professional network — private, local, searchable.</span>
        <Link
          href="/activity"
          style={{
            marginLeft: "auto",
            fontSize: "0.85rem",
            color: "#2563eb",
            border: "1px solid #dbeafe",
            background: "#eff6ff",
            borderRadius: 999,
            padding: "0.3rem 0.8rem",
            textDecoration: "none",
          }}
        >
          View activity →
        </Link>
      </div>

      <p style={{ color: "#6b7280", marginTop: "0.35rem" }}>
        NetPro is the application. The Web UI is its observatory, not its backend. Server: <code>{serverUrl}</code>
        {serverError ? <span style={{ color: "#dc2626" }}> — {serverError}</span> : null}
      </p>

      <section style={{ marginTop: "1.25rem" }}>
        <ObservatoryGrid stats={stats} serverUrl={serverUrl} serverReachable={serverReachable} />
      </section>

      <section style={{ marginTop: "1.5rem", display: "flex", gap: "1.25rem", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 420px", border: "1px solid #e5e7eb", borderRadius: 12, padding: "1rem", background: "white" }}>
          <h2 style={{ margin: "0 0 0.6rem", fontSize: "1rem" }}>Current activity</h2>
          <p style={{ color: "#6b7280", fontSize: "0.85rem", marginTop: 0 }}>
            Live from the server&apos;s event stream (SSE). Imports, scans, searches, and relationship discoveries appear here
            whether you triggered them from the Web UI or the CLI.
          </p>
          <ActivityFeed serverUrl={serverUrl} maxItems={12} />
          <div style={{ marginTop: "0.75rem" }}>
            <Link href="/activity" style={{ color: "#2563eb", fontSize: "0.85rem" }}>
              Open full Activity →
            </Link>
          </div>
        </div>
        <div style={{ flex: "1 1 300px", border: "1px solid #e5e7eb", borderRadius: 12, padding: "1rem", background: "white" }}>
          <h2 style={{ margin: "0 0 0.6rem", fontSize: "1rem" }}>Recent discoveries</h2>
          <p style={{ color: "#6b7280", fontSize: "0.85rem", marginTop: 0 }}>
            What NetPro found — new relationships, enriched contacts, graph communities. Full history lives in the graph and search
            indexes.
          </p>
          <ul style={{ margin: "0.5rem 0 0", paddingLeft: "1.1rem", fontSize: "0.9rem", color: "#374151" }}>
            <li>
              <Link href="/network" style={{ color: "#2563eb" }}>
                Network
              </Link>{" "}
              — communities, bridges, centrality.
            </li>
            <li>
              <Link href="/people" style={{ color: "#2563eb" }}>
                People
              </Link>{" "}
              — your contacts, scored by relationship.
            </li>
            <li>
              <Link href="/search" style={{ color: "#2563eb" }}>
                Search
              </Link>{" "}
              — hybrid (keyword + semantic) via the server.
            </li>
          </ul>
          <div style={{ marginTop: "0.75rem", display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
            <Link
              href="/import"
              style={{
                fontSize: "0.85rem",
                background: "#111827",
                color: "white",
                borderRadius: 8,
                padding: "0.4rem 0.75rem",
                textDecoration: "none",
              }}
            >
              Import CSV
            </Link>
            <Link
              href="/settings"
              style={{
                fontSize: "0.85rem",
                border: "1px solid #e5e7eb",
                borderRadius: 8,
                padding: "0.4rem 0.75rem",
                textDecoration: "none",
                color: "#374151",
                background: "white",
              }}
            >
              Provider status
            </Link>
          </div>
        </div>
      </section>

      <section style={{ marginTop: "1.5rem", border: "1px solid #e5e7eb", borderRadius: 12, padding: "1rem", background: "white" }}>
        <h2 style={{ margin: "0 0 0.4rem", fontSize: "1rem" }}>How NetPro fits together</h2>
        <p style={{ color: "#6b7280", fontSize: "0.9rem", margin: 0 }}>
          <code>packages/core</code> is the business logic. <code>packages/server</code> is HTTP / jobs / SSE / auth.{" "}
          <code>apps/web</code> is the observatory that visualizes <code>core</code> <em>through</em> the server — one operation,
          one job system, one event stream, multiple interfaces (CLI, Web UI). See <code>netpro-local-first-implementation-plan.md</code>{" "}
          Phase 9.
        </p>
      </section>
    </div>
  );
}
