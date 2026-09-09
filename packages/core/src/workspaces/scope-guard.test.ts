// packages/core/src/workspaces/scope-guard.test.ts
// v3.0 Phase 2 — prove the CRM module's exported queries are workspace-scoped.
//
// Two workspaces are seeded with distinct contacts/interactions/follow-ups; every
// CRM query is run under workspace B's scope and asserted to return nothing from
// workspace A (and the reverse). This is the hermetic SQLite pass of the
// cross-tenant guard; the live-Postgres job mirrors it per dialect.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTwoWorkspaceFixture, seedWorkspaceContact, type TwoWorkspaceFixture } from './scope-guard';
import { listCrmContacts } from '../crm/contacts';
import { getContactTimeline } from '../crm/timeline';
import { listInteractions, logInteraction, countInteractions, getContactStats } from '../crm/interactions';
import { listFollowUps, createFollowUp } from '../crm/follow-ups';
import { getContactById, resolveContactRef } from '../ai/resolve-contact';

const NOW = new Date('2026-09-06T12:00:00Z');

let f: TwoWorkspaceFixture;

beforeEach(() => {
  f = createTwoWorkspaceFixture();
  // Contacts live in separate workspaces to prove isolation.
  seedWorkspaceContact(f, f.workspaceA, 'a-contact', 'Alice Alpha');
  seedWorkspaceContact(f, f.workspaceB, 'b-contact', 'Bob Beta');
});

afterEach(() => {
  f.close();
});

describe('CRM workspace scope-guard (Phase 2)', () => {
  it('listCrmContacts returns only the scoped workspace', async () => {
    const aPage = await listCrmContacts(f.conn, { limit: 50 }, f.scopeA);
    expect(aPage.contacts.map((c) => c.id)).toEqual(['a-contact']);

    const bPage = await listCrmContacts(f.conn, { limit: 50 }, f.scopeB);
    expect(bPage.contacts.map((c) => c.id)).toEqual(['b-contact']);
  });

  it('getContactById cannot read another workspace', async () => {
    expect(await getContactById(f.conn, 'a-contact')).not.toBeNull();
    expect(await getContactById(f.conn, 'a-contact', f.scopeB)).toBeNull();
    expect(await getContactById(f.conn, 'b-contact', f.scopeA)).toBeNull();
  });

  it('resolveContactRef resolves only within the scoped workspace', async () => {
    expect((await resolveContactRef(f.conn, 'a-contact@example.com', f.scopeA)).id).toBe('a-contact');
    await expect(resolveContactRef(f.conn, 'a-contact@example.com', f.scopeB)).rejects.toThrow(/No contact matches/);
    await expect(resolveContactRef(f.conn, 'b-contact@example.com', f.scopeA)).rejects.toThrow(/No contact matches/);
  });

  it('logInteraction scopes the row and its recomputed stats', async () => {
    const result = await logInteraction(
      f.conn,
      { contactId: 'a-contact', type: 'note', content: 'pinged' },
      { now: NOW },
      f.scopeA,
    );
    expect(result.interaction.workspaceId).toBe(f.workspaceA);
    expect(result.interaction.createdByUser).toBe('user-a');
    // The recomputed stats must be visible only to workspace A.
    expect(await getContactStats(f.conn, 'a-contact', f.scopeA)).not.toBeNull();
    expect(await getContactStats(f.conn, 'a-contact', f.scopeB)).toBeNull();
    expect(await countInteractions(f.conn, undefined, f.scopeB)).toBe(0);
    expect(await countInteractions(f.conn, undefined, f.scopeA)).toBe(1);
  });

  it('listInteractions and getContactTimeline respect the scope', async () => {
    await logInteraction(f.conn, { contactId: 'a-contact', type: 'note', content: 'pinged' }, { now: NOW }, f.scopeA);

    const aInteractions = await listInteractions(f.conn, {}, f.scopeA);
    expect(aInteractions.map((i) => i.contactId)).toEqual(['a-contact']);
    const bInteractions = await listInteractions(f.conn, {}, f.scopeB);
    expect(bInteractions).toHaveLength(0);

    const aTimeline = await getContactTimeline(f.conn, 'a-contact', {}, f.scopeA);
    expect(aTimeline?.interactions).toHaveLength(1);
    const bTimeline = await getContactTimeline(f.conn, 'a-contact', {}, f.scopeB);
    expect(bTimeline).toBeNull();
  });

  it('createFollowUp and listFollowUps are workspace-scoped', async () => {
    const row = await createFollowUp(
      f.conn,
      { contactId: 'a-contact', dueInMs: 86_400_000, reason: 'call back' },
      { now: NOW },
      f.scopeA,
    );
    expect(row.createdByUser).toBe('user-a');

    const aPending = await listFollowUps(f.conn, { view: 'pending' }, f.scopeA);
    // The row returned in the summary may not carry workspaceId (it is joined
    // from follow_ups), so assert it is reachable in A and unreachable in B.
    expect(aPending.followUps.some((x) => x.id === row.id)).toBe(true);
    const bPending = await listFollowUps(f.conn, { view: 'pending' }, f.scopeB);
    expect(bPending.followUps.some((x) => x.id === row.id)).toBe(false);
  });

  it('un-scoped calls resolve to the bootstrap workspace (compatibility)', async () => {
    // With no scope, the query is constrained to the bootstrap workspace, so a
    // contact in the non-default workspace is not visible.
    const page = await listCrmContacts(f.conn, { limit: 50 });
    expect(page.contacts.map((c) => c.id)).toEqual(['a-contact']);
  });
});
