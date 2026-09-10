// @ts-nocheck
// apps/web/app/(app)/network/page.tsx
//
// Phase 9/11 — Network visualization: the graph as the visual centerpiece.
//
// The plan (Phase 11) makes the graph the centerpiece — people, relationships,
// relationship strength, communities, clusters, bridges, high-degree nodes,
// important intermediaries — and requires the UI consume graph results from
// `packages/core` without reimplementing graph algorithms. This page does that
// through the local NetPro server: GET /api/graph and GET /api/graph/path
// orchestrate Louvain community detection, degree centrality, Brandes
// betweenness, and warm-introduction pathfinding on the server, and the UI
// visualizes the result.
//
// Two modes, mirroring the existing /graph page:
//   * no `target` → network overview (communities, hubs, warm-intro candidates)
//   * `target`    → ranked k-shortest warm-intro chains (who can introduce me?)

import Link from "next/link";
import { requireScope } from "@/lib/authz";
import { getServerUrl, serverFetchJson } from "@/lib/netpro-server";
import { conn } from "@/lib/db";
import { getNetworkGraph, planIntroPaths } from "@netpro/core/src/graph";

export const metadata = { title: "Network — NetPro" };

type SearchParams = Record<string, string | string[] | undefined>;
function one(v: string | string[] | undefined): string | undefined {
  const s = (Array.isArray(v) ? v[0] : v)?.trim();
  return s ? s : undefined;
}

