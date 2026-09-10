import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, signOut } from "@/lib/auth";
import { resolveWebAuthMode } from "@/lib/auth-mode";

// Phase 9 — Web UI foundation: the Web UI is the observatory, not the backend.
// The navigation answers "What is NetPro doing, what did it discover, and what
// can I do with it?" — not "How do I configure a cloud deployment?"
//
// Suggested navigation from the plan:
//
//   NetPro
//   ├── Observatory   (what is happening?)
//   ├── Network       (the graph, communities, bridges)
//   ├── Search        (hybrid search, why a result matched)
//   ├── People        (contacts / CRM)
//   ├── Activity      (live job + event stream — Phase 8 SSE)
//   └── Settings      (provider status, installation, team)
//
// Legacy routes (Dashboard, Contacts, Edges, Graph, Skills, Events, Content,
// Outreach, Import, ...) remain reachable at their original URLs until
// Phase 24 removes the duplicated business logic. They are grouped under
// "More" so the primary nav stays focused on the local-first story.

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  // Phase 5 — in `local`/`open` mode there is no Auth.js session to end, so
  // the sign-out control is only meaningful for GitHub sign-in.
  const mode = resolveWebAuthMode();

  // The route-group layout is the real gate — proxy.ts's PROTECTED_ROUTES
  // list is a fast path, not the source of truth. A page added under (app)/
  // without a matching middleware entry would otherwise render for anyone,
  // signed in or not.
  if (!session?.user) {
    redirect("/login");
  }

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
        <Link href="/settings">Settings</Link>
        <details className="ml-auto">
          <summary className="cursor-pointer text-slate-500 hover:text-slate-900">More</summary>
          <div
            style={{
              position: 'absolute',
              right: 16,
              marginTop: 8,
              background: 'white',
              border: '1px solid #e5e7eb',
              borderRadius: 10,
              padding: '0.6rem 0.9rem',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.4rem',
              boxShadow: '0 8px 24px rgba(0,0,0,0.08)',
              minWidth: 180,
              zIndex: 20,
            }}
          >
            <Link href="/dashboard">Dashboard</Link>
            <Link href="/contacts">Contacts</Link>
            <Link href="/edges">Edges</Link>
            <Link href="/graph">Graph</Link>
            <Link href="/skills">Skills</Link>
            <Link href="/events">Events</Link>
            <Link href="/content">Content</Link>
            <Link href="/import">Import</Link>
            <Link href="/outreach">Outreach</Link>
            <Link href="/outreach/campaigns">Campaigns</Link>
            <Link href="/settings/card">Profile card</Link>
            <Link href="/settings/team">Team</Link>
            <Link href="/settings/activity">Activity log</Link>
            <Link href="/settings/plugins">Plugins</Link>
            <Link href="/settings/webhooks">Webhooks</Link>
          </div>
        </details>
        {mode === "github" ? (
          <form
            action={async () => {
              "use server";
              await signOut();
            }}
          >
            <button type="submit">Sign out</button>
          </form>
        ) : (
          <span className="text-xs uppercase tracking-widest text-slate-400">
            {mode === "open" ? "Open mode" : "Local mode"}
          </span>
        )}
      </nav>
      <main className="px-5 py-4 sm:px-8">{children}</main>
    </div>
  );
}
