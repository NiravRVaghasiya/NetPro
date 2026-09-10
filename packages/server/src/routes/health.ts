// packages/server/src/routes/health.ts
//
// Public readiness probe for the standalone NetPro server.
// Mirrors the web /api/health contract at a high level, without Auth.js:
// anonymous responses stay terse; `?verbose=1` adds migration/search detail
// when the local auth context trusts the caller (Phase 1: always on loopback).

import { sql } from 'drizzle-orm';
import {
  appliedMigrationCount,
  pendingMigrationTotal,
  type PgConn,
  type SqliteConn,
} from '@netpro/db';
import { searchIndexStatus } from '@netpro/core/src/search';
import type { AuthContext } from '../auth/index';
import { sendJson } from '../middleware/json';
import type { IncomingMessage, ServerResponse } from 'node:http';

export type HealthBody = {
  status: 'healthy' | 'degraded' | 'unhealthy';
  dialect: string;
  latencyMs: number;
  timestamp: string;
  migrations?: { applied: number; expected: number };
  search?: {
    mode: 'portable' | 'keyword' | 'hybrid';
    indexed: number;
    contacts: number;
    embedded: number;
  };
  error?: string;
};

export type HealthDeps = {
  conn: SqliteConn | PgConn;
  auth: AuthContext;
  /** Optional override for semantic-search availability (tests). */
  semanticSearchAvailable?: () => boolean;
};

async function searchCapability(
  conn: SqliteConn | PgConn,
  semanticSearchAvailable: () => boolean
): Promise<HealthBody['search'] | undefined> {
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
    return undefined;
  }
}

/**
 * Handle GET /api/health.
 */
export async function handleHealth(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HealthDeps
): Promise<void> {
  const start = Date.now();
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const wantsDetail = url.searchParams.has('verbose');
  const isOwner = wantsDetail && deps.auth.trustedLocal;
  const semantic = deps.semanticSearchAvailable ?? (() => false);

  const respond = (body: HealthBody, status: number) => sendJson(res, status, body);

  try {
    if (deps.conn.dialect === 'sqlite') {
      deps.conn.db.run(sql`SELECT 1`);
    } else {
      await deps.conn.db.execute(sql`SELECT 1`);
    }

    let migrations: HealthBody['migrations'];
    try {
      const [applied, expected] = await Promise.all([
        appliedMigrationCount(deps.conn),
        Promise.resolve(pendingMigrationTotal(deps.conn.dialect)),
      ]);
      migrations = { applied, expected };
      if (applied < expected) {
        respond(
          {
            status: 'degraded',
            dialect: deps.conn.dialect,
            latencyMs: Date.now() - start,
            timestamp: new Date().toISOString(),
            ...(isOwner ? { migrations } : {}),
            error: 'Database migrations are not fully applied.',
          },
          503
        );
        return;
      }
    } catch {
      respond(
        {
          status: 'degraded',
          dialect: deps.conn.dialect,
          latencyMs: Date.now() - start,
          timestamp: new Date().toISOString(),
          error: 'Database schema is not initialized.',
        },
        503
      );
      return;
    }

    const search = isOwner ? await searchCapability(deps.conn, semantic) : undefined;

    respond(
      {
        status: 'healthy',
        dialect: deps.conn.dialect,
        latencyMs: Date.now() - start,
        timestamp: new Date().toISOString(),
        ...(isOwner ? { migrations } : {}),
        ...(search ? { search } : {}),
      },
      200
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    respond(
      {
        status: 'unhealthy',
        dialect: deps.conn.dialect,
        latencyMs: Date.now() - start,
        timestamp: new Date().toISOString(),
        error: isOwner ? message : 'Database is unavailable.',
      },
      503
    );
  }
}
