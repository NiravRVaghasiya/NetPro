import Link from "next/link";

// Phase 24 — the Web UI is a pure client of the local NetPro server.
//
// The plan's navigation (Phase 9), now the *only* navigation:
//
//   NetPro
//   ├── Observatory   (what is happening?)
//   ├── Network       (the graph, communities, bridges)
//   ├── Search        (hybrid search, why a result matched)
//   ├── Pathfinder    (who can introduce me?)
//   ├── People        (contacts / CRM)
//   ├── Activity      (live job + event stream — Phase 8 SSE)
//   ├── Scan          (scan visualization)
//   └── Settings      (provider status, installation identity)
//
// Phase 24 removed the legacy Auth.js flows and the legacy pages that were
// grouped under "More" (Dashboard, Contacts, Edges, Graph, Skills, Events,
// Content, Outreach, Import-v1, Invite, profile card, team, plugins,
// webhooks). There is no session here: authentication and authorization are
// the server's job (`netpro serve` — loopback/token/open). A page renders the
// same shell whether the server is up or not; its data fetches simply fail
// (or show a banner) when the server is unreachable.

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div>
      <nav
        aria-label="Main navigation"
        className="flex flex-wrap items-center gap-x-5 gap-y-3 border-b border-slate-200 px-5 py-4 text-sm sm:px-8"
      >
        <Link href="/observatory" className="font-semibold tracking-tight text-slate-900">
          NetPro
        </Link>
        <span aria-hidden className="text-slate-300">
          ·
        </span>
        <Link href="/observatory">Observatory</Link>
        <Link href="/network">Network</Link>
        <Link href="/search">Search</Link>
        <Link href="/pathfinder">Pathfinder</Link>
        <Link href="/people">People</Link>
        <Link href="/activity">Activity</Link>
        <Link href="/scan">Scan</Link>
        <Link href="/settings">Settings</Link>
        <span className="ml-auto text-xs uppercase tracking-widest text-slate-400">
          Local · server {":3777"}
        </span>
      </nav>
      <main className="px-5 py-4 sm:px-8">{children}</main>
    </div>
  );
}
