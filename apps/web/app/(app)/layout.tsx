import Link from 'next/link';
import { auth, signOut } from '@/lib/auth';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();

  return (
    <div>
      <nav>
        <Link href="/dashboard">Dashboard</Link>
        <Link href="/search">Search</Link>
        <Link href="/outreach">Outreach</Link>
        <Link href="/contacts">Contacts</Link>
        <Link href="/import">Import</Link>
        <Link href="/settings">Settings</Link>
        {session?.user ? (
          <form
            action={async () => {
              'use server';
              await signOut();
            }}
          >
            <button type="submit">Sign out</button>
          </form>
        ) : null}
      </nav>
      <main>{children}</main>
    </div>
  );
}
