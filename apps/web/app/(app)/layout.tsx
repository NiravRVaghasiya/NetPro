import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth, signOut } from '@/lib/auth';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();

  // The route-group layout is the real gate — middleware.ts's PROTECTED_ROUTES
  // list is a fast path, not the source of truth. A page added under (app)/
  // without a matching middleware entry would otherwise render for anyone,
  // signed in or not.
  if (!session?.user) {
    redirect('/login');
  }

  return (
    <div>
      <nav>
        <Link href="/dashboard">Dashboard</Link>
        <Link href="/search">Search</Link>
        <Link href="/outreach">Outreach</Link>
        <Link href="/contacts">Contacts</Link>
        <Link href="/import">Import</Link>
        <Link href="/settings">Settings</Link>
        <form
          action={async () => {
            'use server';
            await signOut();
          }}
        >
          <button type="submit">Sign out</button>
        </form>
      </nav>
      <main>{children}</main>
    </div>
  );
}
