/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, runMigrations, type SqliteConn } from '@netpro/db';
import { createApp } from './app';
import { startServer } from './server';
import type { AuthPolicy } from './auth/index';

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function scratchDb() {
  const dir = mkdtempSync(join(tmpdir(), 'netpro-contacts-post-'));
  dirs.push(dir);
  const path = join(dir, 'test.db');
  process.env.DB_DIALECT = 'sqlite';
  process.env.DB_PATH = path;
  const conn = createDb() as SqliteConn;
  return { conn, path, dir };
}

const LOCAL_POLICY: AuthPolicy = {
  mode: 'local',
  token: null,
  installation: { id: 'ins_test', createdAt: '2026-09-10T00:00:00.000Z' },
};

async function startedServer() {
  const { conn } = scratchDb();
  await runMigrations(conn);
  const app = await createApp({
    conn,
    skipMigrate: true,
    auth: LOCAL_POLICY,
    config: { host: '127.0.0.1', port: 0, autoMigrate: false, auth: { mode: 'local' } },
  });
  const running = await startServer(app, { port: 0 });
  return { running, conn };
}

async function postContacts(url: string, body: unknown) {
  const res = await fetch(`${url}/api/contacts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

describe('POST /api/contacts', () => {
  it('creates a person from a LinkedIn URL', async () => {
    const { running } = await startedServer();
    try {
      const { status, body } = await postContacts(running.url, {
        linkedinUrl: 'https://www.linkedin.com/in/john-doe?trk=x',
      });
      expect(status).toBe(201);
      expect(body.status).toBe('created');
      expect(body.contact.id).toBeTruthy();
      expect(body.contact.fullName).toBe('John Doe');
      expect(body.contact.linkedinUrl).toBe('https://www.linkedin.com/in/john-doe');
      expect(body.profile.normalizedUrl).toBe('https://www.linkedin.com/in/john-doe');

      // The new person is a real contact: timeline + list see them.
      const timeline = await fetch(`${running.url}/api/contacts/${body.contact.id}`);
      expect(timeline.status).toBe(200);
      const list = (await (await fetch(`${running.url}/api/contacts`)).json()) as any;
      expect(list.total).toBe(1);
    } finally {
      await running.close();
    }
  });

  it('prefers the supplied name', async () => {
    const { running } = await startedServer();
    try {
      const { status, body } = await postContacts(running.url, {
        linkedinUrl: 'linkedin.com/in/jane-doe',
        fullName: 'Jane Q. Doe',
      });
      expect(status).toBe(201);
      expect(body.contact.fullName).toBe('Jane Q. Doe');
    } finally {
      await running.close();
    }
  });

  it('returns the existing person instead of duplicating', async () => {
    const { running } = await startedServer();
    try {
      const first = await postContacts(running.url, {
        linkedinUrl: 'https://linkedin.com/in/jane-doe',
      });
      expect(first.status).toBe(201);
      const second = await postContacts(running.url, {
        linkedinUrl: 'https://www.linkedin.com/in/Jane-Doe/?trk=public',
      });
      expect(second.status).toBe(200);
      expect(second.body.status).toBe('exists');
      expect(second.body.contact.id).toBe(first.body.contact.id);
      const list = (await (await fetch(`${running.url}/api/contacts`)).json()) as any;
      expect(list.total).toBe(1);
    } finally {
      await running.close();
    }
  });

  it('dryRun validates and duplicate-checks without writing', async () => {
    const { running } = await startedServer();
    try {
      const unknown = await postContacts(running.url, {
        linkedinUrl: 'https://www.linkedin.com/in/john-doe/',
        dryRun: true,
      });
      expect(unknown.status).toBe(200);
      expect(unknown.body.exists).toBe(false);
      expect(unknown.body.profile.normalizedUrl).toBe('https://www.linkedin.com/in/john-doe');
      expect(unknown.body.contact).toBeNull();

      await postContacts(running.url, { linkedinUrl: 'https://www.linkedin.com/in/john-doe' });
      const known = await postContacts(running.url, {
        linkedinUrl: 'https://www.linkedin.com/in/john-doe',
        dryRun: true,
      });
      expect(known.body.exists).toBe(true);
      expect(known.body.contact.fullName).toBe('John Doe');

      const list = (await (await fetch(`${running.url}/api/contacts`)).json()) as any;
      expect(list.total).toBe(1);
    } finally {
      await running.close();
    }
  });

  it.each([
    ['not-a-url', "That doesn't look like a LinkedIn profile URL."],
    ['https://example.com/in/john-doe', "That doesn't look like a LinkedIn profile URL."],
    ['https://www.linkedin.com/company/example', "isn't a supported profile URL"],
    ['https://www.linkedin.com/jobs/', "isn't a supported profile URL"],
    ['', 'Paste a LinkedIn profile URL'],
  ])('rejects %s with a human-readable 400', async (linkedinUrl, snippet) => {
    const { running } = await startedServer();
    try {
      const { status, body } = await postContacts(running.url, { linkedinUrl });
      expect(status).toBe(400);
      expect(body.error).toContain(snippet);
      expect(body.code).toBe('invalid_input');
      const list = (await (await fetch(`${running.url}/api/contacts`)).json()) as any;
      expect(list.total).toBe(0);
    } finally {
      await running.close();
    }
  });

  it('rejects a missing body and a bad JSON body', async () => {
    const { running } = await startedServer();
    try {
      const empty = await fetch(`${running.url}/api/contacts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(empty.status).toBe(400);
      const bad = await fetch(`${running.url}/api/contacts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{oops',
      });
      expect(bad.status).toBe(400);
    } finally {
      await running.close();
    }
  });
});
