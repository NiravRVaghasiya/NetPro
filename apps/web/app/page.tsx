// apps/web/app/page.tsx
//
// Phase 9 — the landing page is the on-ramp to the local-first observatory,
// not to a cloud deployment. It answers the three questions the plan names:
//
//   What is NetPro doing, what did it discover, and what can I do with it?
//
//   → "Your professional network. Private. Local. Searchable."
//   → A live Observatory (network size, jobs, activity).
//   → Import, search, warm-intro paths — all through the local server at
//     http://127.0.0.1:3777.
//
// The page is public (proxy.ts allows "/") and links into the authenticated
// app shell. The server's health endpoint is fetched client-side only if the
// caller wants a live dot — the static shell must not 500 when `netpro serve`
// is not running.

import Link from "next/link";

export default function LandingPage() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "3rem 1.25rem" }}>
      <h1 style={{ fontSize: "2rem", margin: 0, letterSpacing: "-0.02em" }}>
        NetPro
      </h1>
      <p style={{ color: "#6b7280", marginTop: "0.35rem", fontSize: "1.05rem" }}>
        Your professional network. Private. Local. Searchable.
      </p>

      <div
        style={{
          display: "flex",
          gap: "0.75rem",
          flexWrap: "wrap",
          marginTop: "1.25rem",
        }}
      >
        <Link
          href="/observatory"
          style={{
            background: "#111827",
            color: "white",
            borderRadius: 10,
            padding: "0.6rem 1rem",
            textDecoration: "none",
            fontWeight: 600,
          }}
        >
          Open Observatory →
        </Link>
        <Link
          href="/activity"
          style={{
            border: "1px solid #e5e7eb",
            color: "#111827",
            borderRadius: 10,
            padding: "0.6rem 1rem",
            textDecoration: "none",
            fontWeight: 500,
          }}
        >
          Live activity
        </Link>
        <Link
          href="/settings"
          style={{
            border: "1px solid #e5e7eb",
            color: "#374151",
            borderRadius: 10,
            padding: "0.6rem 1rem",
            textDecoration: "none",
          }}
        >
          Settings
        </Link>
      </div>

      <section
        style={{
          marginTop: "1.5rem",
          border: "1px solid #e5e7eb",
          borderRadius: 12,
          padding: "1rem",
          background: "white",
        }}
      >
        <h2 style={{ margin: "0 0 0.4rem", fontSize: "1rem" }}>Local-first</h2>
        <p style={{ color: "#6b7280", margin: 0, lineHeight: 1.6 }}>
          NetPro runs on this machine. The CLI, the local server at{" "}
          <code>http://127.0.0.1:3777</code>, and the Web UI are three interfaces to the same application. Your contacts, the
          graph, and the search index live in <code>~/.netpro/netpro.db</code> (SQLite) by default — no Vercel, no cloud
          database, no mandatory GitHub OAuth. PostgreSQL remains for Docker/self-hosted.
        </p>
        <ul style={{ margin: "0.75rem 0 0", paddingLeft: "1.2rem", color: "#374151", lineHeight: 1.6 }}>
          <li>
            <code>netpro init</code> — create <code>~/.netpro</code> and the local database
          </li>
          <li>
            <code>netpro serve</code> — start the API + event stream the UI observes
          </li>
          <li>
            <code>netpro import contacts.csv</code> / <Link href="/import" style={{ color: "#2563eb" }}>upload</Link> — same
            import pipeline, one job system
          </li>
          <li>
            <code>netpro search &quot;AI founders&quot;</code> ↔{" "}
            <Link href="/search" style={{ color: "#2563eb" }}>
              Search
            </Link>
          </li>
        </ul>
      </section>

      <section
        style={{
          marginTop: "1rem",
          display: "flex",
          gap: "0.75rem",
          flexWrap: "wrap",
        }}
      >
        <Link href="/network" style={{ flex: "1 1 180px", border: "1px solid #e5e7eb", borderRadius: 12, padding: "0.9rem", textDecoration: "none", color: "inherit", background: "white" }}>
          <strong>Network</strong>
          <div style={{ color: "#6b7280", fontSize: "0.9rem", marginTop: 4 }}>Communities, bridges, centrality — graph from core.</div>
        </Link>
        <Link href="/people" style={{ flex: "1 1 180px", border: "1px solid #e5e7eb", borderRadius: 12, padding: "0.9rem", textDecoration: "none", color: "inherit", background: "white" }}>
          <strong>People</strong>
          <div style={{ color: "#6b7280", fontSize: "0.9rem", marginTop: 4 }}>CRM, scored by relationship and recency.</div>
        </Link>
        <Link href="/search" style={{ flex: "1 1 180px", border: "1px solid #e5e7eb", borderRadius: 12, padding: "0.9rem", textDecoration: "none", color: "inherit", background: "white" }}>
          <strong>Search</strong>
          <div style={{ color: "#6b7280", fontSize: "0.9rem", marginTop: 4 }}>Hybrid (keyword + semantic) via the server.</div>
        </Link>
      </section>

      <p style={{ color: "#9ca3af", fontSize: "0.85rem", marginTop: "1.25rem" }}>
        NetPro is the application. The Web UI is its observatory, not its backend. Phase 9 foundation — Web UI talks to{" "}
        <code>http://127.0.0.1:3777</code> (or <code>NETPRO_SERVER_URL</code>) via the stable Web API + SSE.
      </p>
    </main>
  );
}
