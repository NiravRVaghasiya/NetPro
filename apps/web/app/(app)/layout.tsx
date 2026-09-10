import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, signOut } from "@/lib/auth";
import { resolveWebAuthMode } from "@/lib/auth-mode";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  // Phase 5 — in `local`/`open` mode there is no Auth.js session to end, so
  // the sign-out control is only meaningful for GitHub sign-in.
  const mode = resolveWebAuthMode();

  // The route-group layout is the real gate — middleware.ts's PROTECTED_ROUTES
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
        <Link href="/dashboard">Dashboard</Link>
        <Link href="/search">Search</Link>
        <Link href="/outreach">Outreach</Link>
        <Link href="/outreach/campaigns">Campaigns</Link>
        <Link href="/contacts">Contacts</Link>
        <Link href="/edges">Edges</Link>
        <Link href="/graph">Graph</Link>
        <Link href="/skills">Skills</Link>
        <Link href="/events">Events</Link>
        <Link href="/content">Content</Link>
        <Link href="/import">Import</Link>
        <Link href="/settings/card">Profile card</Link>
        <Link href="/settings">Settings</Link>
        <Link href="/settings/team">Team</Link>
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
