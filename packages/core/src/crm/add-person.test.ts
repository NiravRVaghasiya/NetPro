import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestSqliteConn } from '@netpro/db/src/testing';
import { addPersonFromLinkedIn, checkLinkedInImport, LINKEDIN_URL_SOURCE } from './add-person';
import { CrmError } from './types';

const NOW = new Date('2026-09-06T12:00:00Z');

let fixture: ReturnType<typeof createTestSqliteConn>;

beforeEach(() => {
  fixture = createTestSqliteConn();
});
afterEach(() => {
  fixture.sqlite.close();
});

function seedContact(id: string, fullName: string, extra: Record<string, unknown> = {}) {
  fixture.conn.db
    .insert(fixture.conn.schema.contacts)
    .values({
      id,
      fullName,
      source: 'test',
      workspaceId: 'default',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      ...extra,
    })
    .run();
}

describe('addPersonFromLinkedIn', () => {
  it('creates a contact from a bare profile URL with a humanized name', async () => {
    const result = await addPersonFromLinkedIn(
      fixture.conn,
      { linkedinUrl: 'https://www.linkedin.com/in/john-doe?trk=x' },
      undefined,
      { now: NOW },
    );
    expect(result.status).toBe('created');
    expect(result.contact.fullName).toBe('John Doe');
    expect(result.contact.linkedinUrl).toBe('https://www.linkedin.com/in/john-doe');
    expect(result.profile.usernameKey).toBe('john-doe');
  });

  it('prefers the caller-supplied name and normalizes scheme-less URLs', async () => {
    const result = await addPersonFromLinkedIn(
      fixture.conn,
      { linkedinUrl: 'linkedin.com/in/jane-doe/', fullName: '  Jane Q. Doe  ' },
      undefined,
      { now: NOW },
    );
    expect(result.status).toBe('created');
    expect(result.contact.fullName).toBe('Jane Q. Doe');
    expect(result.contact.linkedinUrl).toBe('https://www.linkedin.com/in/jane-doe');
  });

  it('tags the contact source as linkedin_url', async () => {
    const result = await addPersonFromLinkedIn(fixture.conn, {
      linkedinUrl: 'https://www.linkedin.com/in/john-doe',
    });
    const rows = fixture.conn.db
      .select()
      .from(fixture.conn.schema.contacts)
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe(LINKEDIN_URL_SOURCE);
    expect(rows[0]!.id).toBe(result.contact.id);
  });

  it('returns exists instead of duplicating across URL spellings', async () => {
    seedContact('c1', 'Jane Doe', { linkedinUrl: 'https://linkedin.com/in/jane-doe' });
    const result = await addPersonFromLinkedIn(fixture.conn, {
      linkedinUrl: 'https://www.linkedin.com/in/Jane-Doe/?trk=public#top',
    });
    expect(result.status).toBe('exists');
    expect(result.contact.id).toBe('c1');
    expect(result.contact.fullName).toBe('Jane Doe');
    const rows = fixture.conn.db.select().from(fixture.conn.schema.contacts).all();
    expect(rows).toHaveLength(1);
  });

  it('ignores soft-deleted contacts when detecting duplicates', async () => {
    seedContact('c1', 'Gone Person', {
      linkedinUrl: 'https://www.linkedin.com/in/jane-doe',
      deletedAt: NOW.toISOString(),
    });
    const result = await addPersonFromLinkedIn(fixture.conn, {
      linkedinUrl: 'https://www.linkedin.com/in/jane-doe',
    });
    expect(result.status).toBe('created');
    expect(result.contact.id).not.toBe('c1');
  });

  it('scopes duplicates to the workspace', async () => {
    seedContact('c1', 'Jane Doe', {
      linkedinUrl: 'https://www.linkedin.com/in/jane-doe',
      workspaceId: 'other',
    });
    const result = await addPersonFromLinkedIn(
      fixture.conn,
      { linkedinUrl: 'https://www.linkedin.com/in/jane-doe' },
      { workspaceId: 'default', role: 'owner', userId: 'u1' },
    );
    expect(result.status).toBe('created');
  });

  it.each([
    'not-a-url',
    'https://example.com/in/john-doe',
    'https://www.linkedin.com/company/example',
    'https://www.linkedin.com/in',
  ])('rejects %s with a human-readable CrmError', async (input) => {
    await expect(addPersonFromLinkedIn(fixture.conn, { linkedinUrl: input })).rejects.toThrow(
      CrmError,
    );
    await expect(
      addPersonFromLinkedIn(fixture.conn, { linkedinUrl: input }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    const rows = fixture.conn.db.select().from(fixture.conn.schema.contacts).all();
    expect(rows).toHaveLength(0);
  });

  it('rejects a blank or oversized name without writing', async () => {
    await expect(
      addPersonFromLinkedIn(fixture.conn, {
        linkedinUrl: 'https://www.linkedin.com/in/john-doe',
        fullName: '   ',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      addPersonFromLinkedIn(fixture.conn, {
        linkedinUrl: 'https://www.linkedin.com/in/john-doe',
        fullName: 'x'.repeat(201),
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    const rows = fixture.conn.db.select().from(fixture.conn.schema.contacts).all();
    expect(rows).toHaveLength(0);
  });
});

describe('checkLinkedInImport', () => {
  it('reports an unknown profile without writing', async () => {
    const check = await checkLinkedInImport(
      fixture.conn,
      'https://www.linkedin.com/in/john-doe/',
    );
    expect(check.existing).toBeNull();
    expect(check.profile.normalizedUrl).toBe('https://www.linkedin.com/in/john-doe');
    const rows = fixture.conn.db.select().from(fixture.conn.schema.contacts).all();
    expect(rows).toHaveLength(0);
  });

  it('reports the known contact for a duplicate', async () => {
    seedContact('c1', 'Jane Doe', { linkedinUrl: 'https://www.linkedin.com/in/jane-doe' });
    const check = await checkLinkedInImport(fixture.conn, 'linkedin.com/in/jane-doe');
    expect(check.existing).toMatchObject({ id: 'c1', fullName: 'Jane Doe' });
  });

  it('rejects invalid URLs with invalid_input', async () => {
    await expect(
      checkLinkedInImport(fixture.conn, 'https://www.linkedin.com/jobs/'),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});
