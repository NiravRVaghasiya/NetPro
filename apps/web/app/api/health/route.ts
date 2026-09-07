// apps/web/app/api/health/route.ts
//
// Public, unauthenticated readiness probe: Docker's HEALTHCHECK, a load
// balancer, and an uptime monitor all hit this. Phase 6 extends it from
// "can I reach the database" to "is this deployment actually serviceable",
// because a reachable-but-unmigrated database is the failure mode a deploy
// pipeline most needs to catch.
//
// It stays deliberately terse for anonymous callers: no version numbers,
// connection strings, or driver errors, all of which help an attacker
// fingerprint the instance. Diagnostic detail requires an owner session.
import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { appliedMigrationCount, pendingMigrationTotal } from '@netpro/db';
import { searchIndexStatus } from '@netpro/core/src/search';
import { conn } from '@/lib/db';
import { auth } from '@/lib/auth';
import { semanticSearchAvailable } from '@/lib/search-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Health = {
  status: 'healthy' | 'degraded' | 'unhealthy';
  dialect: string;
  latencyMs: number;
  timestamp: string;
  migrations?: { applied: number; expected: number };
  /**
   * Hybrid-search capability (v2.0 Phase 4). Owner-only, like `migrations`:
   * contact and index counts are inventory data, and even the bare mode
   * fingerprints how the instance is configured. Deploy smoke tests that need
   * it authenticate; the anonymous probe stays terse.
   */
  search?: {
    /** The best engine this deployment can actually serve. */
    mode: 'portable' | 'keyword' | 'hybrid';
    indexed: number;
    contacts: number;
    embedded: number;
  };
  error?: string;
};

/**
 * What can this deployment serve *today*? Not what was requested — what the
 * migrations, the index, and the configured key add up to.
 */
async function searchCapability(): Promise<Health['search'] | undefined> {
  try {
    const status = await searchIndexStatus(conn);
    const keyword = status.keywordIndexAvailable && status.indexed > 0;
    const hybrid = keyword && status.embedded > 0 && semanticSearchAvailable();
    return {
      mode: hybrid ? 'hybrid' : keyword ? 'keyword' : 'portable',
      indexed: status.indexed,
      contacts: status.contacts,
      embedded: status.embedded,
    };
  } catch {
    // An unmigrated or unreachable database is already reported elsewhere in
    // this handler; search capability just goes unreported.
    return undefined;
  }
}

export async function GET(request: Request): Promise<Response> {
  const start = Date.now();
  // Detailed output is owner-only; `auth()` failing must not take the probe
  // down, so treat any error as "not the owner".
  const url = new URL(request.url);
  const wantsDetail = url.searchParams.has('verbose');
  const isOwner = wantsDetail
    ? await auth()
        .then((session) => Boolean(session?.user?.id))
        .catch(() => false)
    : false;

  const respond = (body: Health, status: number) =>
    NextResponse.json(body, {
      status,
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });

  try {
    if (conn.dialect === 'sqlite') {
      conn.db.run(sql`SELECT 1`);
    } else {
      await conn.db.execute(sql`SELECT 1`);
    }

    // Schema readiness. A database that answers SELECT 1 but has no tables is
    // a deployment whose migration step did not run — reported as `degraded`
    // with a 503 so a rollout gate stops rather than sending users to a
    // crashing page.
    let migrations: Health['migrations'];
    try {
      const [applied, expected] = await Promise.all([
        appliedMigrationCount(conn),
        Promise.resolve(pendingMigrationTotal(conn.dialect)),
      ]);
      migrations = { applied, expected };
      if (applied < expected) {
        return respond(
          {
            status: 'degraded',
            dialect: conn.dialect,
            latencyMs: Date.now() - start,
            timestamp: new Date().toISOString(),
            ...(isOwner ? { migrations } : {}),
            error: 'Database migrations are not fully applied.',
          },
          503
        );
      }
    } catch {
      // No migrations table at all — the database has never been migrated.
      return respond(
        {
          status: 'degraded',
          dialect: conn.dialect,
          latencyMs: Date.now() - start,
          timestamp: new Date().toISOString(),
          error: 'Database schema is not initialized.',
        },
        503
      );
    }

    const search = isOwner ? await searchCapability() : undefined;

    return respond(
      {
        status: 'healthy',
        dialect: conn.dialect,
        latencyMs: Date.now() - start,
        timestamp: new Date().toISOString(),
        ...(isOwner ? { migrations } : {}),
        ...(search ? { search } : {}),
      },
      200
    );
  } catch (error) {
    // Driver errors can contain the host, database name, and credentials-
    // adjacent detail — never expose them to an anonymous caller.
    const message = error instanceof Error ? error.message : String(error);
    return respond(
      {
        status: 'unhealthy',
        dialect: conn.dialect,
        latencyMs: Date.now() - start,
        timestamp: new Date().toISOString(),
        error: isOwner ? message : 'Database is unavailable.',
      },
      503
    );
  }
}
