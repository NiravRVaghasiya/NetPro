// packages/core/src/workspaces/scope-guard.ts
// v3.0 Phase 2 — scope-guard test helper.
//
// The tenancy rule is enforced in the core, so the test that proves it lives
// in the core too: build a fixture containing *two* workspaces with separate
// members and data, then assert that every query run under workspace A's scope
// returns nothing from workspace B (and vice versa). This is the template the
// live-Postgres job mirrors per dialect; the SQLite test here is the hermetic
// first pass.

import { createTestSqliteConn } from '@netpro/db/src/testing';
import type { SqliteConn } from '@netpro/db';
import { BOOTSTRAP_WORKSPACE_ID } from './scope';
import type { WorkspaceRole, WorkspaceScope } from './types';

export interface TwoWorkspaceFixture {
  /** The two isolated workspace ids. `a` is the bootstrap/default workspace. */
  workspaceA: string;
  workspaceB: string;
  /** The principal scopes for a member of each workspace. */
  scopeA: WorkspaceScope;
  scopeB: WorkspaceScope;
  conn: SqliteConn;
  close: () => void;
}

/**
 * Seed the bootstrap `default` workspace (already created by the migrations),
 * a second workspace, and one member in each. Rows are left to the caller so a
 * specific module can seed the data its scope-guard test needs.
 */
export function createTwoWorkspaceFixture(): TwoWorkspaceFixture {
  const fixture = createTestSqliteConn();
  const conn = fixture.conn;
  const now = new Date().toISOString();

  const wsA = BOOTSTRAP_WORKSPACE_ID;
  const wsB = 'acme';

  // The migration created the `default` workspace; create the second one and
  // both members synchronously (a test fixture, not a runtime path).
  conn.db
    .insert(conn.schema.workspaces)
    .values({ id: wsB, name: 'Acme', slug: wsB, createdAt: now })
    .run();
  conn.db
    .insert(conn.schema.users)
    .values({ id: 'user-a', email: 'a@example.com', name: 'Alice' })
    .run();
  conn.db
    .insert(conn.schema.users)
    .values({ id: 'user-b', email: 'b@example.com', name: 'Bob' })
    .run();
  conn.db
    .insert(conn.schema.workspaceMembers)
    .values({ id: 'm-a', workspaceId: wsA, userId: 'user-a', role: 'owner' as WorkspaceRole, createdAt: now })
    .run();
  conn.db
    .insert(conn.schema.workspaceMembers)
    .values({ id: 'm-b', workspaceId: wsB, userId: 'user-b', role: 'owner' as WorkspaceRole, createdAt: now })
    .run();

  return {
    workspaceA: wsA,
    workspaceB: wsB,
    scopeA: { workspaceId: wsA, role: 'owner', userId: 'user-a' },
    scopeB: { workspaceId: wsB, role: 'owner', userId: 'user-b' },
    conn,
    close: () => fixture.sqlite.close(),
  };
}

/**
 * Insert a contact into a specific workspace. Thin wrapper so the caller can
 * seed either side of the fixture without reaching into Drizzle every time.
 */
export function seedWorkspaceContact(
  fixture: Pick<TwoWorkspaceFixture, 'conn'>,
  workspaceId: string,
  id: string,
  fullName: string,
): void {
  const now = new Date().toISOString();
  fixture.conn.db
    .insert(fixture.conn.schema.contacts)
    .values({
      id,
      fullName,
      email: `${id}@example.com`,
      company: 'Seed Co',
      source: 'test',
      workspaceId,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}