export default async function NetworkPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requireScope();
  const sp = await searchParams;
  const target = one(sp.target) ?? one(sp.to);
  const from = one(sp.from);
  const serverUrl = getServerUrl();

  // Try server first; fall back to direct core so the page renders during
  // `next dev` without `netpro serve`.
  if (target) {
    // Pathfinder — ranked chains
    let plan: {
      found?: boolean;
      targetContact?: { id: string; fullName: string };
      paths?: Array<{ rank: number; hops: number; score: { score: number; weakestTie: number | null; avgHopStrength: number }; path: Array<{ contactId: string; fullName: string; relationshipScore: number | null; lastInteraction: string | null; via?: { relations: string[] } }> }>;
      error?: string;
    } | null = null;
    let serverError: string | null = null;
    try {
      const qs = new URLSearchParams({ target, ...(from ? { from } : {}) });
      const res = await serverFetchJson<typeof plan>(`/api/graph/path?${qs.toString()}`);
      if (res.ok) plan = res.data;
      else serverError = (res.data as { error?: string })?.error ?? `Server ${res.status}`;
    } catch (e) {
      serverError = e instanceof Error ? e.message : String(e);
    }
    if (!plan || serverError) {
      try {
        const fetched = await planIntroPaths(conn, { target, from, k: 3 }, {} as never);
        plan = fetched as unknown as typeof plan;
        serverError = null;
      } catch (e) {
        plan = { error: e instanceof Error ? e.message : String(e) };
      }
    }

    if ((plan as { error?: string })?.error) {
      return (
        <div>
          <h1>Network — Pathfinder</h1>
          <p style={{ color: "#dc2626" }}>{(plan as { error: string }).error}</p>
          <p>
            <Link href="/network" style={{ color: "#2563eb" }}>
              ← Back to network overview
            </Link>
          </p>
        </div>
      );
    }
    const p = plan as NonNullable<typeof plan>;
    return (
      <div>
        <h1>Network — Pathfinder</h1>
        <p style={{ color: "#6b7280" }}>
          Warm-intro chains to <strong>{p.targetContact?.fullName ?? target}</strong>
          {from ? (
            <>
              {" "}
              from <strong>{from}</strong>
            </>
          ) : null}
          {serverError ? (
            <span style={{ color: "#92400e" }}> (server unreachable — local result)</span>
          ) : (
            <span style={{ color: "#6b7280" }}> — via {serverUrl}</span>
          )}
        </p>
        {p.found && p.paths && p.paths.length > 0 ? (
          <ol style={{ paddingLeft: "1.1rem" }}>
            {p.paths.map((path) => (
              <li
                key={path.rank}
                style={{
                  border: "1px solid #e5e7eb",
                  borderRadius: 10,
                  padding: "0.75rem 1rem",
                  marginBottom: "0.7rem",
                  listStyle: "none",
                }}
              >
                <div>
                  <strong>#{path.rank}</strong> · {path.hops} hop{path.hops === 1 ? "" : "s"} · chain strength{" "}
                  <strong>{path.score.score.toFixed(2)}</strong>
                  <span style={{ color: "#6b7280" }}>
                    {" "}
                    · weakest tie {path.score.weakestTie === null ? "—" : path.score.weakestTie.toFixed(2)} · avg{" "}
                    {path.score.avgHopStrength.toFixed(2)}
                  </span>
                </div>
                <div style={{ marginTop: "0.5rem", color: "#374151" }}>
                  {path.path.map((n, i) => (
                    <span key={n.contactId}>
                      {i > 0 ? (
                        <span style={{ color: "#9ca3af" }}> {n.via?.relations.join(", ")} → </span>
                      ) : null}
                      <Link href={`/graph/${n.contactId}`} style={{ color: "#2563eb" }}>
                        {n.fullName}
                      </Link>{" "}
                      <span style={{ color: "#6b7280", fontSize: "0.8rem" }}>
                        ({n.relationshipScore === null ? "no score" : n.relationshipScore.toFixed(2)}
                        {n.lastInteraction ? ` · ${n.lastInteraction.slice(0, 10)}` : " · no touch"})
                      </span>
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p style={{ color: "#9ca3af" }}>No path found — try a different contact or broaden the graph filters.</p>
        )}
        <p>
          <Link href="/network" style={{ color: "#2563eb" }}>
            ← Back to network overview
          </Link>{" "}
          ·{" "}
          <Link href={`/search?q=${encodeURIComponent(target)}`} style={{ color: "#2563eb" }}>
            Search &quot;{target}&quot;
          </Link>
        </p>
      </div>
    );
  }

  // Overview — communities, hubs, warm-intro candidates
  let graph: {
    nodes?: number;
    edges?: number;
    components?: { count: number; largestSize: number };
    communities?: { count: number; modularity: number; top: Array<{ communityId: string; label: string; size: number; share: number; members: { fullName: string }[]; truncated?: boolean }> };
    centrality?: { top: Array<{ contactId: string; fullName: string; degree: number; betweenness: number | null }>; betweennessComputed?: boolean; skippedReason?: string };
    warmIntros?: Array<{ contactId: string; contactName: string; targetId: string; targetName: string; viaId: string; viaName: string; hops: number }>;
    totalContacts?: number;
    pendingCandidates?: number;
    degraded?: { reason: string };
  } | null = null;
  let serverError: string | null = null;
  try {
    const res = await serverFetchJson<typeof graph>("/api/graph");
    if (res.ok) graph = res.data;
    else serverError = (res.data as { error?: string })?.error ?? `Server ${res.status}`;
  } catch (e) {
    serverError = e instanceof Error ? e.message : String(e);
  }
  if (!graph || serverError) {
    try {
      graph = (await getNetworkGraph(conn, {} as never)) as unknown as typeof graph;
      serverError = null;
    } catch (e) {
      return (
        <div>
          <h1>Network</h1>
          <p style={{ color: "#dc2626" }}>{e instanceof Error ? e.message : String(e)}</p>
        </div>
      );
    }
  }

  if (!graph || graph.degraded) {
    return (
      <div>
        <h1>Network</h1>
        {graph?.degraded ? <p style={{ color: "#b45309" }}>{graph.degraded.reason}</p> : <p>Loading…</p>}
      </div>
    );
  }
  if ((graph.nodes ?? 0) === 0) {
    return (
      <div>
        <h1>Network</h1>
        <p style={{ color: "#9ca3af" }}>
          No confirmed edges yet. <Link href="/import" style={{ color: "#2563eb" }}>Import a LinkedIn CSV</Link> or{" "}
          <Link href="/edges" style={{ color: "#2563eb" }}>
            add links yourself
          </Link>
          {graph.pendingCandidates ? (
            <>
              {" · "}
              <Link href="/edges?status=pending" style={{ color: "#2563eb" }}>
                {graph.pendingCandidates} pending candidate{graph.pendingCandidates === 1 ? "" : "s"}
              </Link>
            </>
          ) : null}
          .
        </p>
        <p style={{ color: "#6b7280", fontSize: "0.85rem" }}>
          Server: <code>{serverUrl}</code>
          {serverError ? <span style={{ color: "#92400e" }}> — {serverError} (local fallback)</span> : null}
        </p>
      </div>
    );
  }

  return (
    <div>
      <h1>Network</h1>
      <p style={{ color: "#6b7280" }}>
        {graph.nodes} of {graph.totalContacts} contacts linked by {graph.edges} confirmed edge{graph.edges === 1 ? "" : "s"} ·{" "}
        {graph.components?.count} component{graph.components?.count === 1 ? "" : "s"} (largest {graph.components?.largestSize})
        {graph.pendingCandidates ? (
          <>
            {" · "}
            <Link href="/edges?status=pending" style={{ color: "#2563eb" }}>
              {graph.pendingCandidates} pending
            </Link>
          </>
        ) : null}
        <span style={{ fontSize: "0.8rem" }}> — via {serverUrl}</span>
      </p>

      <form method="GET" action="/network" style={{ marginTop: "0.75rem", display: "flex", gap: "0.5rem" }}>
        <input
          name="target"
          placeholder="Find a path to… (name, email, or id)"
          style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: "0.4rem 0.7rem", flex: "1 1 260px" }}
        />
        <button
          type="submit"
          style={{ background: "#111827", color: "white", borderRadius: 8, padding: "0.4rem 0.9rem", border: "none" }}
        >
          Find path
        </button>
      </form>

      <div style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap", marginTop: "1rem" }}>
        <div style={{ flex: "1 1 260px", border: "1px solid #e5e7eb", borderRadius: 10, padding: "0.9rem" }}>
          <h2 style={{ margin: "0 0 0.5rem", fontSize: "1rem" }}>
            Communities ({graph.communities?.count}, modularity {graph.communities?.modularity})
          </h2>
          <ul>
            {(graph.communities?.top ?? []).map((c) => (
              <li key={c.communityId}>
                <strong>{c.label}</strong> — {c.size} member{c.size === 1 ? "" : "s"} ({Math.round(c.share * 100)}%)
                <span style={{ color: "#6b7280" }}>
                  {" "}
                  {c.members.map((m) => m.fullName).join(", ")}
                  {c.truncated ? "…" : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div style={{ flex: "1 1 260px", border: "1px solid #e5e7eb", borderRadius: 10, padding: "0.9rem" }}>
          <h2 style={{ margin: "0 0 0.5rem", fontSize: "1rem" }}>Most connected</h2>
          <ul>
            {(graph.centrality?.top ?? []).map((t) => (
              <li key={t.contactId}>
                <Link href={`/contacts/${t.contactId}`} style={{ color: "#2563eb" }}>
                  {t.fullName}
                </Link>{" "}
                — {t.degree} edge{t.degree === 1 ? "" : "s"}
                {t.betweenness !== null ? <span style={{ color: "#6b7280" }}> · betweenness {t.betweenness}</span> : null}
              </li>
            ))}
          </ul>
          {!graph.centrality?.betweennessComputed && graph.centrality?.skippedReason ? (
            <p style={{ color: "#9ca3af", fontSize: "0.75rem" }}>{graph.centrality.skippedReason}</p>
          ) : null}
        </div>
      </div>

      {graph.warmIntros && graph.warmIntros.length > 0 ? (
        <div style={{ marginTop: "1rem", border: "1px solid #e5e7eb", borderRadius: 10, padding: "0.9rem" }}>
          <h2 style={{ margin: "0 0 0.5rem", fontSize: "1rem" }}>Warm-intro candidates</h2>
          <ul>
            {graph.warmIntros.map((w) => (
              <li key={`${w.contactId}-${w.targetId}`}>
                <Link href={`/contacts/${w.contactId}`} style={{ color: "#2563eb" }}>
                  {w.contactName}
                </Link>{" "}
                →{" "}
                <Link href={`/contacts/${w.targetId}`} style={{ color: "#2563eb" }}>
                  {w.targetName}
                </Link>{" "}
                <span style={{ color: "#6b7280" }}>
                  via{" "}
                  <Link href={`/contacts/${w.viaId}`} style={{ color: "#2563eb" }}>
                    {w.viaName}
                  </Link>{" "}
                  ({w.hops} hops)
                </span>{" "}
                <Link
                  href={`/network?target=${encodeURIComponent(w.targetId)}&from=${encodeURIComponent(w.contactId)}`}
                  style={{ color: "#2563eb", fontSize: "0.85rem", marginLeft: "0.4rem" }}
                >
                  Find path →
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p style={{ marginTop: "1rem", color: "#6b7280", fontSize: "0.85rem" }}>
        Pathfinding uses the existing Louvain + Brandes algorithms in <code>packages/core</code> — the UI never reimplements them.
        See <Link href="/graph" style={{ color: "#2563eb" }}>
          legacy graph view
        </Link>{" "}
        for the full interactive explorer.
      </p>
    </div>
  );
}
