// Next.js instrumentation hook — runs once per server process at startup,
// before any request is handled. This is where pending Drizzle migrations
// are applied, because the Postgres migrator is async and can't run from
// module-scope `lib/db.ts` (a deliberate scaffold design kept as-is).
//
// IMPORTANT: Next.js evaluates instrumentation.ts in BOTH the nodejs and
// edge runtimes. The early return below keeps all node-only imports (node:fs,
// node:path, node:module, the Drizzle migrators, and @/lib/db which pulls in
// the better-sqlite3 native addon) out of the edge bundle — static imports of
// any of them here would crash the edge context. Same class of bug as the
// scaffold's middleware/better-sqlite3 incident (v0.1-alpha progress log,
// Task 11): always keep node-only code behind the runtime guard + dynamic
// import boundary.
//
// The migrations live in packages/db/migrations/<dialect> (committed,
// generated via `npm run db:generate:sqlite|postgres -w packages/db`),
// applied journal-based and idempotent — a no-op once applied.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const path = (await import('node:path')).default;
  const { existsSync } = await import('node:fs');
  const { createRequire } = await import('node:module');
  const { migrate: migrateSqlite } = await import('drizzle-orm/better-sqlite3/migrator');
  const { migrate: migratePg } = await import('drizzle-orm/node-postgres/migrator');
  const { conn } = await import('@/lib/db');

  // Locate the committed migrations folder. The package can't always be
  // resolved by spec from a Next-bundled context (Turbopack virtual paths),
  // so try a chain of candidates and pick the first that actually contains
  // the drizzle journal:
  //  1. spec-based resolution of @netpro/db (works under `next start`/node)
  //  2. cwd/node_modules (standalone Docker layout, cwd = /app)
  //  3. monorepo dev layout (cwd = apps/web -> ../../packages/db)
  const candidates: string[] = [];

  try {
    candidates.push(
      path.dirname(createRequire(import.meta.url).resolve('@netpro/db/package.json'))
    );
  } catch {
    // Not resolvable from this bundle context — fall through to cwd-based paths.
  }
  candidates.push(path.join(process.cwd(), 'node_modules', '@netpro/db'));
  candidates.push(path.resolve(process.cwd(), '..', '..', 'packages', 'db'));

  const folderName = conn.dialect === 'sqlite' ? 'sqlite' : 'postgres';
  let migrationsFolder: string | null = null;
  for (const dir of candidates) {
    const folder = path.join(dir, 'migrations', folderName);
    if (existsSync(path.join(folder, 'meta', '_journal.json'))) {
      migrationsFolder = folder;
      break;
    }
  }
  if (migrationsFolder === null) {
    throw new Error(
      `Could not locate @netpro/db migrations for "${folderName}" — tried: ${candidates.join(', ')}`
    );
  }

  if (conn.dialect === 'sqlite') {
    migrateSqlite(conn.db, { migrationsFolder });
  } else {
    await migratePg(conn.db, { migrationsFolder, schema: conn.schema });
  }
}
