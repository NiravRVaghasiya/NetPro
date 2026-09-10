// @ts-nocheck
// apps/web/app/(app)/observatory/page.tsx
//
// Phase 10 — Observatory: the primary dashboard.
// From the plan:
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
// so the operator is not blocked. Dependency rule preserved:
// packages/core → CLI/Server → Web UI.

import Link from "next/link";
import { requireScope } from "@/lib/authz";
import { ObservatoryGrid, type ObservatoryStats } from "@/components/observatory";
import { ActivityFeed } from "@/components/activity-feed";
import { getServerUrl, serverFetchJson } from "@/lib/netpro-server";
import { conn } from "@/lib/db";
import { getNetworkOverview } from "@netpro/core/src/analytics";

export const metadata = { title: "Observatory — NetPro" };

type JobRow = {
  id: string;
  type: string;
  status: string;
  progress: number;
  startedAt?: string | null;
  completedAt?: string | null;
  updatedAt?: string | null;
  metadata?: Record<string, unknown>;
};

export default async function ObservatoryPage() {
  await requireScope();
  const serverUrl = getServerUrl();

  let serverReachable = false;
  let serverStats: ObservatoryStats | null = null;
  let serverError: string | null = null;

  try {
    const health = await serverFetchJson<{ status: string }>("/api/health");
    if (health.ok) serverReachable = true;

    if (serverReachable) {
      const [analyticsRes, graphRes, jobsRes, providersRes, healthDetailRes] = await Promise.all([
        serverFetchJson<{
          metrics?: { totalContacts?: number };
          graph?: {
            nodes?: number;
            edges?: number;
            components?: { count?: number; largestSize?: number };
            communities?: { count?: number; modularity?: number };
            coverage?: number;
            pendingCandidates?: number;
            degraded?: { reason: string } | null;
            avgPathLength?: { value: number | null };
          };
          generatedAt?: string;
        }>("/api/analytics"),
        serverFetchJson<{
          nodes?: number;
          edges?: number;
          components?: { count?: number; largestSize?: number };
          communities?: { count?: number; modularity?: number };
          coverage?: number;
          pendingCandidates?: number;
          degraded?: { reason: string } | null;
          avgPathLength?: { value: number | null };
          generatedAt?: string;
        }>("/api/graph"),
        serverFetchJson<{ jobs: JobRow[]; total: number }>("/api/jobs?limit=25"),
        serverFetchJson<{
          enrichment?: { configured: boolean; hunter: boolean; pdl: boolean; clearbit: boolean };
          ai?: { configured: boolean };
          embeddings?: { configured: boolean };
          search?: { indexContacts?: number | null };
        }>("/api/providers"),
        serverFetchJson<{ status?: string }>("/api/health"),
      ]);

      const analytics = analyticsRes.ok ? analyticsRes.data : null;
      const graph = graphRes.ok ? graphRes.data : null;
      const jobsData = jobsRes.ok ? jobsRes.data : null;
      const providers = providersRes.ok ? providersRes.data : null;

      // Last scan: most recent scan job (running > queued > completed)
      let lastScan: ObservatoryStats["lastScan"] = null;
      if (jobsData?.jobs?.length) {
        const scans = jobsData.jobs.filter((j) => j.type === "scan");
        const byRecency = [...jobsData.jobs].sort((a, b) => {
          const at = (a.completedAt ?? a.updatedAt ?? a.startedAt ?? "") as string;
          const bt = (b.completedAt ?? b.updatedAt ?? b.startedAt ?? "") as string;
          return at < bt ? 1 : at > bt ? -1 : 0;
        });
        const target = scans.length > 0 ? scans.sort((a, b) => ((b.updatedAt ?? "") < (a.updatedAt ?? "") ? -1 : 1))[0] ?? null : null;
        // fallback to most recent scan, or most recent job if no scans
        const pick = target ?? byRecency.find((j) => j.type === "scan") ?? byRecency.find((j) => j.type === "import") ?? null;
        if (pick) {
          lastScan = {
            id: pick.id,
            status: pick.status,
            progress: pick.progress ?? 0,
            completedAt: (pick.completedAt as string) ?? null,
            updatedAt: (pick.updatedAt as string) ?? (pick.completedAt as string) ?? null,
          };
        }
      }

      const metricsContacts =
        (analytics as { metrics?: { totalContacts?: number } } | null)?.metrics?.totalContacts ??
        (graph as { nodes?: number } | null)?.nodes ??
        0;

      const rel = (graph as { edges?: number } | null)?.edges;
      const commCount =
        (graph as { communities?: { count?: number } } | null)?.communities?.count ??
        (analytics as { graph?: { communities?: { count?: number } } } | null)?.graph?.communities?.count;
      const modularity =
        (graph as { communities?: { modularity?: number } } | null)?.communities?.modularity ??
        (analytics as { graph?: { communities?: { modularity?: number } } } | null)?.graph?.communities?.modularity;

      const graphBlock = graph
        ? {
            nodes: graph.nodes ?? 0,
            edges: graph.edges ?? 0,
            components: graph.components?.count ?? 0,
            largestComponent: graph.components?.largestSize,
            coverage: (graph as { coverage?: number }).coverage ?? (analytics as { graph?: { coverage?: number } })?.graph?.coverage,
            avgPathLength: graph.avgPathLength?.value ?? null,
            degraded: graph.degraded ?? null,
            pendingCandidates: graph.pendingCandidates,
          }
        : analytics?.graph
          ? {
              nodes: (analytics.graph as { nodes?: number }).nodes ?? 0,
              edges: (analytics.graph as { edges?: number }).edges ?? 0,
              components: (analytics.graph as { components?: { count?: number } }).components?.count ?? 0,
              largestComponent: (analytics.graph as { components?: { largestSize?: number } }).components?.largestSize,
              coverage: (analytics.graph as { coverage?: number }).coverage,
              avgPathLength: (analytics.graph as { avgPathLength?: { value?: number | null } }).avgPathLength?.value ?? null,
              degraded: (analytics.graph as { degraded?: { reason: string } | null }).degraded ?? null,
              pendingCandidates: (analytics.graph as { pendingCandidates?: number }).pendingCandidates,
            }
          : undefined;

      serverStats = {
        contacts: metricsContacts,
        relationships: rel,
        communities: commCount,
        modularity,
        jobs: jobsData
          ? {
              total: jobsData.total,
              running: jobsData.jobs.filter((j) => j.status === "running").length,
              queued: jobsData.jobs.filter((j) => j.status === "queued").length,
              list: jobsData.jobs as unknown as ObservatoryStats["jobs"]["list"],
            }
          : undefined,
        graph: graphBlock,
        lastScan,
        enrichment: providers?.enrichment as ObservatoryStats["enrichment"],
        ai: providers?.ai as ObservatoryStats["ai"],
        embeddings: providers?.embeddings as ObservatoryStats["embeddings"],
        indexContacts: providers?.search?.indexContacts ?? undefined,
        generatedAt: (analytics as { generatedAt?: string })?.generatedAt ?? (graph as { generatedAt?: string })?.generatedAt,
      };
    }
  } catch (e) {
    serverError = e instanceof Error ? e.message : String(e);
    serverReachable = false;
  }

  let fallbackStats: ObservatoryStats | null = null;
  if (!serverStats) {
    try {
      const overview = await getNetworkOverview(conn, {});
      fallbackStats = {
        contacts: overview.metrics.totalContacts,
        relationships: (overview.graph as { edges?: number } | undefined)?.edges,
        communities: (overview.graph as { communities?: { count?: number } } | undefined)?.communities?.count,
        modularity: (overview.graph as { communities?: { modularity?: number } } | undefined)?.communities?.modularity,
        graph: overview.graph
          ? {
              nodes: (overview.graph as { nodes: number }).nodes,
              edges: (overview.graph as { edges: number }).edges,
              components: (overview.graph as { components: { count: number } }).components.count,
              largestComponent: (overview.graph as { components: { largestSize: number } }).components.largestSize,
              coverage: (overview.graph as { coverage?: number }).coverage,
              avgPathLength: (overview.graph as { avgPathLength?: { value: number | null } }).avgPathLength?.value ?? null,
              degraded: (overview.graph as { degraded?: { reason: string } | null }).degraded ?? null,
              pendingCandidates: (overview.graph as { pendingCandidates?: number }).pendingCandidates,
            }
          : undefined,
        jobs: { total: 0, running: 0, queued: 0, list: [] },
        lastScan: null,
        enrichment: { configured: false, hunter: false, pdl: false, clearbit: false },
        ai: { configured: false },
        embeddings: { configured: false },
        indexContacts: overview.metrics.totalContacts,
        generatedAt: overview.generatedAt,
      };
    } catch {
      fallbackStats = { contacts: 0 };
    }
  }

  const stats = serverStats ?? fallbackStats ?? { contacts: 0 };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: "0.75rem", flexWrap: "wrap" }}>
        <h1 style={{ margin: 0, letterSpacing: "-0.02em" }}>Observatory</h1>
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

      <p style={{ color: "#6b7280", marginTop: "0.35rem", fontSize: "0.9rem" }}>
        NetPro is the application. The Web UI is its observatory, not its backend. Server: <code>{serverUrl}</code>
        {serverError ? <span style={{ color: "#dc2626" }}> — {serverError}</span> : null}
      </p>

      <section style={{ marginTop: "1.15rem" }}>
        <ObservatoryGrid stats={stats} serverUrl={serverUrl} serverReachable={serverReachable} />
      </section>

      <section style={{ marginTop: "1.15rem", display: "flex", gap: "1rem", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 460px", border: "1px solid #e5e7eb", borderRadius: 12, padding: "1rem", background: "white" }}>
          <h2 style={{ margin: "0 0 0.6rem", fontSize: "1rem" }}>Current activity — live</h2>
          <p style={{ color: "#6b7280", fontSize: "0.83rem", marginTop: 0 }}>
            Imports, scans, enrichments, searches, and relationship discoveries appear here instantly whether triggered from the Web UI
            or the CLI (<code>netpro scan</code>).
          </p>
          <ActivityFeed serverUrl={serverUrl} maxItems={12} />
          <div style={{ marginTop: "0.75rem", display: "flex", gap: "0.6rem", flexWrap: "wrap", alignItems: "center" }}>
            <Link
              href="/activity"
              style={{ color: "#2563eb", fontSize: "0.84rem", border: "1px solid #dbeafe", background: "#eff6ff", borderRadius: 999, padding: "0.3rem 0.7rem", textDecoration: "none" }}
            >
              Open full Activity →
            </Link>
            <span style={{ fontSize: "0.8rem", color: "#6b7280" }}>SSE: <code>GET /api/events</code> — see Phase 8</span>
          </div>
        </div>
        <div style={{ flex: "1 1 300px", border: "1px solid #e5e7eb", borderRadius: 12, padding: "1rem", background: "white" }}>
          <h2 style={{ margin: "0 0 0.6rem", fontSize: "1rem" }}>Recent discoveries</h2>
          <p style={{ color: "#6b7280", fontSize: "0.83rem", marginTop: 0 }}>
            What NetPro found — new relationships, enriched contacts, communities, and pathfinder candidates. The same events feed the
            Activity page and the Network graph.
          </p>
          <ul style={{ margin: "0.6rem 0 0", paddingLeft: "1.05rem", fontSize: "0.9rem", color: "#374151", lineHeight: 1.6 }}>
            <li>
              <Link href="/network" style={{ color: "#2563eb" }}>
                Network
              </Link>{" "}
              — communities, bridges, hubs, warm intros (Phase 11).
            </li>
            <li>
              <Link href="/people" style={{ color: "#2563eb" }}>
                People
              </Link>{" "}
              — your CRM, scored by relationship.
            </li>
            <li>
              <Link href="/search" style={{ color: "#2563eb" }}>
                Search
              </Link>{" "}
              — hybrid (keyword + semantic) via <code>/api/search</code>.
            </li>
            <li>
              <Link href="/pathfinder" style={{ color: "#2563eb" }}>
                Pathfinder
              </Link>{" "}
              — who can introduce me to whom (ranked chains).
            </li>
          </ul>
          <div style={{ marginTop: "0.85rem", display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
            <Link
              href="/import"
              style={{ fontSize: "0.85rem", background: "#111827", color: "white", borderRadius: 8, padding: "0.42rem 0.75rem", textDecoration: "none" }}
            >
              Import CSV
            </Link>
            <Link
              href="/settings"
              style={{ fontSize: "0.85rem", border: "1px solid #e5e7eb", borderRadius: 8, padding: "0.42rem 0.75rem", textDecoration: "none", color: "#374151", background: "white" }}
            >
              Provider status
            </Link>
            <Link href="/network" style={{ fontSize: "0.85rem", color: "#2563eb", padding: "0.42rem 0", textDecoration: "none" }}>
              Network →
            </Link>
          </div>
        </div>
      </section>

      <section style={{ marginTop: "1.15rem", border: "1px solid #e5e7eb", borderRadius: 12, padding: "1rem", background: "white" }}>
        <h2 style={{ margin: "0 0 0.4rem", fontSize: "1rem" }}>How NetPro fits together</h2>
        <p style={{ color: "#6b7280", fontSize: "0.88rem", margin: 0, lineHeight: 1.6 }}>
          <code>packages/core</code> is the business logic (Louvain, Brandes, hybrid search, growth).{" "}
          <code>packages/server</code> is HTTP/API/jobs/SSE/auth/config (<code>GET /api/graph</code>, <code>/api/providers</code>,{" "}
          <code>/api/events</code>). <code>apps/web</code> is the observatory — it visualizes <code>core</code>{" "}
          <em>through</em> the server: one operation, one job system, one event stream, multiple interfaces (CLI, Web UI). See{" "}
          <code>netpro-local-first-implementation-plan.md</code> Phases 9–11.{" "}
          <Link href="/network" style={{ color: "#2563eb" }}>
            Network visualization →
          </Link>
        </p>
      </section>
    </div>
  );
}
